import { TranslationError } from './shared.js';

export function normalizePdfSource(value) {
  let url;
  try { url = new URL(value); }
  catch { throw new TranslationError('INPUT', '请选择 PDF 文件，或输入完整的 HTTP/HTTPS 文件地址。'); }
  if (!['http:', 'https:', 'file:'].includes(url.protocol) || url.username || url.password || (url.protocol === 'file:' && url.hostname)) {
    throw new TranslationError('INPUT', 'PDF 地址须为 HTTP/HTTPS 或本地文件，且不能包含账号和密码。');
  }
  url.hash = '';
  return url.href;
}

export function isPdfURL(value) {
  try { return /\.pdf$/i.test(new URL(normalizePdfSource(value)).pathname); }
  catch { return false; }
}

export function pdfReaderURL(reader, source) {
  const url = new URL(reader);
  if (source) {
    url.searchParams.set('file', normalizePdfSource(source));
    const match = new URL(source).hash.match(/(?:^#|[&])page=(\d+)(?:&|$)/i);
    if (match && Number(match[1]) > 0) url.searchParams.set('page', String(Math.min(Number(match[1]), 1000000)));
  }
  return url.href;
}

export function isPdfReaderURL(value, expected) {
  try {
    const actual = new URL(value);
    const reader = new URL(expected);
    return actual.protocol === reader.protocol && actual.host === reader.host && actual.pathname === reader.pathname && !actual.username && !actual.password;
  } catch { return false; }
}
