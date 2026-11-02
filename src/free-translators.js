import { normalizeSettings, TranslationError, validateSegments } from './shared.js';

function cancelled() { return new TranslationError('CANCELLED', '翻译已取消。'); }
function formatError() { return new TranslationError('FORMAT', '免费翻译接口未返回有效且对应的译文，请稍后重试。'); }
function httpError(status) {
  if (status === 429) return new TranslationError('RATE_LIMIT', '免费翻译接口请求过于频繁，已停止本页翻译，请稍后重试。', true);
  if (status >= 500 && status <= 599) return new TranslationError('SERVICE', '免费翻译接口暂时不可用，请稍后重试。');
  return new TranslationError('SERVICE', `免费翻译网页接口不可用（HTTP ${status}），请稍后重试或在设置中选择其他服务。`, true);
}

// One deadline covers the entire batch, including response bodies and retry waits.
// Race the transport explicitly: injected fetch/body readers may ignore AbortSignal.
function batchScope(signal, timeoutMs) {
  const controller = new AbortController();
  let reason;
  const stop = (error) => { if (!reason) { reason = error; controller.abort(); } };
  const externalAbort = () => stop(cancelled());
  signal?.addEventListener('abort', externalAbort, { once: true });
  if (signal?.aborted) externalAbort();
  const timer = setTimeout(() => stop(new TranslationError('TIMEOUT', '免费翻译请求超时，请检查网络后重试。', true)), timeoutMs);
  function check() { if (reason) throw reason; }
  function run(operation) {
    check();
    return new Promise((resolve, reject) => {
      const abort = () => reject(reason);
      controller.signal.addEventListener('abort', abort, { once: true });
      Promise.resolve().then(() => { check(); return operation(); }).then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', abort));
    });
  }
  function wait(ms) {
    check();
    return new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(waitTimer); reject(reason); };
      const waitTimer = setTimeout(() => { controller.signal.removeEventListener('abort', abort); resolve(); }, ms);
      controller.signal.addEventListener('abort', abort, { once: true });
    });
  }
  return { signal: controller.signal, run, wait, check, close() { clearTimeout(timer); signal?.removeEventListener('abort', externalAbort); } };
}

async function request(url, init, fetchImpl, scope, retryDelayMs) {
  for (let attempt = 0; attempt < 2; attempt++) {
    scope.check();
    let response;
    try {
      response = await scope.run(() => fetchImpl(url, { ...init, signal: scope.signal }));
    } catch (error) {
      scope.check();
      if (error instanceof TranslationError) throw error;
      throw new TranslationError('NETWORK', '无法连接免费翻译接口，请检查网络或在设置中选择其他服务。');
    }
    if (!response.ok) {
      if (attempt === 0 && (response.status === 429 || (response.status >= 500 && response.status <= 599))) {
        // Release an unread error body before retrying without exposing its text.
        try { const cancellation = response.body?.cancel(); cancellation?.catch(() => {}); } catch { /* Already closed. */ }
        await scope.wait(retryDelayMs);
        continue;
      }
      throw httpError(response.status);
    }
    try {
      const data = await scope.run(() => response.json());
      scope.check();
      return data;
    } catch (error) {
      scope.check();
      if (error instanceof TranslationError) throw error;
      throw formatError();
    }
  }
}

function validText(text) { return typeof text === 'string' && text.trim().length > 0 && text.length <= 20000; }
function googleText(data) {
  if (!Array.isArray(data)) throw formatError();
  const sentences = data?.[0];
  if (!Array.isArray(sentences) || !sentences.length || sentences.some((sentence) => !Array.isArray(sentence) || typeof sentence[0] !== 'string')) throw formatError();
  const text = sentences.map((sentence) => sentence[0]).join('');
  if (!validText(text)) throw formatError();
  return text.trim();
}
function microsoftTexts(data, segments) {
  if (!Array.isArray(data) || data.length !== segments.length) throw formatError();
  return data.map((item, index) => {
    const translations = item?.translations;
    if (!Array.isArray(translations) || translations.length !== 1 || !validText(translations[0]?.text)) throw formatError();
    return { id: segments[index].id, text: translations[0].text.trim() };
  });
}

export async function translateFreeSegments(input, segments, options = {}) {
  const settings = normalizeSettings(input);
  if (!['google', 'microsoft'].includes(settings.provider)) throw new TranslationError('CONFIG', '请选择支持的免费翻译服务。', true);
  validateSegments(segments);
  const { signal, fetchImpl = globalThis.fetch, timeoutMs = 20000, retryDelayMs = 1000 } = options;
  const scope = batchScope(signal, timeoutMs);
  const init = { method: 'POST', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' };
  try {
    scope.check();
    if (settings.provider === 'microsoft') {
      const target = settings.targetLanguage === 'en' ? 'en' : 'zh-Hans';
      const url = `https://edge.microsoft.com/translate/translatetext?isEnterpriseClient=false&to=${target}`;
      const data = await request(url, { ...init, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(segments.map(({ text }) => text)) }, fetchImpl, scope, retryDelayMs);
      return { translations: microsoftTexts(data, segments), failures: [] };
    }
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${settings.targetLanguage}&dt=t`;
    const translations = [];
    const failures = [];
    for (const segment of segments) {
      scope.check();
      try {
        const data = await request(url, { ...init, headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body: new URLSearchParams({ q: segment.text }).toString() }, fetchImpl, scope, retryDelayMs);
        translations.push({ id: segment.id, text: googleText(data) });
      } catch (error) {
        scope.check();
        if (!(error instanceof TranslationError) || error.fatal || error.code === 'CANCELLED' || error.code === 'TIMEOUT') throw error;
        failures.push({ id: segment.id, error: { code: error.code, message: error.message, fatal: false } });
      }
    }
    return { translations, failures };
  } finally { scope.close(); }
}
