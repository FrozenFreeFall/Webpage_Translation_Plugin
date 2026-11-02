export const DEFAULT_SETTINGS = Object.freeze({
  provider: 'microsoft',
  endpoint: 'https://api.deepseek.com/chat/completions',
  model: 'deepseek-flash',
  apiKey: '',
  libreEndpoint: '',
  libreApiKey: '',
  targetLanguage: 'zh-CN',
  selectionEnabled: true,
});

export class TranslationError extends Error {
  constructor(code, message, fatal = false) {
    super(message);
    this.name = 'TranslationError';
    this.code = code;
    this.fatal = fatal;
  }
}

export function normalizeSettings(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TranslationError('CONFIG', '翻译服务配置无效。', true);
  const value = { ...DEFAULT_SETTINGS, ...input };
  const provider = providerOf(input);
  let endpoint = String(value.endpoint ?? '').trim();
  const model = String(value.model ?? '').trim();
  const apiKey = String(value.apiKey ?? '').trim();
  let libreEndpoint = String(value.libreEndpoint ?? '').trim();
  const libreApiKey = String(value.libreApiKey ?? '').trim();
  if (provider === 'ai') {
    let url;
    try { url = new URL(endpoint); }
    catch { throw new TranslationError('CONFIG', '请输入正确的 AI 服务地址。', true); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new TranslationError('CONFIG', '服务地址必须使用 HTTPS，且不能包含账号、查询参数或片段。', true);
    }
    let pathname = url.pathname.replace(/\/+$/, '');
    if (!pathname.endsWith('/chat/completions')) pathname += '/chat/completions';
    url.pathname = pathname;
    endpoint = url.href;
    if (!model || model.length > 200 || /[\r\n]/.test(model)) throw new TranslationError('CONFIG', '请输入有效的模型名称。', true);
    if (apiKey.length > 2048 || /[\r\n]/.test(apiKey)) throw new TranslationError('CONFIG', 'API Key 格式不正确。', true);
  }
  if (provider === 'libretranslate') {
    if (libreEndpoint) {
      let url;
      try { url = new URL(libreEndpoint); }
      catch { throw new TranslationError('CONFIG', '请输入正确的 LibreTranslate 服务地址。', true); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new TranslationError('CONFIG', 'LibreTranslate 地址须为 HTTP/HTTPS，不能包含账号、查询参数或片段。', true);
      }
      let pathname = url.pathname.replace(/\/+$/, '');
      if (!pathname.endsWith('/translate')) pathname += '/translate';
      url.pathname = pathname;
      libreEndpoint = url.href;
    }
    if (libreApiKey.length > 2048 || /[\r\n]/.test(libreApiKey)) throw new TranslationError('CONFIG', 'LibreTranslate 可选 API Key 格式不正确。', true);
  }
  if (!['zh-CN', 'en'].includes(value.targetLanguage)) throw new TranslationError('CONFIG', '请选择支持的目标语言。', true);
  if (typeof value.selectionEnabled !== 'boolean') throw new TranslationError('CONFIG', '划词翻译开关无效。', true);
  return { provider, endpoint, model, apiKey, libreEndpoint, libreApiKey, targetLanguage: value.targetLanguage, selectionEnabled: value.selectionEnabled };
}

function providerOf(input) {
  // Settings saved before 0.2 contained AI fields but no provider. Keep their behavior.
  const provider = input.provider ?? (['endpoint', 'model', 'apiKey'].some((key) => Object.hasOwn(input, key)) ? 'ai' : DEFAULT_SETTINGS.provider);
  if (!['google', 'microsoft', 'ai', 'libretranslate'].includes(provider)) throw new TranslationError('CONFIG', '请选择支持的翻译服务。', true);
  return provider;
}

export function publicConfig(settings, revision = '') {
  const provider = providerOf(settings);
  const configured = provider === 'ai' ? Boolean(settings.apiKey) : provider === 'libretranslate' ? Boolean(settings.libreEndpoint) : true;
  return { configured, provider, targetLanguage: settings.targetLanguage, revision, selectionEnabled: settings.selectionEnabled !== false };
}

export function errorResult(error) {
  // Never relay arbitrary provider/transport error bodies (they may echo keys/text).
  const safe = error instanceof TranslationError ? error : new TranslationError('INTERNAL', '操作未完成，请稍后重试。');
  return { ok: false, error: { code: safe.code, message: safe.message, fatal: safe.fatal } };
}

export function validateSegments(segments) {
  if (!Array.isArray(segments) || !segments.length || segments.length > 8) throw new TranslationError('INPUT', '每批应包含 1 至 8 段文本。');
  const ids = new Set();
  let length = 0;
  for (const segment of segments) {
    if (!segment || typeof segment.id !== 'string' || !/^[\w-]{1,100}$/.test(segment.id) || ids.has(segment.id) || typeof segment.text !== 'string' || !segment.text.trim() || segment.text.length > 3000) {
      throw new TranslationError('INPUT', '段落标识或长度不符合要求。');
    }
    ids.add(segment.id);
    length += segment.text.length;
  }
  if (length > 6000) throw new TranslationError('INPUT', '每批文本不能超过 6000 字符。');
}
