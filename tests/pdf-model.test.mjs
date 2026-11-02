import assert from 'node:assert/strict';
import test from 'node:test';

import * as model from '../src/pdf-model.js';
const viewport = { width: 600, height: 800, scale: 1, transform: [1, 0, 0, -1, 0, 800] };
const styles = { prose: { fontFamily: 'sans-serif', ascent: 0.8 }, code: { fontFamily: 'monospace', ascent: 0.8 } };
function item(str, x, baseline, options = {}) {
  return { str, transform: [12, 0, 0, 12, x, 800 - baseline], width: str.length * 6, height: 12,
    fontName: 'prose', dir: 'ltr', hasEOL: true, ...options };
}
function extract(items, selectedViewport = viewport) {
  assert.equal(typeof model.extractPageBlocks, 'function', 'PDF text extraction must be implemented');
  return model.extractPageBlocks({ items, styles }, selectedViewport);
}

test('joins adjacent fragments and wrapped prose in viewport coordinates', () => {
  const blocks = extract([
    item('Hello', 40, 100, { hasEOL: false }), item('world.', 76, 100),
    item('The next line.', 40, 116), item('A new paragraph.', 40, 150)
  ]);
  assert.deepEqual(blocks.map(b => b.text), ['Hello world. The next line.', 'A new paragraph.']);
  assert.deepEqual({ x: blocks[0].x, y: blocks[0].y, width: blocks[0].width, height: blocks[0].height,
    fontSize: blocks[0].fontSize, kind: blocks[0].kind },
  { x: 40, y: 90.4, width: 84, height: 28, fontSize: 12, kind: 'text' });
  assert.equal(new Set(blocks.map(b => b.id)).size, blocks.length);
  assert.deepEqual(extract([item('Hello', 40, 100)]), extract([item('Hello', 40, 100)]));
});

test('keeps columns and wide horizontal gaps separate instead of joining unrelated text', () => {
  const blocks = extract([
    item('Left column first.', 40, 100), item('Right column first.', 330, 100),
    item('Left column next.', 40, 116), item('Right column next.', 330, 116)
  ]);
  assert.deepEqual(blocks.map(b => b.text), [
    'Left column first. Left column next.', 'Right column first. Right column next.'
  ]);
});

test('preserves code spacing and indentation and does not submit code or page numbers', () => {
  const blocks = extract([
    item('function demo() {', 40, 100, { fontName: 'code' }),
    item('  return  42;', 40, 116, { fontName: 'code' }),
    item('}', 40, 132, { fontName: 'code' }),
    item('This explanation is translated.', 40, 170), item('12', 290, 780)
  ]);
  assert.deepEqual(blocks.map(b => [b.kind, b.text]), [
    ['code', 'function demo() {\n  return  42;\n}'], ['text', 'This explanation is translated.']
  ]);
  assert.deepEqual(model.makeTranslationBatches(blocks), [[{ id: blocks[1].id, text: 'This explanation is translated.' }]]);
});

test('recognizes code syntax when the PDF does not expose a monospace font', () => {
  assert.equal(extract([item('const answer = value => value + 1;', 40, 100)])[0].kind, 'code');
});

test('removes soft wrapping hyphens and does not add spaces between CJK characters', () => {
  assert.equal(extract([item('A transla-', 40, 100), item('tion example.', 40, 116)])[0].text, 'A translation example.');
  assert.equal(extract([item('这是一段', 40, 100), item('中文文字。', 40, 116)])[0].text, '这是一段中文文字。');
});

test('splits long extracted paragraphs into distinct renderable blocks within per-segment limits', () => {
  const source = 'word '.repeat(1400).trim();
  const blocks = extract([item(source, 40, 100, { width: 500 })]);
  assert.ok(blocks.length >= 3);
  assert.ok(blocks.every(b => b.text.length <= 3000));
  assert.equal(blocks.map(b => b.text).join(' '), source);
  assert.equal(new Set(blocks.map(b => b.id)).size, blocks.length);
  assert.ok(blocks.every(b => Number.isFinite(b.x) && Number.isFinite(b.y) && b.height > 0));
});

