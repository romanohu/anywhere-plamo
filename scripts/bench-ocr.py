"""Compare local OCR workers; run with .runtime-build/ocr-venv/bin/python.

Pass --worker to measure an earlier scripts/ocr-worker.py. Reports include the
recognized blocks so speed comparisons can also check text and geometry equality.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import resource
import tempfile
import time


def main():
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--worker', type=Path, default=root / 'scripts/ocr-worker.py')
    parser.add_argument('--korean-model', type=Path)
    args = parser.parse_args()
    spec = importlib.util.spec_from_file_location('worker', args.worker)
    worker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(worker)
    engine = worker.Ocr(root / 'src-tauri/resources/runtime/ocr-models', args.korean_model)
    fixtures = sorted((root / 'tests/fixtures').glob('ocr-*.png'))
    comic = root / '.runtime-build/verification/ocr-candidates/images/comic-1.png'
    if comic.is_file():
        fixtures.append(comic)
    results = []
    with tempfile.TemporaryDirectory(prefix='plamo-ocr-bench-') as temporary:
        capture = Path(temporary) / 'capture.png'
        for fixture in fixtures:
            original = worker.cv2.imread(str(fixture))
            frames = [original, original.copy(), original.copy()]
            # Change only a small background corner, as a blinking cursor or
            # live page would. Full-frame hashes must no longer skip this frame.
            frames[2][-2:, -2:] = 255 - frames[2][-2:, -2:]
            runs = []
            for label, frame in zip(['first', 'repeat', 'background-change'], frames):
                worker.cv2.imwrite(str(capture), frame)
                cpu, started = time.process_time(), time.perf_counter()
                blocks = engine.recognize(capture)
                runs.append(dict(frame=label, seconds=time.perf_counter() - started,
                                 cpu_seconds=time.process_time() - cpu, blocks=blocks))
            results.append(dict(fixture=fixture.name, runs=runs))
    print(json.dumps(dict(worker=str(args.worker), korean=args.korean_model is not None,
                          max_rss=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
                          results=results), ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
