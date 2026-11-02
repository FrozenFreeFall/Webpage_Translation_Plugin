import { TranslationError } from './shared.js';

const API = 'https://api.dictionaryapi.dev/api/v2/entries/en/';
const fail = (code, text) => new TranslationError(code, text);
const clean = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';

export function dictionaryWord(value) {
  if (typeof value !== 'string') throw fail('INPUT', '请选择一个英文单词。');
  const word = value.trim().replace(/’/g, "'");
  if (word.length > 80 || !/^[a-z]+(?:['-][a-z]+)*$/i.test(word)) throw fail('INPUT', '请选择一个英文单词。');
  return word.toLowerCase();
}

function secureURL(value) {
  if (typeof value !== 'string' || value.length > 1500) return null;
  try {
    const url = new URL(value.startsWith('//') ? `https:${value}` : value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) return null;
    return url;
  } catch { return null; }
}

function audioSourceURL(value) {
  if (typeof value !== 'string' || value.length > 1500) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'commons.wikimedia.org' || url.username || url.password || url.port || url.hash) return '';
    if (url.pathname === '/w/index.php' && /^\?curid=\d{1,16}$/.test(url.search)) return url.href;
    if (url.pathname.startsWith('/wiki/File:') && !url.search) return url.href;
  } catch {}
  return '';
}

export function pronunciationURL(value) {
  const url = secureURL(value);
  if (!url) return '';
  const allowed = url.hostname === 'api.dictionaryapi.dev' && /^\/media\/pronunciations\/en\/[\w.'-]+\.(mp3|ogg|wav)$/i.test(url.pathname)
    || url.hostname === 'ssl.gstatic.com' && /^\/dictionary\/static\/sounds\/[\w/.'-]+\.(mp3|ogg|wav)$/i.test(url.pathname)
    || url.hostname === 'upload.wikimedia.org' && /^\/wikipedia\/commons\/[^?#]+\.(mp3|ogg|oga|wav)$/i.test(url.pathname);
  return allowed ? url.href : '';
}

async function request(run, { signal, fetchImpl = globalThis.fetch, timeoutMs = 12000 } = {}) {
  if (signal?.aborted) throw fail('CANCELLED', '本次划词已结束。');
  const controller = new AbortController();
  let rejectAbort;
  const abortPromise = new Promise((_, reject) => { rejectAbort = reject; });
  const abort = () => { controller.abort(); rejectAbort(fail('CANCELLED', '本次划词已结束。')); };
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { rejectAbort(fail('TIMEOUT', '词典服务响应超时，请重试。')); controller.abort(); }, timeoutMs);
  const wait = promise => Promise.race([promise, abortPromise]);
  async function fetchBounded(url, limit, audio = false) {
    const response = await wait(fetchImpl(url, { signal: controller.signal, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' }));
    if (response.status === 404 && !audio) throw fail('NOT_FOUND', '词典暂未收录这个单词，可尝试普通翻译。');
    if (!response.ok) throw fail('NETWORK', audio ? '发音加载失败，请重试。' : '词典暂不可用，请稍后重试。');
    if (Number(response.headers.get('content-length')) > limit) throw fail('LIMIT', '词典返回内容过大，请重试。');
    const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (audio && !['audio/mpeg', 'audio/mp3', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/webm', 'audio/mp4'].includes(type)) throw fail('FORMAT', '发音格式不可用，请重试。');
    const reader = response.body?.getReader();
    if (!reader) throw fail('FORMAT', '词典未返回有效内容。');
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await wait(reader.read());
        if (done) break;
        size += value.byteLength;
        if (size > limit) throw fail('LIMIT', '词典返回内容过大，请重试。');
        chunks.push(value);
      }
    } catch (error) { void reader.cancel().catch(() => {}); throw error; }
    finally { try { reader.releaseLock(); } catch {} }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return { bytes, type };
  }
  try { return await run(fetchBounded); }
  catch (error) {
    if (error instanceof TranslationError) throw error;
    if (signal?.aborted) throw fail('CANCELLED', '本次划词已结束。');
    throw fail('NETWORK', '词典或发音服务连接失败，请重试。');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort(); }
}

export async function lookupDictionary(value, options) {
  const word = dictionaryWord(value);
  return request(async fetchBounded => {
    const { bytes } = await fetchBounded(API + encodeURIComponent(word), 262144);
    let entries;
    try { entries = JSON.parse(new TextDecoder().decode(bytes)); }
    catch { throw fail('FORMAT', '词典返回格式异常，请重试。'); }
    if (!Array.isArray(entries) || !entries.length) throw fail('FORMAT', '词典返回格式异常，请重试。');
    const result = { word, phonetics: [], meanings: [], sources: [{ name: 'Free Dictionary API', url: 'https://dictionaryapi.dev/' }], licenses: [] };
    let total = 0, definitions = 0;
    const seenDefinitions = new Set(), seenPhonetics = new Set();
    function phonetic(text, audio = '') {
      const value = { text: clean(text, 160), audio: pronunciationURL(audio) };
      const key = `${value.text}|${value.audio}`;
      if ((!value.text && !value.audio) || seenPhonetics.has(key) || result.phonetics.length >= 6) return;
      seenPhonetics.add(key);
      if (/-us\./i.test(value.audio)) value.region = '美';
      else if (/-uk\.|_gb_/i.test(value.audio)) value.region = '英';
      result.phonetics.push(value);
    }
    function license(value) {
      const url = secureURL(value?.url);
      if (url?.hostname !== 'creativecommons.org' || !url.pathname.startsWith('/licenses/')) return;
      const name = clean(value.name, 80);
      if (name && !result.licenses.some(item => item.url === url.href) && result.licenses.length < 8) result.licenses.push({ name, url: url.href });
    }
    for (const entry of entries.slice(0, 8)) {
      if (!entry || typeof entry !== 'object') continue;
      const phonetics = Array.isArray(entry.phonetics) ? entry.phonetics.slice(0, 12) : [];
      for (const item of phonetics) {
        if (!item) continue;
        phonetic(item.text, item.audio);
        license(item.license);
        const url = audioSourceURL(item.sourceUrl);
        if (url && result.sources.length < 9 && !result.sources.some(source => source.url === url)) result.sources.push({ name: '发音来源 · Wikimedia Commons', url });
      }
      if (!result.phonetics.some(item => item.text)) phonetic(entry.phonetic);
      license(entry.license);
      for (const address of (Array.isArray(entry.sourceUrls) ? entry.sourceUrls.slice(0, 8) : [])) {
        const url = secureURL(address);
        if (url && /(^|\.)wiktionary\.org$/.test(url.hostname) && url.pathname.startsWith('/wiki/') && result.sources.length < 9 && !result.sources.some(item => item.url === url.href)) result.sources.push({ name: 'Wiktionary', url: url.href });
      }
      for (const meaning of (Array.isArray(entry.meanings) ? entry.meanings.slice(0, 12) : [])) {
        const group = { partOfSpeech: clean(meaning?.partOfSpeech, 50), definitions: [] };
        for (const definition of (Array.isArray(meaning?.definitions) ? meaning.definitions.slice(0, 30) : [])) {
          const text = clean(definition?.definition, 1000);
          const key = `${group.partOfSpeech}|${text}`;
          if (!text || seenDefinitions.has(key) || definitions >= 12 || total + text.length > 6000) continue;
          seenDefinitions.add(key); group.definitions.push({ text }); definitions++; total += text.length;
        }
        if (group.definitions.length) result.meanings.push(group);
      }
    }
    if (!result.meanings.length) throw fail('FORMAT', '词典没有返回有效释义，可尝试普通翻译。');
    return result;
  }, options);
}

export async function fetchPronunciation(value, options) {
  const url = pronunciationURL(value);
  if (!url) throw fail('INPUT', '发音地址不可用。');
  return request(async fetchBounded => {
    const { bytes, type } = await fetchBounded(url, 2_000_000, true);
    if (!bytes.length) throw fail('FORMAT', '发音内容为空，请重试。');
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return `data:${type};base64,${btoa(binary)}`;
  }, options);
}
