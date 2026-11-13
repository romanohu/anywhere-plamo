import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cameraMotion } from '../src/camera-motion.ts';
import { cameraLayout } from '../src/camera-layout.ts';

function frame(dx = 0, dy = 0, brightness = 0, noise = 0) {
  const pixels = new Uint8ClampedArray(64 * 48 * 4);
  for (let y = 0; y < 48; y++) for (let x = 0; x < 64; x++) {
    const a = x - dx, b = y - dy;
    const dark = a >= 9 && a <= 53 && b >= 8 && b <= 40 && (b % 9 < 3 || a % 13 < 2);
    const value = (dark ? 40 : 210) + brightness + (((x * 7 + y * 3) % 5) - 2) * noise;
    pixels.set([value, value, value, 255], (y * 64 + x) * 4);
  }
  return pixels;
}

test('small hand motion, sensor noise and exposure changes preserve a camera scene', () => {
  const reference = frame();
  for (const [dx, dy] of [[0, 0], [1, -1], [-2, 2], [3, 0]]) {
    const result = cameraMotion(reference, frame(dx, dy, 12, 2));
    assert.equal(result.changed, false, JSON.stringify({ dx, dy, result }));
    assert.equal(result.x, dx / 64);
    assert.equal(result.y, dy / 48);
  }
  assert.equal(cameraMotion(reference, frame(14, 8)).changed, true);
  assert.equal(cameraMotion(reference, new Uint8ClampedArray(reference.length)).changed, true);
});

test('dense multi-column camera translations stay bounded and never overlap', () => {
  const blocks = Array.from({ length: 10 }, (_, i) => ({ text: 'A long original paragraph', x: .04 + i % 2 * .5,
    y: .08 + Math.floor(i / 2) * .17, width: .4, height: .14,
    regions: [{ x: 0, y: 0, width: .4, height: .022 }] }));
  const translations = blocks.map(() => '文字の重なりを防ぐため、長い訳文は番号から全文を読みます。'.repeat(8));
  for (const [width, height] of [[320, 560], [720, 300], [230, 340]]) {
    const layout = cameraLayout(blocks, translations, width, height);
    for (const [i, box] of layout.entries()) {
      assert.ok(box.font >= 10 && box.font <= 16);
      assert.equal(box.marker, true);
      assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height);
      for (const other of layout.slice(i + 1)) {
        assert.ok(box.x + box.width <= other.x || other.x + other.width <= box.x || box.y + box.height <= other.y || other.y + other.height <= box.y);
      }
    }
  }
});

test('short translations can overlay their original region without oversized paragraph fonts', () => {
  const blocks = [{ text: 'Hello', x: .1, y: .2, width: .5, height: .1, regions: [{ height: .04 }] }];
  const [box] = cameraLayout(blocks, ['こんにちは'], 400, 600);
  assert.equal(box.marker, false);
  assert.equal(box.font, 16);
  assert.ok(box.height < 40);
  assert.ok(box.width < 200);
});

test('even coincident OCR boxes cannot stack markers on a small camera view', () => {
  const blocks = Array.from({ length: 128 }, () => ({ text: 'overlapping OCR region', x: .4, y: .4, width: .2, height: .04 }));
  const boxes = cameraLayout(blocks, blocks.map(() => '長い訳文'.repeat(20)), 180, 240);
  assert.ok(boxes.some(box => box.hidden));
  const visible = boxes.filter(box => !box.hidden);
  for (const [i, a] of visible.entries()) for (const b of visible.slice(i + 1)) {
    assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);
  }
});
