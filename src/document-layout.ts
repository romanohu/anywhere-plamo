export interface DocumentRegion { x: number; y: number; width: number; height: number }
export interface DocumentBlock extends DocumentRegion { text: string; font: number; regions: DocumentRegion[] }

interface PdfItem { str: string; dir: string; width: number; height: number; transform: number[]; fontName: string }
interface PdfStyle { ascent?: number; descent?: number; vertical?: boolean; fontFamily: string }

function join(left: string, right: string): string {
  if (!left || !right) return left + right;
  if (/\s$/.test(left) || /^\s/.test(right) || /[\u3000-\u9fff\uff00-\uffef]$/.test(left) || /^[\u3000-\u9fff\uff00-\uffef]/.test(right)) return left + right;
  if (/[a-z]-$/i.test(left) && /^[a-z]/.test(right)) return left.slice(0, -1) + right;
  return left + ' ' + right;
}

function bounds(regions: DocumentRegion[]): DocumentRegion {
  const x = Math.min(...regions.map(r => r.x)), y = Math.min(...regions.map(r => r.y));
  return { x, y, width: Math.max(...regions.map(r => r.x + r.width)) - x, height: Math.max(...regions.map(r => r.y + r.height)) - y };
}

// Split at whitespace before sorting, so two-column paragraphs read down each
// column. Full-width headings and captions split the page into separate bands.
export function readingOrder(blocks: DocumentBlock[]): DocumentBlock[] {
  if (blocks.length < 2) return blocks;
  const font = blocks.reduce((sum, b) => sum + b.font, 0) / blocks.length;
  const area = bounds(blocks), middle = area.x + area.width / 2;
  const narrow = blocks.filter(block => block.width < area.width * .55);
  if (narrow.some(b => b.x + b.width <= middle) && narrow.some(b => b.x >= middle)) {
    const spanning = blocks.filter(b => b.width >= area.width * .55).sort((a, b) => a.y - b.y)[0];
    if (spanning) {
      const above = blocks.filter(b => b.y + b.height <= spanning.y);
      const below = blocks.filter(b => b.y >= spanning.y + spanning.height);
      const band = blocks.filter(b => !above.includes(b) && !below.includes(b));
      if (above.length || below.length) return [...readingOrder(above), ...band.sort((a, b) => a.y - b.y || a.x - b.x), ...readingOrder(below)];
    }
  }
  for (const axis of ['x', 'y'] as const) {
    const extent = axis === 'x' ? 'width' : 'height';
    const sorted = [...blocks].sort((a, b) => a[axis] - b[axis]);
    let end = sorted[0][axis] + sorted[0][extent];
    let cut = -1, gap = font * (axis === 'x' ? 1.5 : .4);
    for (let i = 1; i < sorted.length; i++) {
      const space = sorted[i][axis] - end;
      if (space > gap) { cut = i; gap = space; }
      end = Math.max(end, sorted[i][axis] + sorted[i][extent]);
    }
    if (cut > 0) return [...readingOrder(sorted.slice(0, cut)), ...readingOrder(sorted.slice(cut))];
  }
  return [...blocks].sort((a, b) => a.y - b.y || a.x - b.x);
}

