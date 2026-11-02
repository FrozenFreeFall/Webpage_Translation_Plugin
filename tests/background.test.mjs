import test from 'node:test';
import assert from 'node:assert/strict';

const { createBackground } = await import('../src/background.js').catch(() => ({}));
const config = { endpoint: 'https://api.deepseek.com/chat/completions', model: 'deepseek-flash', apiKey: 'local-secret', targetLanguage: 'zh-CN' };
const page = (tabId = 1, documentId = 'doc1') => ({ id: 'extension-test', tab: { id: tabId }, frameId: 0, documentId, url: 'https://article.test/' });
const options = { id: 'extension-test', url: 'chrome-extension://extension-test/options.html' };
function harness(translator) {
  const stored = { settings: { ...config }, revision: 'r1' };
  const events = [];
  const api = {
    runtime: { id: 'extension-test', getURL: (s) => `chrome-extension://extension-test/${s}`, openOptionsPage: async () => {}, sendMessage: async value => events.push(value) },
    storage: { local: {
      setAccessLevel: async (v) => events.push(v),
      get: async () => ({ ...stored }), set: async (v) => Object.assign(stored, v),
    } },
    tabs: { query: async () => [{ id: 1 }], sendMessage: async (...args) => events.push(args), create: async value => { events.push(value); return { id: 2, ...value }; } },
  };
  return { app: createBackground?.(api, { translator }), stored, events };
}

const reader = (tabId = 3, documentId = 'pdf1', suffix = '?file=https%3A%2F%2Fbooks.test%2Fa.pdf') => ({ id: 'extension-test', tab: { id: tabId }, frameId: 0, documentId, url: `chrome-extension://extension-test/pdf.html${suffix}` });

test('PDF reader sessions use saved provider without exposing credentials or broadening settings trust', async () => {
  const { app } = harness(async (_settings, segments) => ({ translations: segments.map(({ id }) => ({ id, text: 'PDF 译文' })), failures: [] }));
  assert.equal((await app.handle({ type: 'IT_GET_PUBLIC_CONFIG' }, reader())).ok, true);
  assert.equal((await app.handle({ type: 'IT_GET_SETTINGS' }, reader())).error.code, 'FORBIDDEN');
  assert.equal((await app.handle({ type: 'IT_SAVE_SETTINGS', settings: config }, reader())).error.code, 'FORBIDDEN');
  assert.equal((await app.handle({ type: 'IT_START_SESSION', sessionId: 'pdf-session' }, reader())).ok, true);
  const request = { type: 'IT_TRANSLATE', sessionId: 'pdf-session', segments: [{ id: 'p1', text: 'PDF paragraph.' }] };
  assert.equal((await app.handle(request, reader())).translations[0].text, 'PDF 译文');
  assert.equal((await app.handle(request, reader(3, 'other-document'))).error.code, 'CANCELLED');
  assert.equal((await app.handle(request, reader(3, 'pdf1', '/evil'))).error.code, 'FORBIDDEN');
  assert.equal((await app.handle(request, { ...reader(), frameId: 1 })).error.code, 'FORBIDDEN');
});

test('PDF panda opens its own source in reader and popup can open a local PDF without starting translation', async () => {
  let calls = 0;
  const { app, events } = harness(async () => { calls++; return {}; });
  const source = { ...page(), url: 'https://books.test/download?id=42#page=9' };
  assert.equal((await app.handle({ type: 'IT_OPEN_PDF_READER', url: 'https://unrelated.test/a.pdf' }, source)).ok, true);
  const created = events.find(value => value?.url);
  const url = new URL(created.url);
  assert.equal(url.pathname, '/pdf.html');
  assert.equal(url.searchParams.get('file'), 'https://books.test/download?id=42');
  assert.equal(url.searchParams.get('page'), '9');
  assert.equal((await app.handle({ type: 'IT_OPEN_PDF_READER', url: 'file:///C:/Books/test.pdf' }, options)).ok, true);
  assert.equal((await app.handle({ type: 'IT_OPEN_PDF_READER', url: 'javascript:alert(1)' }, options)).ok, false);
  assert.equal(calls, 0);
});

