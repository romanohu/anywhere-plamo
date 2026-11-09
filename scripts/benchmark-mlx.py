"""Compare a local MLX model on macOS/Linux with benchmark.py's cases/prompt.

Run in a separate environment with mlx-lm and the model's tokenizer dependencies.
This does not change the application's model or download model files.
"""
import argparse
import importlib.metadata
import json
import os
import platform
import resource
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--runs', type=int, default=2)
    parser.add_argument('--case', action='append', dest='cases')
    parser.add_argument('--device', choices=('cpu', 'gpu'))
    parser.add_argument('--cpu-float32', action='store_true',
                        help='Use FP32 arithmetic on CPU; keep quantized weights packed at their original bit width.')
    parser.add_argument('--trust-tokenizer-code', action='store_true',
                        help='Allow the custom Python tokenizer in the reviewed local model directory.')
    args = parser.parse_args()
    if not args.model.is_dir() or args.runs < 1:
        parser.error('A local model directory and a positive run count are required.')
    if args.cpu_float32 and args.device == 'gpu':
        parser.error('--cpu-float32 cannot be combined with --device gpu.')
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['TRANSFORMERS_OFFLINE'] = '1'
    import mlx.core as mx
    from mlx_lm import load, stream_generate
    from mlx_lm.sample_utils import make_sampler

    if args.cpu_float32:
        mx.set_default_device(mx.cpu)
    elif args.device:
        mx.set_default_device(mx.cpu if args.device == 'cpu' else mx.gpu)
    cases = json.loads((ROOT / 'tests/translation-cases.json').read_text(encoding='utf-8'))
    if args.cases:
        if set(args.cases) - {case['id'] for case in cases}:
            parser.error('Unknown case ID.')
        cases = [case for case in cases if case['id'] in args.cases]
    started = time.perf_counter()
    model, tokenizer = load(str(args.model.resolve()), tokenizer_config={
        'trust_remote_code': args.trust_tokenizer_code, 'local_files_only': True,
    })
    if args.cpu_float32:
        model.set_dtype(mx.float32)
        mx.eval(model.parameters())
    report = {
        'platform': platform.platform(), 'logical_cpus': os.cpu_count(),
        'cpu_affinity': sorted(os.sched_getaffinity(0)) if hasattr(os, 'sched_getaffinity') else None,
        'mlx': importlib.metadata.version('mlx'), 'mlx_lm': importlib.metadata.version('mlx-lm'),
        'device': str(mx.default_device()),
        'float_dtype': 'float32' if args.cpu_float32 else 'from_model',
        'weights_bytes': sum(path.stat().st_size for path in args.model.glob('*.safetensors')),
        'load_ms': round((time.perf_counter() - started) * 1000, 1),
        'note': 'Fresh process; OS file cache not cleared. No prompt/KV reuse across cases. Fixed samples, not a quality benchmark.',
        'results': [],
    }
    print(f"Model ready: {report['load_ms']} ms", flush=True)
    for run in range(args.runs):
        for case in cases:
            prompt = (f"<|plamo:tag|>dataset<|plamo:msg|>translation"
                      f"<|plamo:tag|>input<|plamo:msg|>{case['text']}"
                      f"<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>{case['target']}<|plamo:msg|>")
            began = time.perf_counter()
            tokens = tokenizer.encode(prompt)
            if len(tokens) > 4096:
                raise ValueError('Benchmark cases must fit in one translation request.')
            tokenize_ms = (time.perf_counter() - began) * 1000
            output, first_ms, last = '', None, None
            for response in stream_generate(model, tokenizer, prompt=tokens,
                                            max_tokens=8192-len(tokens), sampler=make_sampler(0.0)):
                if response.text and first_ms is None:
                    first_ms = (time.perf_counter() - began) * 1000
                output += response.text
                last = response
            if last is None or not output.strip():
                raise RuntimeError('Translation produced no text.')
            result = {**case, 'run': run + 1, 'input_tokens': len(tokens),
                      'tokenize_ms': round(tokenize_ms, 1), 'first_token_ms': round(first_ms, 1),
                      'total_ms': round((time.perf_counter()-began) * 1000, 1),
                      'finish_reason': last.finish_reason, 'translation': output,
                      'generation_tokens': last.generation_tokens, 'generation_tps': last.generation_tps}
            report['results'].append(result)
            report['peak_rss_mib'] = round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss /
                                           (1024**2 if platform.system() == 'Darwin' else 1024), 1)
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
            print(f"{case['id']} #{run+1}: first {result['first_token_ms']} ms / total {result['total_ms']} ms ({last.finish_reason})", flush=True)


if __name__ == '__main__':
    main()
