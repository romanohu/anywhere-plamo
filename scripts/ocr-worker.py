"""Offline PP-OCRv6 worker. One JSON request/response per line on stdin/stdout."""
import json
import os
from pathlib import Path
import socket
import sys

os.environ.update(OMP_NUM_THREADS="2", OPENBLAS_NUM_THREADS="1", DO_NOT_TRACK="1")


def offline(*args, **kwargs):
    raise RuntimeError("OCR runs offline; rebuild the bundled runtime if models are missing")


# Models and dictionaries are bundled. Even an upstream fallback cannot download
# anything, and screen contents never pass through a network API.
socket.socket.connect = offline
socket.create_connection = offline
socket.getaddrinfo = offline

import cv2
import numpy as np
import onnxruntime
from rapidocr import ModelType, OCRVersion, RapidOCR

cv2.setNumThreads(2)
onnxruntime.disable_telemetry_events()


def cjk(ch):
    return "\u3000" <= ch <= "\u9fff" or "\uff00" <= ch <= "\uffef"


def join_text(left, right):
    if left and right and not cjk(left[-1]) and not cjk(right[0]) and left[-1] != "-":
        return left + " " + right
    return left + right


def ink_geometry(image, boxes):
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    # Use the minority polarity so light text on dark documents works too.
    _, mask = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    if np.count_nonzero(mask) > mask.size / 2:
        mask = 255 - mask
    _, _, stats, centers = cv2.connectedComponentsWithStats(mask)
    stats, centers = stats[1:], centers[1:]
    result = []
    for box in boxes:
        x, y, right, bottom = box
        w, h = right - x, bottom - y
        vertical = h > w * 1.8
        axis = 0 if vertical else 1
        middle, thickness = ((x + right) / 2, w) if vertical else ((y + bottom) / 2, h)
        selected = stats[(centers[:, 0] >= x) & (centers[:, 0] <= right)
                         & (centers[:, 1] >= y) & (centers[:, 1] <= bottom)
                         & (np.abs(centers[:, axis] - middle) <= thickness * .3)
                         & (stats[:, 4] >= 3) & (stats[:, 2] <= w * 1.2)
                         & (stats[:, 3] <= h * 1.2)]
        if len(selected):
            # Detector boxes are expanded and often include the body underneath
            # a ruby line. Central ink components reveal its actual small size.
            dimensions = selected[:, 2 if vertical else 3]
            order = np.argsort(dimensions)
            weight = np.cumsum(selected[order, 4])
            size = float(dimensions[order[np.searchsorted(weight, weight[-1] / 2)]])
            bounds = [max(x, float(selected[:, 0].min())), max(y, float(selected[:, 1].min())),
                      min(right, float((selected[:, 0] + selected[:, 2]).max())),
                      min(bottom, float((selected[:, 1] + selected[:, 3]).max()))]
        else:
            size, bounds = min(w, h), list(box)
        result.append((bounds, max(1., size), vertical))
    return result


def remove_ruby(lines, image_height=None):
    kept = []
    for line in lines:
        x, y, r, b = line['box']
        ruby = False
        for body in lines:
            if body is line or body['vertical'] != line['vertical'] or line['size'] > body['size'] * .72:
                continue
            if not any(cjk(ch) for ch in body['text']):
                continue
            bx, by, br, bb = body['box']
            if line['vertical']:
                ruby = min(b, bb) - max(y, by) >= (b - y) * .6 and 0 <= x - br <= body['size'] * 1.2
            else:
                ruby = min(r, br) - max(x, bx) >= (r - x) * .6 and 0 <= by - b <= body['size'] * 1.2
            if ruby:
                break
        if not ruby:
            kept.append(line)
    if len(kept) < len(lines) and image_height is not None:
        sizes = [line['size'] for line in kept for ch in line['text'] if cjk(ch)]
        size = float(np.median(sizes)) if sizes else 0
        # At the bottom of a ruby document, the annotation for the next (clipped)
        # body line can be the only visible part. Do not append it to this paragraph.
        kept = [line for line in kept if not (not line['vertical'] and line['size'] <= size * .72
                and image_height - line['box'][3] < size
                and any(cjk(ch) for ch in line['text']))]
    return kept


