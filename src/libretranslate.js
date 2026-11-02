import { normalizeSettings, TranslationError, validateSegments } from './shared.js';

function cancelled() { return new TranslationError('CANCELLED', '翻译已取消。'); }
function timeoutError() { return new TranslationError('TIMEOUT', 'LibreTranslate 请求超时，已停止本页翻译，请检查服务后重试。', true); }
function formatError() { return new TranslationError('FORMAT', 'LibreTranslate 未返回有效且对应的译文，请检查服务响应。'); }
function networkError() { return new TranslationError('NETWORK', '无法连接 LibreTranslate，已停止本页翻译，请检查网络、服务地址和访问权限。', true); }
function httpError(status) {
  if (status === 401 || status === 403) return new TranslationError('AUTH', 'LibreTranslate 可选 API Key 无效或没有访问权限，请检查设置和服务权限。', true);
  if (status === 400) return new TranslationError('REQUEST', 'LibreTranslate 拒绝请求，请检查已安装的语言模型和服务字符限制。', true);
  if (status === 404) return new TranslationError('REQUEST', 'LibreTranslate 翻译路径不存在，请检查服务地址和 /translate 路径。', true);
  if (status === 429) return new TranslationError('RATE_LIMIT', 'LibreTranslate 请求过于频繁，已停止本页翻译，请稍后重试。', true);
  if (status >= 500 && status <= 599) return new TranslationError('SERVICE', 'LibreTranslate 暂时不可用，已停止本页翻译，请检查服务后重试。', true);
  return new TranslationError('REQUEST', `LibreTranslate 拒绝请求（HTTP ${status}），请检查服务配置。`, true);
}

// One deadline covers fetch, response reading and retry backoff. Explicitly race
// cancellation because a supplied transport or body reader may ignore signals.
function batchScope(signal, timeoutMs) {
  const controller = new AbortController();
  const deadline = Date.now() + timeoutMs;
  let reason;
  const stop = (error) => {
    if (!reason) { reason = error; controller.abort(); }
  };
  const externalAbort = () => stop(cancelled());
  signal?.addEventListener('abort', externalAbort, { once: true });
  if (signal?.aborted) externalAbort();
  const timer = setTimeout(() => stop(timeoutError()), timeoutMs);
  function check() {
    if (!reason && Date.now() >= deadline) stop(timeoutError());
    if (reason) throw reason;
  }
  function run(operation) {
    check();
    return new Promise((resolve, reject) => {
      const clean = () => controller.signal.removeEventListener('abort', abort);
      const abort = () => { clean(); reject(reason); };
      controller.signal.addEventListener('abort', abort, { once: true });
      Promise.resolve().then(() => { check(); return operation(); }).then(
        (value) => { clean(); resolve(value); },
        (error) => { clean(); reject(error); },
      );
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

function parseTranslations(data, segments) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw formatError();
  const values = typeof data.translatedText === 'string' && segments.length === 1 ? [data.translatedText] : data.translatedText;
  if (!Array.isArray(values) || values.length !== segments.length) throw formatError();
  const translations = [];
  const failures = [];
  for (let index = 0; index < segments.length; index++) {
    const { id } = segments[index];
    const text = values[index];
    if (typeof text === 'string' && text.trim() && text.length <= 20000) translations.push({ id, text: text.trim() });
    else failures.push({ id, error: { code: 'FORMAT', message: '此段没有返回有效译文。', fatal: false } });
  }
  return { translations, failures };
}

export async function translateLibreSegments(input, segments, options = {}) {
  const settings = normalizeSettings(input);
  if (settings.provider !== 'libretranslate' || !settings.libreEndpoint) throw new TranslationError('CONFIG', '请先在设置中填写 LibreTranslate 服务地址。', true);
  validateSegments(segments);
  const { signal, fetchImpl = globalThis.fetch, timeoutMs = 20000, retryDelayMs = 1000 } = options;
  const body = { q: segments.map(({ text }) => text), source: 'auto', target: settings.targetLanguage === 'en' ? 'en' : 'zh', format: 'text' };
  if (settings.libreApiKey) body.api_key = settings.libreApiKey;
  const scope = batchScope(signal, timeoutMs);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      let response;
      try {
        response = await scope.run(() => fetchImpl(settings.libreEndpoint, {
          method: 'POST', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: scope.signal,
        }));
      } catch {
        scope.check();
        throw networkError();
      }
      scope.check();
      if (!response.ok) {
        // Discard provider error bodies without reading or exposing their text.
        try { response.body?.cancel()?.catch(() => {}); } catch { /* Already closed. */ }
        if (attempt === 0 && (response.status === 429 || (response.status >= 500 && response.status <= 599))) {
          await scope.wait(retryDelayMs);
          continue;
        }
        throw httpError(response.status);
      }
      let data;
      try { data = await scope.run(() => response.json()); }
      catch {
        scope.check();
        throw formatError();
      }
      scope.check();
      return parseTranslations(data, segments);
    }
  } finally {
    scope.close();
  }
}
