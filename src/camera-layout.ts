export type CameraRect = { x: number; y: number; width: number; height: number };
export type CameraBlock = CameraRect & { text: string; regions?: CameraRect[] };
export type CameraPlacement = CameraRect & { font: number; marker: boolean; hidden?: boolean };

// Keep translations inside their source region. Long paragraphs get a numbered
// link to the readable transcript instead of covering neighbouring paragraphs.
export function cameraLayout(blocks: CameraBlock[], translated: string[], width: number, height: number): CameraPlacement[] {
  const placed: CameraPlacement[] = [];
  const overlaps = (a: CameraRect, b: CameraRect): boolean => a.x < b.x + b.width + 2 && a.x + a.width + 2 > b.x
    && a.y < b.y + b.height + 2 && a.y + a.height + 2 > b.y;
  for (const [index, block] of blocks.entries()) {
    const x = Math.max(0, Math.min(width - 1, block.x * width));
    const y = Math.max(0, Math.min(height - 1, block.y * height));
    const w = Math.max(1, Math.min(width - x, block.width * width));
    const h = Math.max(1, Math.min(height - y, block.height * height));
    const lines = (block.regions ?? [block]).map(r => r.height * height).sort((a, b) => a - b);
    let font = Math.max(10, Math.min(16, lines[Math.floor(lines.length / 2)] * .8));
    const text = translated[index] ?? '';
    const units = Array.from(text).reduce((n, c) => n + (/[\u0000-\u00ff]/u.test(c) ? .6 : 1), 0);
    const fits = (): boolean => Math.ceil(units / Math.max(1, (w - 8) / font)) * font * 1.4 + 6 <= h && w >= font * 3;
    while (font > 10 && !fits()) font = Math.max(10, font - 1);
    let box: CameraPlacement = { x, y, width: w, height: h, font, marker: !fits() };
    if (!box.marker) {
      box.height = Math.min(h, Math.ceil(units / Math.max(1, (w - 8) / font)) * font * 1.4 + 6);
      box.width = Math.min(w, Math.max(font * 3, units * font + 8));
    }
    const collides = (candidate: CameraRect): boolean => placed.some(other => !other.hidden && overlaps(candidate, other));
    if (collides(box)) box.marker = true;
    if (box.marker) {
      const size = Math.min(24, width, height);
      box = { x: Math.max(0, Math.min(width - size, x)), y: Math.max(0, Math.min(height - size, y)), width: size, height: size, font: 11, marker: true };
      // Dense pages can have several OCR regions on the same line.
      for (let distance = 0; distance < Math.max(width, height) && collides(box); distance += size + 3) {
        const candidates = [
          { ...box, x: Math.min(width - size, x + distance), y: Math.min(height - size, y) },
          { ...box, x: Math.max(0, x - distance), y: Math.min(height - size, y) },
          { ...box, x: Math.min(width - size, x), y: Math.min(height - size, y + distance) },
        ];
        const free = candidates.find(candidate => !collides(candidate));
        if (free) { box = free; break; }
      }
      if (collides(box)) {
        // If the image is too dense, the full transcript still contains every
        // paragraph. Never stack markers on top of other translations.
        box.hidden = true;
        for (let top = 0; top + size <= height && box.hidden; top += size + 3) {
          for (let left = 0; left + size <= width; left += size + 3) {
            const candidate = { ...box, x: left, y: top, hidden: false };
            if (!collides(candidate)) { box = candidate; break; }
          }
        }
      }
    }
    placed.push(box);
  }
  return placed;
}