def group_lines(lines):
    horizontal = [line for line in lines if not line['vertical']]
    vertical = [line for line in lines if line['vertical']]
    groups = []
    if horizontal:
        size = float(np.median([line['size'] for line in horizontal for _ in line['text']]))
        left = min(line['box'][0] for line in horizontal)
        prose = (sum(line['box'][2] - line['box'][0] >= size * 20 for line in horizontal) >= 2
                 and all(line['box'][0] - left <= size * 1.5 for line in horizontal)
                 and sum(cjk(ch) for line in horizontal for ch in line['text'])
                 > sum(len(line['text']) for line in horizontal) * .5)
        pitches = []
        for line in horizontal:
            x, y, r, b = line['box']
            nearby = []
            for other in horizontal:
                ox, oy, rr, bb = other['box']
                distance = (oy + bb - y - b) / 2
                step = max(line['size'], other['size'])
                if 0 < distance <= step * 4 and min(r, rr) - max(x, ox) >= min(r - x, rr - ox) * .5:
                    nearby.append(distance / step)
            if nearby:
                pitches.append(min(nearby))
        spacing = max(2.2, min(3.6, float(np.median(pitches)) * 1.25)) if pitches else 2.2
        for line in sorted(horizontal, key=lambda line: ((line['box'][1] + line['box'][3]) / 2, line['box'][0])):
            x, y, r, b = line['box']
            matches = []
            for i, group in enumerate(groups):
                previous = group[-1]
                px, py, pr, pb = previous['box']
                distance = (y + b - py - pb) / 2
                overlap = min(r, pr) - max(x, px)
                step = max(line['size'], previous['size'])
                if (0 < distance <= step * (3.2 if prose else spacing)
                        and overlap >= min(r - x, pr - px) * .5
                        and (not prose or x - left < size * .6)):
                    matches.append((distance, i))
            if matches:
                groups[min(matches)[1]].append(line)
            else:
                groups.append([line])
    vertical_groups = []
    for line in sorted(vertical, key=lambda line: (-line['box'][0], line['box'][1])):
        x, y, r, b = line['box']
        matches = []
        for i, group in enumerate(vertical_groups):
            previous = group[-1]
            px, py, pr, pb = previous['box']
            distance = (px + pr - x - r) / 2
            if 0 < distance <= max(line['size'], previous['size']) * 2.6 and min(b, pb) - max(y, py) >= min(b - y, pb - py) * .5:
                matches.append((distance, i))
        if matches:
            vertical_groups[min(matches)[1]].append(line)
        else:
            vertical_groups.append([line])
    # Nearby first lines belong to the same reading row, even when lettering
    # differs slightly in height. Keep vertical columns in right-to-left order.
    ordered = []
    for group in sorted(groups, key=lambda group: group[0]['box'][1]):
        if not ordered or group[0]['box'][1] - ordered[-1][0][0]['box'][1] > max(group[0]['size'], ordered[-1][0][0]['size']) * 1.5:
            ordered.append([])
        ordered[-1].append(group)
    return [group for row in ordered for group in sorted(row, key=lambda group: min(line['box'][0] for line in group))] + vertical_groups


class Ocr:
    def __init__(self, models):
        params = {'Global.use_cls': False, 'Global.log_level': 'error',
                  'Global.model_root_dir': str(models),
                  'EngineConfig.onnxruntime.intra_op_num_threads': 2,
                  'EngineConfig.onnxruntime.inter_op_num_threads': 1,
                  'Det.limit_type': 'max', 'Det.limit_side_len': 1280}
        for task in ['Det', 'Rec']:
            path = models / f'PP-OCRv6_{task.lower()}_small.onnx'
            if not path.is_file():
                raise FileNotFoundError(path.name)
            params.update({f'{task}.model_path': str(path), f'{task}.ocr_version': OCRVersion.PPOCRV6,
                           f'{task}.model_type': ModelType.SMALL})
        self.engine = RapidOCR(params=params)

    def recognize(self, path):
        # Never pass strings to RapidOCR: it also accepts URLs as image inputs.
        image = cv2.imread(str(path))
        if image is None or max(image.shape[:2]) > 8192:
            raise ValueError('Invalid capture image')
        result = self.engine(image)
        if result.txts is None:
            return []
        boxes = [[float(p[:, 0].min()), float(p[:, 1].min()), float(p[:, 0].max()), float(p[:, 1].max())] for p in result.boxes]
        geometry = ink_geometry(image, boxes)
        lines = [dict(text=text.strip(), box=box, size=size, vertical=vertical)
                 for text, (box, size, vertical) in zip(result.txts, geometry) if text.strip()]
        groups = group_lines(remove_ruby(lines, image.shape[0]))
        h, w = image.shape[:2]
        def region(box):
            x, y, r, b = box
            return dict(x=x / w, y=y / h, width=(r - x) / w, height=(b - y) / h)
        blocks = []
        for group in groups:
            text = ''
            for line in group:
                text = join_text(text, line['text'])
            box = [min(line['box'][0] for line in group), min(line['box'][1] for line in group),
                   max(line['box'][2] for line in group), max(line['box'][3] for line in group)]
            blocks.append(dict(text=text, **region(box), regions=[region(line['box']) for line in group]))
        return blocks


def main():
    ocr = Ocr(Path(sys.argv[1]))
    for request in sys.stdin:
        try:
            blocks = ocr.recognize(Path(json.loads(request)['path']))
            response = {'blocks': blocks}
        except Exception:
            # Avoid logging captured text or paths. Rust presents a localized error.
            response = {'error': 'OCR failed'}
        print(json.dumps(response, ensure_ascii=False, separators=(',', ':')), flush=True)


if __name__ == '__main__':
    main()
