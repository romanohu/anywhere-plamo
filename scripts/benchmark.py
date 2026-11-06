"""Measure real translation latency and save outputs for quality review (no GUI required)."""
import argparse
import json
import os
import platform
import socket
import subprocess
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', type=Path, required=True)
    parser.add_argument('--server', type=Path, default=ROOT / 'src-tauri/resources/runtime/llama-server')
    parser.add_argument('--threads', type=int,
                        help='Generation threads; omitted uses the runtime default. Use 8 to measure the app limit on larger CPUs.')
    parser.add_argument('--threads-batch', type=int)
    parser.add_argument('--device', help='llama.cpp device name, or none for CPU only')
    parser.add_argument('--runs', type=int, default=2)
    parser.add_argument('--case', action='append', dest='cases', help='Case ID from tests/translation-cases.json; repeat to select several')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    if not args.model.is_file() or not args.server.is_file():
        parser.error('Both --model and --server must point to existing files.')
    if args.runs < 1 or any(n is not None and n < 1 for n in (args.threads, args.threads_batch)):
        parser.error('Runs and thread counts must be positive.')
    cases = json.loads((ROOT / 'tests/translation-cases.json').read_text())
    if args.cases:
        if set(args.cases) - {case['id'] for case in cases}:
            parser.error('Unknown case ID.')
        cases = [case for case in cases if case['id'] in args.cases]
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    key = uuid.uuid4().hex
    url = f'http://127.0.0.1:{port}'
    http = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def request(path, body=None, timeout=120):
        return http.open(urllib.request.Request(
            url + path, data=None if body is None else json.dumps(body).encode(),
            headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {key}'},
        ), timeout=timeout)

    command = [str(args.server.resolve()), '--model', str(args.model.resolve()),
               '--host', '127.0.0.1', '--port', str(port), '--api-key', key,
               '--alias', 'plamo-3-translate', '--ctx-size', '8192', '--parallel', '1',
               '--no-warmup', '--log-disable']
    for flag, value in [('--threads', args.threads), ('--threads-batch', args.threads_batch), ('--device', args.device)]:
        if value is not None:
            command += [flag, str(value)]
    report = {
        'platform': platform.platform(), 'logical_cpus': os.cpu_count(),
        'runtime': subprocess.check_output([str(args.server.resolve()), '--version'], stderr=subprocess.STDOUT, text=True).strip(),
        'threads': args.threads if args.threads is not None else os.environ.get('LLAMA_ARG_THREADS'),
        'threads_batch': args.threads_batch, 'device': args.device,
        'note': 'Fresh server process; OS file cache is not cleared. Latency excludes desktop UI and selection capture. Fixed review samples only.',
        'results': [],
    }
    started = time.perf_counter()
    child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        while True:
            if child.poll() is not None:
                raise RuntimeError('Translation engine exited before becoming ready.')
            if time.perf_counter() - started > 120:
                raise TimeoutError('Model loading exceeded 120 seconds.')
            try:
                with request('/health', timeout=2):
                    break
            except (urllib.error.URLError, TimeoutError):
                time.sleep(0.05)
        report['load_ms'] = round((time.perf_counter() - started) * 1000, 1)
        print(f"Model ready: {report['load_ms']} ms", flush=True)
        for run in range(args.runs):
            for case in cases:
                prompt = (f"<|plamo:tag|>dataset<|plamo:msg|>translation"
                          f"<|plamo:tag|>input<|plamo:msg|>{case['text']}"
                          f"<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>{case['target']}<|plamo:msg|>")
                began = time.perf_counter()
                with request('/tokenize', {'content': prompt, 'add_special': True, 'parse_special': True}) as response:
                    count = len(json.load(response)['tokens'])
                if count > 4096:
                    raise ValueError('Benchmark cases must fit in one translation request.')
                tokenize_ms = (time.perf_counter() - began) * 1000
                first_ms, finish_reason, output = None, None, ''
                with request('/v1/completions', {
                    'model': 'plamo-3-translate', 'prompt': prompt, 'temperature': 0,
                    'max_tokens': 8192 - count, 'stream': True, 'cache_prompt': False,
                    'stop': ['<|plamo:tag|>', '<|plamo:bos|>'],
                }) as response:
                    for line in response:
                        if not line.startswith(b'data: '):
                            continue
                        data = line[6:].strip()
                        if data == b'[DONE]':
                            break
                        event = json.loads(data)
                        if 'error' in event:
                            raise RuntimeError(event['error'])
                        for choice in event.get('choices', []):
                            token = choice.get('text', '')
                            if token and first_ms is None:
                                first_ms = (time.perf_counter() - began) * 1000
                            output += token
                            if choice.get('finish_reason'):
                                finish_reason = choice['finish_reason']
                if not output.strip() or finish_reason is None:
                    raise RuntimeError('Translation stream ended without a completed result.')
                result = {**case, 'run': run + 1, 'input_tokens': count,
                          'tokenize_ms': round(tokenize_ms, 1), 'first_token_ms': round(first_ms, 1),
                          'total_ms': round((time.perf_counter() - began) * 1000, 1),
                          'finish_reason': finish_reason, 'translation': output}
                report['results'].append(result)
                print(f"{case['id']} #{run + 1}: first {result['first_token_ms']} ms / total {result['total_ms']} ms ({finish_reason})", flush=True)
    finally:
        try:
            status = Path(f'/proc/{child.pid}/status')
            for line in status.read_text().splitlines():
                if line.startswith('VmHWM:'):
                    report['peak_rss_mib'] = round(int(line.split()[1]) / 1024, 1)
        except OSError:
            pass  # Optional Linux measurement; always stop the child, including after failure.
        child.terminate()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    if not args.output:
        print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
