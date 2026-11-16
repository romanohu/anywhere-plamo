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
  type Fragment = DocumentBlock & { baseline: number; face: string };
  type Line = Fragment & { members: Fragment[] };
  const fragments: Fragment[] = [];
  for (const item of items) {
    if (!item.str.trim()) continue;
    const a = item.transform, v = transform;
    const matrix = [v[0] * a[0] + v[2] * a[1], v[1] * a[0] + v[3] * a[1],
      v[0] * a[2] + v[2] * a[3], v[1] * a[2] + v[3] * a[3],
      v[0] * a[4] + v[2] * a[5] + v[4], v[1] * a[4] + v[3] * a[5] + v[5]];
    const style = styles[item.fontName];
    // Keep rotated glyphs on the original page. Inline mathematical glyphs must
    // stay with their sentence, even when their font has different metrics.
    if (style?.vertical || Math.abs(Math.atan2(matrix[1], matrix[0])) > .15) continue;
    const height = Math.hypot(matrix[2], matrix[3]);
    const scale = Math.hypot(v[0], v[1]);
    const region = { x: matrix[4] / pageWidth, y: (matrix[5] - height * (style?.ascent ?? .85)) / pageHeight,
      width: item.width * scale / pageWidth, height: height * ((style?.ascent ?? .85) - (style?.descent ?? -.15)) / pageHeight };
    if (region.width <= 0 || height <= 0 || !Object.values(region).every(Number.isFinite)
      || region.x >= 1 || region.y >= 1 || region.x + region.width <= 0 || region.y + region.height <= 0) continue;
    fragments.push({ ...region, text: item.str, font: height / pageHeight, regions: [region], baseline: matrix[5] / pageHeight, face: item.fontName });
  }
  // Compare baselines, not font-dependent ascents. Sort horizontally only after
  // finding the row: bold/italic runs can otherwise arrive in the wrong order.
  const rows: Fragment[][] = [];
  for (const fragment of fragments.sort((a, b) => b.font - a.font || a.baseline - b.baseline || a.x - b.x)) {
    const row = rows.filter(row => {
      const anchor = row[0], distance = Math.abs(anchor.baseline - fragment.baseline);
      return distance < Math.min(anchor.font, fragment.font) * .2
        || (fragment.font < anchor.font * .85 && distance < anchor.font * .65
          && row.some(part => fragment.x < part.x + part.width + anchor.font * pageHeight / pageWidth * .6
            && fragment.x + fragment.width > part.x - anchor.font * pageHeight / pageWidth * .6));
    }).sort((a, b) => Math.abs(a[0].baseline - fragment.baseline) - Math.abs(b[0].baseline - fragment.baseline))[0];
    if (row) row.push(fragment); else rows.push([fragment]);
  }
  const lines: Line[] = [];
  for (const row of rows) {
    let line: Line | undefined;
    for (const fragment of row.sort((a, b) => a.x - b.x || a.baseline - b.baseline)) {
      const gap = line ? (fragment.x - line.x - line.width) * pageWidth : Infinity;
      if (line && gap < Math.max(line.font, fragment.font) * pageHeight * 1.5) {
        if (line.members.some(part => part.text === fragment.text && Math.abs(part.x - fragment.x) < .0001)) continue;
        line.text = gap < Math.min(line.font, fragment.font) * pageHeight * .15 ? line.text + fragment.text : join(line.text, fragment.text);
        line.members.push(fragment); line.regions.push(...fragment.regions);
        Object.assign(line, bounds(line.regions));
        if (fragment.font > line.font) { line.font = fragment.font; line.baseline = fragment.baseline; }
      } else {
        line = { ...fragment, regions: [...fragment.regions], members: [fragment] }; lines.push(line);
      }
    }
  }
  for (const line of lines) {
    const faces = new Map<string, number>();
    for (const part of line.members) faces.set(part.face, (faces.get(part.face) ?? 0) + part.text.length);
    line.face = [...faces].sort((a, b) => b[1] - a[1])[0][0];
  }
  // Font bounding boxes can be taller than the line spacing (especially when
  // italic and math fonts are mixed). Divide that slack at the gap between
  // baselines, keeping masks and translations inside their own line bands.
  for (const line of lines) {
    let top = Math.max(0, line.y), bottom = Math.min(1, line.y + line.height);
    for (const other of lines) {
      if (other === line || other.x >= line.x + line.width || other.x + other.width <= line.x) continue;
      const distance = other.baseline - line.baseline;
      if (Math.abs(distance) < Math.max(line.font, other.font) * .75) continue;
      const boundary = (line.baseline - line.font * .35 + other.baseline - other.font * .35) / 2;
      if (distance < 0) top = Math.max(top, boundary); else bottom = Math.min(bottom, boundary);
    }
    line.y = top; line.height = Math.max(0, bottom - top);
    line.regions = [{ x: line.x, y: top, width: line.width, height: line.height }];
  }
  const groups: (DocumentBlock & { lines: Line[] })[] = [];
  for (const line of lines.sort((a, b) => a.baseline - b.baseline || a.x - b.x)) {
    line.text = line.text.trim();
    // Keep isolated variables, equations, page numbers and addresses intact.
    if (!/\p{L}{2,}|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(line.text) || /^[A-Z]{1,2}$/.test(line.text)
      || /^(?:https?:\/\/|www\.)\S+$/.test(line.text) || /^[\w.+-]+@[\w.-]+$/.test(line.text)
      || (/[\p{Sm}πθσϕτℓη]/u.test(line.text) && line.text.split(/\s+/).filter(s => /^\p{L}{3,}$/u.test(s)).length < 3)) continue;
    const previous = groups.filter(block => {
      const last = block.lines[block.lines.length - 1];
      const gap = line.baseline - last.baseline;
      const overlap = Math.min(block.x + block.width, line.x + line.width) - Math.max(block.x, line.x);
      const em = line.font * pageHeight / pageWidth;
      if (gap < line.font * .8 || gap > line.font * 1.7 || overlap < Math.min(block.width, line.width) * .6
        || Math.abs(block.font - line.font) > line.font * .15 || Math.abs(block.x - line.x) > em * 2
        || line.x > last.x + em * .6 || last.x + last.width < block.x + block.width - em * 2) return false;
      // Cells in a table must keep their own row; joining the labels vertically
      // would erase the correspondence with the neighbouring numeric cells.
      if (lines.some(other => other !== line && Math.abs(other.baseline - line.baseline) < line.font * .2
        && /^[-+−]?[\d.,%() ]+$/.test(other.text))) return false;
      // A heading with a distinct face is a separate paragraph; mixed inline
      // styles do not create a new block.
      if (last.face !== line.face && last.text.length < 80 && !/[.!?,;:。！？]$/.test(last.text)) return false;
      const area = bounds([block, line]);
      return !lines.some(other => other !== line && !block.lines.includes(other)
        && other.x < area.x + area.width && other.x + other.width > area.x
        && other.y < area.y + area.height - .00001 && other.y + other.height > area.y + .00001);
    }).sort((a, b) => b.y + b.height - a.y - a.height)[0];
    if (previous) {
      previous.text = join(previous.text, line.text); previous.lines.push(line);
      previous.regions.push(bounds(line.regions)); Object.assign(previous, bounds(previous.regions));
    } else groups.push({ ...line, regions: [bounds(line.regions)], lines: [line] });
  }
  return readingOrder(groups.map(({ text, font, regions, x, y, width, height }) => ({ text, font, regions, x, y, width, height })));
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