test('batches only valid prose while enforcing segment count and total character limits', () => {
  assert.equal(typeof model.makeTranslationBatches, 'function', 'PDF batching must be implemented');
  const blocks = [
    ...Array.from({ length: 11 }, (_, n) => ({ id: `short-${n}`, text: 'Hello', kind: 'text' })),
    { id: 'long-1', text: 'a'.repeat(3000), kind: 'text' },
    { id: 'long-2', text: 'b'.repeat(3000), kind: 'text' },
    { id: 'code', text: 'const x = 1;', kind: 'code' },
    { id: 'page-number', text: '42', kind: 'text' },
    { id: 'empty', text: '  ', kind: 'text' }
  ];
  const batches = model.makeTranslationBatches(blocks);
  assert.equal(batches.flat().length, 13);
  assert.ok(batches.every(b => b.length <= 8 && b.reduce((sum, s) => sum + s.text.length, 0) <= 6000));
  assert.deepEqual(batches.flat().map(b => b.id), blocks.slice(0, 13).map(b => b.id));
  assert.deepEqual(model.makeTranslationBatches([]), []);
});

test('fails explicitly for oversized external blocks rather than dropping or truncating their text', () => {
  assert.equal(typeof model.makeTranslationBatches, 'function');
  assert.throws(() => model.makeTranslationBatches([{ id: 'oversized', text: 'x'.repeat(3001), kind: 'text' }]), RangeError);
});

test('ignores non-text PDF markers and invalid geometry', () => {
  assert.deepEqual(extract([{ type: 'beginMarkedContent', id: 'p1' }, item('', 40, 100), item('oops', NaN, 100)]), []);
});

test('retains numeric code lines and ordinary words that resemble Roman numerals', () => {
  const blocks = extract([
    item('const result = [', 40, 100, { fontName: 'code' }),
    item('42', 54, 116, { fontName: 'code' }),
    item('];', 40, 132, { fontName: 'code' }),
    item('Civil', 40, 180)
  ]);
  assert.equal(blocks[0].text, 'const result = [\n  42\n];');
  assert.equal(blocks[1].text, 'Civil');
  assert.deepEqual(model.makeTranslationBatches(blocks), [[{ id: blocks[1].id, text: 'Civil' }]]);
});

test('keeps a narrow column gutter separate from the gaps between prose words', () => {
  const blocks = extract([
    item('Left column text.', 40, 100, { width: 180 }), item('Right column text.', 240, 100, { width: 180 }),
    item('Left next text.', 40, 116, { width: 180 }), item('Right next text.', 240, 116, { width: 180 })
  ]);
  assert.deepEqual(blocks.map(b => b.text), ['Left column text. Left next text.', 'Right column text. Right next text.']);
});

test('keeps prose containing an inline monospace identifier translatable', () => {
  const blocks = extract([
    item('Set', 40, 100, { hasEOL: false }),
    item('cacheSize', 64, 100, { fontName: 'code', hasEOL: false }),
    item('to control the memory usage.', 124, 100)
  ]);
  assert.deepEqual(blocks.map(block => [block.kind, block.text]), [
    ['text', 'Set cacheSize to control the memory usage.']
  ]);
  assert.deepEqual(model.makeTranslationBatches(blocks), [[{
    id: blocks[0].id, text: 'Set cacheSize to control the memory usage.'
  }]]);
});

test('retains code syntax with mixed fonts and predominantly monospace code without syntax', () => {
  const blocks = extract([
    item('const', 40, 100, { hasEOL: false }),
    item('answer', 76, 100, { fontName: 'code', hasEOL: false }),
    item('= 42;', 118, 100),
    item('alpha_beta', 40, 150, { fontName: 'code', hasEOL: false }),
    item('.', 100, 150)
  ]);
  assert.deepEqual(blocks.map(block => [block.kind, block.text]), [
    ['code', 'const answer = 42;'], ['code', 'alpha_beta.']
  ]);
  assert.deepEqual(model.makeTranslationBatches(blocks), []);
});
