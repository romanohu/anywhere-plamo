// Compare low-resolution camera frames after compensating for small hand motion
// and exposure changes. Coordinates describe the movement of the original image.
export function cameraMotion(reference: Uint8ClampedArray, current: Uint8ClampedArray, width = 64, height = 48): { changed: boolean; x: number; y: number; score: number } {
  const luminance = (data: Uint8ClampedArray, x: number, y: number): number => {
    const i = (y * width + x) * 4;
    return data[i] * .299 + data[i + 1] * .587 + data[i + 2] * .114;
  };
  let best = { changed: true, x: 0, y: 0, score: Infinity };
  for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
    let bias = 0; let count = 0;
    for (let y = 4; y < height - 4; y += 2) for (let x = 4; x < width - 4; x += 2) {
      bias += luminance(current, x + dx, y + dy) - luminance(reference, x, y); count++;
    }
    bias /= count;
    let error = 0; let changed = 0;
    for (let y = 4; y < height - 4; y += 2) for (let x = 4; x < width - 4; x += 2) {
      const difference = Math.abs(luminance(current, x + dx, y + dy) - luminance(reference, x, y) - bias);
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
