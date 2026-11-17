// Compare low-resolution camera frames after compensating for small hand motion
// and exposure changes. Coordinates describe the movement of the original image.
// Comparisons are synchronous, so the same scratch buffers can serve every poll.
let before = new Float64Array(0);
let after = new Float64Array(0);

export function cameraMotion(reference: Uint8ClampedArray, current: Uint8ClampedArray, width = 64, height = 48): { changed: boolean; x: number; y: number; score: number } {
  // Convert each pixel once, instead of repeating the RGB calculation for every
  // candidate displacement and for both comparison passes.
  if (before.length !== width * height) {
    before = new Float64Array(width * height);
    after = new Float64Array(width * height);
  }
  for (let i = 0; i < before.length; i++) {
    const offset = i * 4;
    before[i] = reference[offset] * .299 + reference[offset + 1] * .587 + reference[offset + 2] * .114;
    after[i] = current[offset] * .299 + current[offset + 1] * .587 + current[offset + 2] * .114;
  }
  let best = { changed: true, x: 0, y: 0, score: Infinity };
  for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
    let bias = 0; let count = 0;
    for (let y = 4; y < height - 4; y += 2) for (let x = 4; x < width - 4; x += 2) {
      bias += after[(y + dy) * width + x + dx] - before[y * width + x]; count++;
    }
    bias /= count;
    let error = 0; let changed = 0;
    for (let y = 4; y < height - 4; y += 2) for (let x = 4; x < width - 4; x += 2) {
      const difference = Math.abs(after[(y + dy) * width + x + dx] - before[y * width + x] - bias);
      error += difference;
      if (difference > 28) changed++;
    }
    // Prefer no displacement for blank or ambiguous images.
    const score = error / count + (Math.abs(dx) + Math.abs(dy)) * .08;
    if (score < best.score) best = { score, x: dx / width, y: dy / height,
      changed: error / count > 10 || changed / count > .15 || Math.abs(bias) > 32 };
  }
  return best;
}
