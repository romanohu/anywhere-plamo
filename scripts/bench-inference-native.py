"""Benchmark the Android C++ inference path on Linux using the existing CPU runtime build."""
import argparse
import hashlib
import json
import platform
import runpy
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RUNTIME = runpy.run_path(str(ROOT / 'scripts/build-runtime.py'))

RUNNER = r'''
#include <chrono>
#include <fstream>
#include <iostream>
#include <iomanip>
#include <sys/resource.h>
#include PLAMO_TRANSLATION_SOURCE
using Clock = std::chrono::steady_clock;
struct Output { std::string text; Clock::time_point started; double first = -1; };
static bool cancelled_bench(void *) { return false; }
static bool emitted_bench(const char * bytes, size_t count, void * ptr) {
    auto & output = *static_cast<Output *>(ptr);
    if (output.first < 0) output.first = std::chrono::duration<double, std::milli>(Clock::now() - output.started).count();
    output.text.append(bytes, count);
    return true;
}
int main(int argc, char ** argv) {
    if (argc != 4) return 1;
    auto start = Clock::now();
    void * engine = plamo_load(argv[1], cancelled_bench, nullptr);
    if (!engine) return 2;
    std::cout << std::chrono::duration<double, std::milli>(Clock::now() - start).count() << '\n';
    std::ifstream input(argv[2], std::ios::binary);
    std::string prompt;
    int index = 0;
    while (std::getline(input, prompt, '\0')) {
        Output output;
        output.started = Clock::now();
        int result = plamo_translate(engine, prompt.data(), prompt.size(), emitted_bench, cancelled_bench, &output);
        double elapsed = std::chrono::duration<double, std::milli>(Clock::now() - output.started).count();
        rusage usage{};
        getrusage(RUSAGE_SELF, &usage);
        std::ofstream file(std::string(argv[3]) + '-' + std::to_string(index) + ".txt");
        file << output.text;
        std::cout << index++ << ' ' << plamo_tokens(engine, prompt.data(), prompt.size()) << ' '
                  << std::fixed << std::setprecision(2) << output.first << ' ' << elapsed << ' '
                  << usage.ru_maxrss << ' ' << result << '\n' << std::flush;
        if (result != 0) return 3;
    }
    plamo_free(engine);
}
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', type=Path, required=True)
    parser.add_argument('--source', type=Path, default=ROOT / 'src-tauri/src/translation.cpp',
                        help='Use a saved older translation.cpp for a before/after comparison.')
    parser.add_argument('--runtime-build', type=Path, default=ROOT / '.runtime-build/build-cpu')
    parser.add_argument('--runs', type=int, default=3)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if platform.system() != 'Linux' or args.runs < 1:
        parser.error('Run on Linux with at least one repetition.')
    cases = json.loads((ROOT / 'tests/translation-cases.json').read_text())
    sequence = []
    for run in range(args.runs):
        for case in cases:
            sequence.append({**case, 'run': run + 1})
            if case['id'] == 'short':
                sequence.append({**case, 'id': 'short-repeat', 'run': run + 1})
    with tempfile.TemporaryDirectory(prefix='plamo-inference-') as directory:
        work = Path(directory)
        runner = work / 'runner.cpp'
        runner.write_text(RUNNER)
        build = args.runtime_build.resolve()
        source = RUNTIME['SOURCE']
        libraries = [build / 'src/libllama.a'] + [build / f'ggml/src/lib{name}.a'
                                                 for name in ['ggml', 'ggml-cpu', 'ggml-base']]
        subprocess.run(['c++', '-std=c++17', '-O3', '-pthread',
                        f'-DPLAMO_TRANSLATION_SOURCE="{args.source.resolve()}"',
                        '-I' + str(source / 'include'), '-I' + str(source / 'ggml/include'),
                        str(runner), *map(str, libraries), '-ldl', '-lm', '-o', str(work / 'bench')], check=True)
        prompts = [f"<|plamo:tag|>dataset<|plamo:msg|>translation<|plamo:tag|>input<|plamo:msg|>{case['text']}"
                   f"<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>{case['target']}<|plamo:msg|>"
                   for case in sequence]
        (work / 'input').write_bytes(b'\0'.join(prompt.encode() for prompt in prompts) + b'\0')
        output = subprocess.check_output([str(work / 'bench'), str(args.model.resolve()),
                                          str(work / 'input'), str(work / 'output')], text=True).splitlines()
        results = []
        for case, line in zip(sequence, output[1:], strict=True):
            index, tokens, first, total, peak, status = line.split()
            if status != '0':
                raise RuntimeError(f'Incomplete translation: {case["id"]}')
            results.append({**case, 'input_tokens': int(tokens), 'first_token_ms': float(first),
                            'total_ms': float(total), 'peak_rss_mib': int(peak) / 1024,
                            'translation': (work / f'output-{index}.txt').read_text()})
        report = {'platform': platform.platform(), 'model': args.model.name,
                  'llama_revision': RUNTIME['REVISION'],
                  'source_sha256': hashlib.sha256(args.source.read_bytes()).hexdigest(),
                  'note': 'Linux CPU execution of the Android native path; not Android device/UI timing. '
                          'Exact-result cache bypassed, OS file cache not cleared. Run comparisons without other heavy work.',
                  'load_ms': float(output[0]), 'results': results}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(f'{len(results)} translations; peak RSS {max(row["peak_rss_mib"] for row in results):.1f} MiB')


if __name__ == '__main__':
    main()