test('locks local storage before serving messages and hides secrets from content', async () => {
  assert.equal(typeof createBackground, 'function');
  const { app, events } = harness();
  const result = await app.handle({ type: 'IT_GET_PUBLIC_CONFIG' }, page());
  assert.deepEqual(events[0], { accessLevel: 'TRUSTED_CONTEXTS' });
  assert.equal(result.ok, true);
  assert.equal(JSON.stringify(result).includes('local-secret'), false);
  const forbidden = await app.handle({ type: 'IT_GET_SETTINGS' }, page());
  assert.equal(forbidden.error.code, 'FORBIDDEN');
  assert.equal((await app.handle({ type: 'IT_GET_SETTINGS' }, options)).settings.apiKey, 'local-secret');
});

test('translates only within the sender document and refuses untrusted addresses/settings', async () => {
  assert.equal(typeof createBackground, 'function');
  const calls = [];
  const { app } = harness(async (settings, segments) => { calls.push(settings); return { translations: segments.map(({ id }) => ({ id, text: '译文' })), failures: [] }; });
  assert.equal((await app.handle({ type: 'IT_START_SESSION', sessionId: 'session1' }, page())).ok, true);
  const request = { type: 'IT_TRANSLATE', sessionId: 'session1', endpoint: 'https://attacker.test/', segments: [{ id: 'a', text: 'Article text' }] };
  assert.equal((await app.handle(request, page(2))).error.code, 'CANCELLED');
  assert.equal((await app.handle(request, page(1, 'other-doc'))).error.code, 'CANCELLED');
  assert.equal((await app.handle(request, page())).ok, true);
  assert.equal(calls[0].endpoint, config.endpoint);
  assert.equal((await app.handle({ type: 'IT_SAVE_SETTINGS', settings: config }, page())).error.code, 'FORBIDDEN');
});

