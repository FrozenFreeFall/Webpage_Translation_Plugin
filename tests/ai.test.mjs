import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const shared = await import(pathToFileURL(resolve('src/shared.js'))).catch(() => ({}));
const ai = await import(pathToFileURL(resolve('src/ai.js'))).catch(() => ({}));
const settings = { endpoint: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: 'test-key', targetLanguage: 'zh-CN' };
const segments = [{ id: 'a', text: 'Hello world.' }, { id: 'b', text: 'Read more.' }];
const reply = (translations) => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ translations }) } }] }), { status: 200 });

test('normalizes service base URLs and never allows credentials or HTTP in endpoint', () => {
  assert.equal(typeof shared.normalizeSettings, 'function');
  assert.equal(shared.normalizeSettings(settings).endpoint, 'https://api.deepseek.com/chat/completions');
  assert.equal(shared.normalizeSettings({ ...settings, endpoint: 'https://provider.test/v1/' }).endpoint, 'https://provider.test/v1/chat/completions');
  for (const endpoint of ['http://provider.test', 'https://user:pass@provider.test', 'https://provider.test/?key=secret']) {
    assert.throws(() => shared.normalizeSettings({ ...settings, endpoint }));
  }
  assert.throws(() => shared.normalizeSettings({ ...settings, apiKey: 'key\nvalue' }));
});

test('public configuration never exposes endpoint, model or key', () => {
  assert.equal(typeof shared.publicConfig, 'function');
  assert.deepEqual(shared.publicConfig(settings, 'r1'), { configured: true, provider: 'ai', targetLanguage: 'zh-CN', revision: 'r1' });
});

test('free services need no key or AI fields; existing settings retain their AI provider', () => {
  assert.equal(shared.DEFAULT_SETTINGS.provider, 'microsoft');
  assert.equal(shared.normalizeSettings(settings).provider, 'ai');
  for (const provider of ['google', 'microsoft']) {
    const config = shared.normalizeSettings({ provider, endpoint: '', model: '', apiKey: '', targetLanguage: 'en' });
    assert.equal(config.provider, provider);
    assert.equal(shared.publicConfig(config, 'r2').configured, true);
  }
  assert.equal(shared.publicConfig(shared.normalizeSettings({ ...settings, provider: 'ai', apiKey: '' })).configured, false);
  assert.throws(() => shared.normalizeSettings({ ...settings, provider: 'unknown' }), { code: 'CONFIG' });
  const original = shared.normalizeSettings({ ...settings, provider: 'microsoft' });
  assert.equal(original.apiKey, settings.apiKey);
  assert.equal(shared.normalizeSettings({ ...original, provider: 'ai' }).model, settings.model);
});

test('unused invalid AI key never blocks free providers but is rejected when AI is selected', () => {
  const unusedKey = 'invalid\n' + 'x'.repeat(2050);
  for (const provider of ['google', 'microsoft']) {
    const free = shared.normalizeSettings({ ...settings, provider, apiKey: unusedKey });
    assert.equal(shared.publicConfig(free).configured, true);
    assert.equal(free.apiKey, unusedKey);
    assert.throws(() => shared.normalizeSettings({ ...free, provider: 'ai' }), { code: 'CONFIG' });
  }
});

test('sends only supplied text, disables credentials/redirects and maps out-of-order ids', async () => {
  assert.equal(typeof ai.translateSegments, 'function');
  const result = await ai.translateSegments(settings, segments, { fetchImpl: async (url, init) => {
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, 'Bearer test-key');
    const body = JSON.parse(init.body);
    assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.equal(body.tools, undefined);
    assert.deepEqual(JSON.parse(body.messages[1].content).segments, segments);
    return reply([{ id: 'b', text: '阅读更多。' }, { id: 'a', text: '你好，世界。' }]);
  } });
  assert.deepEqual(result.translations, [{ id: 'a', text: '你好，世界。' }, { id: 'b', text: '阅读更多。' }]);
});

test('missing translations fail only their own segment; duplicate/unknown ids are rejected', async () => {
  assert.equal(typeof ai.translateSegments, 'function');
  const result = await ai.translateSegments(settings, segments, { fetchImpl: async () => reply([{ id: 'a', text: '你好。' }]) });
  assert.deepEqual(result.translations, [{ id: 'a', text: '你好。' }]);
  assert.equal(result.failures[0].id, 'b');
  for (const values of [[{ id: 'x', text: 'bad' }], [{ id: 'a', text: '一' }, { id: 'a', text: '二' }]]) {
    await assert.rejects(ai.translateSegments(settings, segments, { fetchImpl: async () => reply(values) }), { code: 'FORMAT' });
  }
});

test('401 is fatal and never retries or leaks response body', async () => {
  assert.equal(typeof ai.translateSegments, 'function');
  let calls = 0;
  await assert.rejects(ai.translateSegments(settings, segments, { fetchImpl: async () => { calls++; return new Response('secret test-key', { status: 401 }); } }), (error) => error.code === 'AUTH' && error.fatal && !error.message.includes('test-key'));
  assert.equal(calls, 1);
});

test('429 retries once, while malformed response does not retry', async () => {
  assert.equal(typeof ai.translateSegments, 'function');
  let calls = 0;
  const result = await ai.translateSegments(settings, segments, { retryDelayMs: 1, fetchImpl: async () => ++calls === 1 ? new Response('', { status: 429 }) : reply([{ id: 'a', text: '你好' }, { id: 'b', text: '更多' }]) });
  assert.equal(calls, 2);
  assert.equal(result.translations.length, 2);
  calls = 0;
  await assert.rejects(ai.translateSegments(settings, segments, { fetchImpl: async () => { calls++; return new Response('{}'); } }), { code: 'FORMAT' });
  assert.equal(calls, 1);
});

test('timeout and cancellation reject in-flight requests', async () => {
  assert.equal(typeof ai.translateSegments, 'function');
  const hangingFetch = (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  await assert.rejects(ai.translateSegments(settings, segments, { timeoutMs: 10, fetchImpl: hangingFetch }), { code: 'TIMEOUT' });
  const controller = new AbortController();
  const pending = ai.translateSegments(settings, segments, { signal: controller.signal, fetchImpl: hangingFetch });
  controller.abort();
  await assert.rejects(pending, { code: 'CANCELLED' });
});

test('invalid segment limits fail without any network calls', async () => {
  assert.equal(typeof ai.translateSegments, 'function');
  let calls = 0;
  const fetchImpl = async () => { calls++; return reply([]); };
  for (const items of [[], [{ id: 'a', text: 'x'.repeat(3001) }], Array.from({ length: 9 }, (_, i) => ({ id: String(i), text: 'text' })), [{ id: 'a', text: 'x'.repeat(3000) }, { id: 'b', text: 'x'.repeat(3000) }, { id: 'c', text: 'z' }]]) {
    await assert.rejects(ai.translateSegments(settings, items, { fetchImpl }), { code: 'INPUT' });
  }
  assert.equal(calls, 0);
});