export function pdfBlocks(items: PdfItem[], styles: Record<string, PdfStyle>, transform: number[], pageWidth: number, pageHeight: number): DocumentBlock[] {
  const fragments: DocumentBlock[] = [];
  for (const item of items) {
    if (!item.str.trim()) continue;
    const a = item.transform, v = transform;
    const matrix = [v[0] * a[0] + v[2] * a[1], v[1] * a[0] + v[3] * a[1],
      v[0] * a[2] + v[2] * a[3], v[1] * a[2] + v[3] * a[3],
      v[0] * a[4] + v[2] * a[5] + v[4], v[1] * a[4] + v[3] * a[5] + v[5]];
    const style = styles[item.fontName];
    // Keep vertical/rotated glyphs and mathematical fonts on the original page.
    if (style?.vertical || Math.abs(Math.atan2(matrix[1], matrix[0])) > .15 || /(?:CM(?:R|MI|SY|EX)|math|symbol)/i.test(item.fontName + ' ' + style?.fontFamily)) continue;
    const height = Math.hypot(matrix[2], matrix[3]);
    const scale = Math.hypot(v[0], v[1]);
    const region = { x: matrix[4] / pageWidth, y: (matrix[5] - height * (style?.ascent ?? .85)) / pageHeight,
      width: item.width * scale / pageWidth, height: height / pageHeight };
    if (region.width <= 0 || height <= 0 || !Object.values(region).every(Number.isFinite)
      || region.x >= 1 || region.y >= 1 || region.x + region.width <= 0 || region.y + region.height <= 0) continue;
    fragments.push({ ...region, text: item.str, font: height / pageHeight, regions: [region] });
  }
  const lines: DocumentBlock[] = [];
  for (const fragment of fragments.sort((a, b) => a.y - b.y || a.x - b.x)) {
    const line = [...lines].reverse().find(line => Math.abs(line.y - fragment.y) < Math.min(line.font, fragment.font) * .4
      && Math.abs(line.font - fragment.font) < line.font * .3
      && fragment.x >= line.x && fragment.x - line.x - line.width < line.font * pageHeight / pageWidth * 1.8);
    if (line) {
      const gap = (fragment.x - line.x - line.width) * pageWidth;
      line.text = gap < fragment.font * pageHeight * .15 ? line.text + fragment.text : join(line.text, fragment.text);
      line.regions.push(...fragment.regions); Object.assign(line, bounds(line.regions));
    } else lines.push({ ...fragment, regions: [...fragment.regions] });
  }
  const groups: DocumentBlock[] = [];
  for (const line of lines.sort((a, b) => a.y - b.y || a.x - b.x)) {
    line.text = line.text.trim();
    // Page numbers, addresses and stand-alone equations are not prose.
    if (!/\p{L}/u.test(line.text) || /^(?:https?:\/\/|www\.)\S+$/.test(line.text)
      || (/^[\w.+-]+@[\w.-]+$/.test(line.text))
      || (/[=∑∫√]/.test(line.text) && line.text.split(/\s+/).filter(s => /^[a-z]{3,}$/i.test(s)).length < 3)) continue;
    const previous = groups.filter(block => {
      const bottom = block.y + block.height;
      const overlap = Math.min(block.x + block.width, line.x + line.width) - Math.max(block.x, line.x);
      return line.y >= bottom - line.font * .2 && line.y - bottom < line.font * .85
        && overlap > Math.min(block.width, line.width) * .6
        && Math.abs(block.font - line.font) < line.font * .2
        && Math.abs(block.x - line.x) < line.font * pageHeight / pageWidth * 2;
    }).sort((a, b) => b.y + b.height - a.y - a.height)[0];
    if (previous) {
      previous.text = join(previous.text, line.text);
      previous.regions.push(bounds(line.regions)); Object.assign(previous, bounds(previous.regions));
    } else groups.push({ ...line, regions: [bounds(line.regions)] });
  }
  return readingOrder(groups);
}

export function splitDocumentText(text: string, limit = 2000): string[] {
  const chunks: string[] = [];
  let remaining = text.trim();
  while (remaining.length > limit) {
    const prefix = remaining.slice(0, limit);
    const boundary = Math.max(prefix.lastIndexOf('\n'), ...Array.from(prefix.matchAll(/[。！？.!?]\s/g), m => m.index! + 1));
    let end = boundary > limit / 2 ? boundary : prefix.lastIndexOf(' ');
    if (end < limit / 2) end = limit;
    if (/[\uD800-\uDBFF]/.test(remaining[end - 1])) end--;
    chunks.push(remaining.slice(0, end).trim()); remaining = remaining.slice(end).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export function wrapText(text: string, width: number, measure: (text: string) => number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let current = '';
    for (const word of paragraph.match(/\s+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[^\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu) ?? []) {
      if (current && measure(current + word) > width) { lines.push(current.trimEnd()); current = ''; }
      // Long URLs/words still have to fit inside the original text region.
      for (const character of word) {
        if (!current && /\s/.test(character)) continue;
        if (current && measure(current + character) > width) { lines.push(current.trimEnd()); current = ''; }
        current += character;
      }
    }
    lines.push(current.trimEnd());
  }
  return lines;
}