test('cancel aborts in-flight translation; stale cancellation never stops a new session', async () => {
  assert.equal(typeof createBackground, 'function');
  let reached;
  let invocation = 0;
  const started = new Promise((resolve) => { reached = resolve; });
  const { app } = harness((_settings, segments, { signal }) => {
    if (++invocation > 1) return Promise.resolve({ translations: segments.map(({ id }) => ({ id, text: '新会话译文' })), failures: [] });
    return new Promise((_resolve, reject) => {
      reached(); signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  await app.handle({ type: 'IT_START_SESSION', sessionId: 's1' }, page());
  const pending = app.handle({ type: 'IT_TRANSLATE', sessionId: 's1', segments: [{ id: 'a', text: 'A sentence.' }] }, page());
  await started;
  await app.handle({ type: 'IT_CANCEL_SESSION', sessionId: 's1' }, page());
  assert.equal((await pending).error.code, 'CANCELLED');
  await app.handle({ type: 'IT_START_SESSION', sessionId: 's2' }, page());
  await app.handle({ type: 'IT_CANCEL_SESSION', sessionId: 's1' }, page());
  assert.equal((await app.handle({ type: 'IT_TRANSLATE', sessionId: 's2', segments: [{ id: 'a', text: 'New sentence.' }] }, page())).translations[0].text, '新会话译文');
});

test('saving settings invalidates pending work, changes revision, broadcasts without key', async () => {
  assert.equal(typeof createBackground, 'function');
  const { app, stored, events } = harness();
  await app.handle({ type: 'IT_START_SESSION', sessionId: 's1' }, page());
  const save = await app.handle({ type: 'IT_SAVE_SETTINGS', settings: { ...config, apiKey: '' } }, options);
  assert.equal(save.ok, true);
  assert.equal(save.config.configured, false);
  assert.notEqual(stored.revision, 'r1');
  const after = await app.handle({ type: 'IT_TRANSLATE', sessionId: 's1', segments: [{ id: 'a', text: 'Hello' }] }, page());
  assert.equal(after.error.code, 'CANCELLED');
  assert.ok(events.some((event) => Array.isArray(event) && event[1].type === 'IT_CONFIG_CHANGED'));
  assert.ok(events.some((event) => event?.type === 'IT_CONFIG_CHANGED'), 'extension reader pages must also receive the config broadcast');
  assert.equal(JSON.stringify(events).includes('local-secret'), false);
});

test('test connection uses fixed text and never saves draft credentials', async () => {
  assert.equal(typeof createBackground, 'function');
  const { app, stored } = harness(async (settings, segments) => {
    assert.equal(settings.apiKey, 'draft-key');
    assert.deepEqual(segments, [{ id: 'test', text: 'Hello, welcome to this webpage.' }]);
    return { translations: [{ id: 'test', text: '你好，欢迎浏览此网页。' }], failures: [] };
  });
  const result = await app.handle({ type: 'IT_TEST_CONNECTION', settings: { ...config, apiKey: 'draft-key' }, text: 'untrusted' }, options);
  assert.equal(result.text, '你好，欢迎浏览此网页。');
  assert.equal(stored.settings.apiKey, 'local-secret');
  assert.equal((await app.handle({ type: 'IT_TEST_CONNECTION', settings: config }, page())).error.code, 'FORBIDDEN');
});

test('default backend dispatches saved free provider without key and ignores page overrides', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers, body: init.body });
    return new Response(JSON.stringify([{ translations: [{ text: '免费译文', to: 'zh-Hans' }] }]), { status: 200 });
  };
  const { app } = harness();
  const saved = await app.handle({ type: 'IT_SAVE_SETTINGS', settings: { ...config, provider: 'microsoft', apiKey: '' } }, options);
  assert.equal(saved.config.configured, true);
  const unusedKeySave = await app.handle({ type: 'IT_SAVE_SETTINGS', settings: { ...config, provider: 'microsoft', apiKey: 'unused\n' + 'x'.repeat(2050) } }, options);
  assert.equal(unusedKeySave.ok, true);
  await app.handle({ type: 'IT_START_SESSION', sessionId: 'free-session' }, page());
  const result = await app.handle({ type: 'IT_TRANSLATE', sessionId: 'free-session', provider: 'ai', endpoint: 'https://attacker.test', segments: [{ id: 'a', text: 'Article sentence.' }] }, page());
  assert.equal(result.ok, true);
  assert.equal(result.translations[0].text, '免费译文');
  assert.equal(new URL(calls[0].url).hostname, 'edge.microsoft.com');
  assert.equal(new Headers(calls[0].headers).has('Authorization'), false);
});

test('LibreTranslate uses only its saved instance address and instance key', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let received;
  globalThis.fetch = async (url, init) => {
    received = { url: String(url), init };
    return new Response(JSON.stringify({ translatedText: ['实例译文'] }));
  };
  const { app } = harness();
  const saved = await app.handle({ type: 'IT_SAVE_SETTINGS', settings: { ...config, provider: 'libretranslate', libreEndpoint: 'http://127.0.0.1:5000/proxy', libreApiKey: 'instance-key' } }, options);
  assert.equal(saved.config.configured, true);
  assert.doesNotMatch(JSON.stringify(saved), /instance-key|127\.0|local-secret/);
  await app.handle({ type: 'IT_START_SESSION', sessionId: 'libre-session' }, page());
  const result = await app.handle({ type: 'IT_TRANSLATE', sessionId: 'libre-session', libreEndpoint: 'https://attacker.test', provider: 'google', segments: [{ id: 'a', text: 'Source sentence.' }] }, page());
  assert.equal(result.ok, true);
  assert.equal(result.translations[0].text, '实例译文');
  assert.equal(received.url, 'http://127.0.0.1:5000/proxy/translate');
  assert.deepEqual(JSON.parse(received.init.body), { q: ['Source sentence.'], source: 'auto', target: 'zh', format: 'text', api_key: 'instance-key' });
  assert.equal(new Headers(received.init.headers).has('Authorization'), false);
  assert.equal(received.init.body.includes('local-secret'), false);
});
