import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pdfBlocks, readingOrder, splitDocumentText, wrapText } from '../src/document-layout.ts';

const style = { f: { ascent: .8, fontFamily: 'sans-serif' } };
const item = (str, x, y, width = 100, size = 12) => ({ str, dir: 'ltr', width, height: size, transform: [size, 0, 0, size, x, y], fontName: 'f' });
const viewport = [1, 0, 0, -1, 0, 800];

test('PDF fragments form paragraphs without crossing a column gutter', () => {
  const blocks = pdfBlocks([
    item('Left column', 40, 700, 90), item('first paragraph.', 40, 684, 100),
    item('Right column', 330, 700, 100), item('second paragraph.', 330, 684, 110),
  ], style, viewport, 600, 800);
  assert.deepEqual(blocks.map(b => b.text), ['Left column first paragraph.', 'Right column second paragraph.']);
  assert.ok(blocks[0].x + blocks[0].width < blocks[1].x);
  assert.equal(blocks[0].regions.length, 2);
});

test('reading order keeps a spanning title above complete columns and a footer below them', () => {
  const block = (text, x, y, width, height) => ({ text, x, y, width, height, font: .01, regions: [] });
  const title = block('title', .1, .05, .8, .05);
  const left1 = block('left1', .1, .15, .35, .2), left2 = block('left2', .1, .4, .35, .2);
  const right1 = block('right1', .55, .15, .35, .25), right2 = block('right2', .55, .5, .35, .1);
  const footer = block('footer', .1, .8, .8, .04);
  assert.deepEqual(readingOrder([footer, left2, right1, title, right2, left1]).map(b => b.text), ['title', 'left1', 'left2', 'right1', 'right2', 'footer']);
});

test('PDF equations, page numbers and URLs keep their original glyphs', () => {
  const blocks = pdfBlocks([item('12', 40, 730), item('E = mc²', 40, 700), item('https://example.com', 40, 650),
    item('The results are shown below.', 40, 600)], style, viewport, 600, 800);
  assert.deepEqual(blocks.map(b => b.text), ['The results are shown below.']);
});

test('a title reaching the column gutter does not make the body read across columns', () => {
  const blocks = pdfBlocks([item('A wider title across the gutter', 40, 750, 287, 22),
    item('Left first paragraph.', 40, 700, 190), item('Right first paragraph.', 330, 700, 190),
    item('Left second paragraph.', 40, 600, 190), item('Right second paragraph.', 330, 600, 190)], style, viewport, 600, 800);
  assert.deepEqual(blocks.map(b => b.text), ['A wider title across the gutter', 'Left first paragraph.', 'Left second paragraph.', 'Right first paragraph.', 'Right second paragraph.']);
});

test('CJK fragments and hyphenated wraps join without corrupting Hangul spaces', () => {
  const blocks = pdfBlocks([item('文章を', 40, 700, 36), item('読みます。', 76, 700, 60), item('その続きです。', 40, 684)], style, viewport, 600, 800);
  assert.equal(blocks[0].text, '文章を読みます。その続きです。');
  assert.equal(pdfBlocks([item('trans-', 40, 700), item('lation works.', 40, 684)], style, viewport, 600, 800)[0].text, 'translation works.');
  assert.equal(pdfBlocks([item('한국어 문장을', 40, 700), item('번역합니다.', 40, 684)], style, viewport, 600, 800)[0].text, '한국어 문장을 번역합니다.');
});

test('long documents split on sentences and never split a surrogate pair', () => {
  const text = 'This is a sentence. '.repeat(400) + '😀'.repeat(2000);
  const chunks = splitDocumentText(text);
  assert.ok(chunks.length > 3);
  assert.ok(chunks.every(c => c.length <= 2000 && c.isWellFormed()));
  assert.equal(chunks.join('').replace(/\s/g, ''), text.replace(/\s/g, ''));
});

test('replacement lines wrap Korean words and Japanese glyphs within their region', () => {
  const measure = text => Array.from(text).length * 10;
  for (const text of ['한국어 문장을 정확하게 번역합니다.', '日本語の訳文が元の文章の幅に収まります。', 'A verylongwordwithoutspaces must also fit.']) {
    const lines = wrapText(text, 100, measure);
    assert.ok(lines.every(line => measure(line) <= 100));
    assert.equal(lines.join('').replace(/\s/g, ''), text.replace(/\s/g, ''));
  }
});
