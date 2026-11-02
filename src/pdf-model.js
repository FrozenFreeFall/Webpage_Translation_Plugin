// PDF text stays in memory. These helpers deliberately do not depend on PDF.js,
// the DOM, saved settings, or the translation transport.
const SEGMENT_LIMIT = 3000;
const CJK = /[\u2e80-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/u;
const PAGE_NUMBER = /^(?:[-–—]\s*)?\d{1,5}(?:\s*(?:\/|of)\s*\d{1,5})?(?:\s*[-–—])?$/i;
const ROMAN_NUMBER = /^(?=[ivxlcdm]+$)m{0,4}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})$/i;
const CODE_FONT = /mono|courier|consolas|menlo|code|source.?code|inconsolata/i;

function multiply(a, b) {
  return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
}

function codeSyntax(text) {
  return /^(?:\s*(?:const|let|var|function|class|import|export|def|return|if|for|while|public|private)\b.*[;{}=(:]|\s*(?:[{}];?|\/\/.*|#include\b.*|<\/?[\w-]+(?:\s[^>]*)?>))\s*$/u.test(text)
    || /(?:=>|===|!==|:=|\b\w+\([^)]*\)\s*[;{])/.test(text);
}

function asFragment(item, styles, viewport) {
  if (typeof item?.str !== 'string' || !item.str.trim() || !Array.isArray(item.transform)) return null;
  const transform = multiply(viewport.transform || [1, 0, 0, -1, 0, viewport.height || 0], item.transform);
  if (!transform.every(Number.isFinite)) return null;
  const fontSize = Math.hypot(transform[2], transform[3]) || Math.hypot(transform[0], transform[1]);
  if (!fontSize) return null;
  const style = styles[item.fontName] || {};
  const ascent = Number.isFinite(style.ascent) ? style.ascent : Number.isFinite(style.descent) ? 1 + style.descent : 0.8;
  const scale = Math.hypot(viewport.transform?.[0] ?? viewport.scale ?? 1, viewport.transform?.[1] ?? 0);
  const width = Math.abs(Number(item.width) || 0) * scale;
  const angle = Math.atan2(transform[1], transform[0]);
  const x = transform[4] + Math.sin(angle) * fontSize * ascent;
  const y = transform[5] - Math.cos(angle) * fontSize * ascent;
  return { text: item.str, x, y, right: x + width, bottom: y + fontSize, baseline: transform[5],
    fontSize, monospace: CODE_FONT.test(`${item.fontName} ${style.fontFamily || ''}`),
    vertical: !!style.vertical || Math.abs(Math.sin(angle)) > 0.3 };
}

function proseJoin(left, right) {
  if (!left) return right;
  if (!right) return left;
  // Remove PDF line-wrap hyphenation, while leaving explicit em/en dashes alone.
  if (/[\p{L}][\-\u00ad]$/u.test(left) && /^\p{Ll}/u.test(right)) return left.slice(0, -1) + right;
  if (CJK.test(left.at(-1)) && CJK.test(right[0])) return left + right;
  return left + ' ' + right;
}

function makeLines(fragments) {
  const rows = [];
  for (const fragment of fragments.sort((a, b) => a.baseline - b.baseline || a.x - b.x)) {
    const row = rows.findLast(r => Math.abs(r.baseline - fragment.baseline) <= Math.min(r.fontSize, fragment.fontSize) * 0.3);
    if (row && !fragment.vertical) row.fragments.push(fragment);
    else rows.push({ baseline: fragment.baseline, fontSize: fragment.fontSize, fragments: [fragment] });
  }
  const lines = [];
  for (const row of rows) {
    let line;
    for (const fragment of row.fragments.sort((a, b) => a.x - b.x)) {
      const gap = line ? fragment.x - line.right : Infinity;
      const gapLimit = Math.max(fragment.fontSize, line?.fontSize || 0) * (fragment.monospace && line?.fragments.at(-1)?.monospace ? 2.5 : 1.5);
      if (!line || gap > gapLimit || fragment.vertical) {
        line = { ...fragment, fragments: [fragment] };
        lines.push(line);
      } else {
        line.fragments.push(fragment);
        line.right = Math.max(line.right, fragment.right);
        line.y = Math.min(line.y, fragment.y);
        line.bottom = Math.max(line.bottom, fragment.bottom);
      }
    }
  }
  for (const line of lines) {
    let characterCount = 0;
    let monospaceCount = 0;
    for (const fragment of line.fragments) {
      const count = fragment.text.replace(/\s/gu, '').length;
      characterCount += count;
      if (fragment.monospace) monospaceCount += count;
    }
    // Inline identifiers use code fonts inside ordinary prose. Font evidence
    // identifies a code line only when most of its visible characters agree.
    line.monospace = monospaceCount >= characterCount * 0.8;
    line.kind = line.monospace || codeSyntax(line.fragments.map(f => f.text).join(' ')) ? 'code' : 'text';
    let text = '';
    let previous;
    for (const fragment of line.fragments) {
      const gap = previous ? fragment.x - previous.right : 0;
      if (text && !/\s$/.test(text) && !/^\s/.test(fragment.text) && gap > line.fontSize * 0.12) {
        const spaces = line.kind === 'code' ? Math.max(1, Math.round(gap / (line.fontSize * 0.6))) : 1;
        text += ' '.repeat(spaces);
      }
      text += fragment.text;
      previous = fragment;
    }
    line.text = line.kind === 'code' ? text.trimEnd() : text.replace(/\s+/gu, ' ').trim();
  }
  return lines.sort((a, b) => a.y - b.y || a.x - b.x);
}

function canContinue(block, line) {
  const last = block.lines.at(-1);
  const size = Math.max(last.fontSize, line.fontSize);
  const distance = line.baseline - last.baseline;
  if (distance < size * 0.5 || distance > size * 1.8 || block.kind !== line.kind || last.vertical || line.vertical) return false;
  if (Math.min(last.fontSize, line.fontSize) / size < 0.8) return false;
  if (block.kind === 'code') return line.x >= block.x - size && line.x <= block.right + size;
  // Stay in the same column, including common first-line paragraph indentation.
  return Math.abs(block.x - line.x) <= size * 2.5
    && Math.min(block.right, line.right) - Math.max(block.x, line.x) > 0;
}

function splitText(text) {
  const parts = [];
  let rest = text;
  while (rest.length > SEGMENT_LIMIT) {
    let end = rest.lastIndexOf(' ', SEGMENT_LIMIT);
    if (end < SEGMENT_LIMIT / 2) end = SEGMENT_LIMIT;
    // Never cut between the halves of a Unicode surrogate pair.
    if (/[\uD800-\uDBFF]/u.test(rest[end - 1])) end--;
    parts.push(rest.slice(0, end));
    rest = rest.slice(end).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

/**
 * Convert PDF.js getTextContent() into stable, renderable page-local blocks.
 * Pass page.getViewport({ scale: 1 }); returned bounds use its CSS coordinate system.
 * Long prose is split here, before the reader creates its translation/result map.
 */
export function extractPageBlocks(textContent, viewport) {
  const fragments = (textContent?.items || []).map(item => asFragment(item, textContent.styles || {}, viewport)).filter(Boolean);
  const blocks = [];
  for (const line of makeLines(fragments)) {
    const nearMargin = line.y < viewport.height * 0.08 || line.bottom > viewport.height * 0.92;
    if (!line.text || (line.kind !== 'code' && (PAGE_NUMBER.test(line.text.trim()) || nearMargin && ROMAN_NUMBER.test(line.text.trim())))) continue;
    const block = blocks.findLast(candidate => canContinue(candidate, line));
    if (block) {
      block.lines.push(line);
      block.x = Math.min(block.x, line.x);
      block.y = Math.min(block.y, line.y);
      block.right = Math.max(block.right, line.right);
      block.bottom = Math.max(block.bottom, line.bottom);
    } else blocks.push({ ...line, lines: [line] });
  }
  const result = [];
  for (const block of blocks.sort((a, b) => a.y - b.y || a.x - b.x)) {
    let text = '';
    for (const line of block.lines) {
      if (block.kind === 'code') {
        const indent = Math.max(0, Math.round((line.x - block.x) / (block.fontSize * 0.6)));
        text += (text ? '\n' : '') + ' '.repeat(indent) + line.text;
      } else text = proseJoin(text, line.text);
    }
    const parts = block.kind === 'code' ? [text] : splitText(text);
    let used = 0;
    for (const part of parts) {
      const height = block.bottom - block.y;
      const ratio = part.length / text.length;
      result.push({ id: `pdf-block-${result.length}`, text: part, x: block.x,
        y: Math.round((block.y + height * used / text.length) * 1000) / 1000,
        width: Math.round((block.right - block.x) * 1000) / 1000,
        height: Math.round(height * ratio * 1000) / 1000,
        fontSize: block.fontSize, kind: block.kind });
      used += part.length;
    }
  }
  return result;
}

/** Pack the already-split text blocks using the background transport's limits. */
export function makeTranslationBatches(blocks) {
  const batches = [];
  let batch = [];
  let length = 0;
  for (const block of blocks) {
    if (block.kind !== 'text' || !block.text?.trim() || PAGE_NUMBER.test(block.text.trim())) continue;
    if (block.text.length > SEGMENT_LIMIT) throw new RangeError('PDF text blocks must be split before batching');
    if (batch.length === 8 || length + block.text.length > 6000) {
      batches.push(batch);
      batch = [];
      length = 0;
    }
    batch.push({ id: block.id, text: block.text });
    length += block.text.length;
  }
  if (batch.length) batches.push(batch);
  return batches;
}
