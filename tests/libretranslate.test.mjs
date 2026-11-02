import test from 'node:test';
import assert from 'node:assert/strict';

const libre = await import('../src/libretranslate.js').catch(() => ({}));
const dispatcher = await import('../src/translator.js');
const settings = {
  provider: 'libretranslate', libreEndpoint: 'http://127.0.0.1:5000/proxy', libreApiKey: '',
  endpoint: 'https://private-ai.invalid', model: 'private-ai-model', apiKey: 'private-ai-key', targetLanguage: 'zh-CN',
};
const segments = [{ id: 'a', text: 'Hello <b>& world?' }, { id: 'b', text: 'Read more.' }];
const json = (data) => new Response(JSON.stringify(data));
const reply = (translatedText) => json({ translatedText });
const never = () => new Promise(() => {});

test('Libre sends one JSON batch to the saved endpoint with privacy options and no AI fields', async () => {
  assert.equal(typeof libre.translateLibreSegments, 'function');
  let calls = 0;
  const result = await libre.translateLibreSegments(settings, segments, { endpoint: 'https://page-chosen.invalid', fetchImpl: async (url, init) => {
    calls++;
    assert.equal(url, 'http://127.0.0.1:5000/proxy/translate');
    assert.equal(init.method, 'POST');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'error');
    assert.equal(init.referrerPolicy, 'no-referrer');
    assert.deepEqual(init.headers, { 'Content-Type': 'application/json' });
    assert.ok(init.signal instanceof AbortSignal);
    assert.deepEqual(JSON.parse(init.body), { q: ['Hello <b>& world?', 'Read more.'], source: 'auto', target: 'zh', format: 'text' });
    assert.doesNotMatch(JSON.stringify({ url, init }), /private-ai|Authorization|Cookie|page-chosen/);
    return reply(['你好', '更多']);
  } });
  assert.equal(calls, 1);
  assert.deepEqual(result, { translations: [{ id: 'a', text: '你好' }, { id: 'b', text: '更多' }], failures: [] });
});

test('Libre maps English and sends only its own nonempty optional API key', async () => {
  await libre.translateLibreSegments({ ...settings, targetLanguage: 'en', libreApiKey: ' libre-only-key ' }, [segments[0]], { fetchImpl: async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:5000/proxy/translate');
    assert.deepEqual(JSON.parse(init.body), { q: ['Hello <b>& world?'], source: 'auto', target: 'en', format: 'text', api_key: 'libre-only-key' });
    assert.doesNotMatch(JSON.stringify(init.headers), /Authorization|private-ai-key|libre-only-key/);
    return reply(['Hello']);
  } });
  await libre.translateLibreSegments({ ...settings, libreApiKey: '  ', endpoint: 'invalid', model: '', apiKey: 'invalid\nAI-key' }, [segments[0]], { fetchImpl: async (_url, init) => {
    assert.equal(Object.hasOwn(JSON.parse(init.body), 'api_key'), false);
    return reply(['Hello']);
  } });
});

test('dispatcher selects Libre without sending AI Authorization or using any fallback', async () => {
  let calls = 0;
  const result = await dispatcher.translateSegments(settings, [segments[0]], { fetchImpl: async (url, init) => {
    calls++;
    assert.equal(url, 'http://127.0.0.1:5000/proxy/translate');
    assert.equal(init.headers.Authorization, undefined);
    return reply('你好');
  } });
  assert.equal(calls, 1);
  assert.deepEqual(result, { translations: [{ id: 'a', text: '你好' }], failures: [] });
});

test('Libre keeps response text literal and accepts scalar strings for exactly one segment', async () => {
  const result = await libre.translateLibreSegments(settings, [segments[0]], { fetchImpl: async () => reply('  <script>x</script> &amp; \\n  ') });
  assert.deepEqual(result.translations, [{ id: 'a', text: '<script>x</script> &amp; \\n' }]);
});

test('Libre preserves valid items while empty or non-string items fail only their own ids', async () => {
  for (const invalid of ['', '  ', null, 4, {}, ['nested'], 'x'.repeat(20001)]) {
    const result = await libre.translateLibreSegments(settings, segments, { fetchImpl: async () => reply(['  你好  ', invalid]) });
    assert.deepEqual(result.translations, [{ id: 'a', text: '你好' }]);
    assert.deepEqual(result.failures.map(({ id, error }) => ({ id, code: error.code, fatal: error.fatal })), [{ id: 'b', code: 'FORMAT', fatal: false }]);
  }
});

test('Libre rejects wrong translation counts and invalid outer structures to prevent id shifts', async () => {
  for (const data of [null, [], {}, { translatedText: 'one' }, { translatedText: null }, { translatedText: {} }, { translatedText: [] }, { translatedText: ['one'] }, { translatedText: ['one', 'two', 'three'] }]) {
    await assert.rejects(libre.translateLibreSegments(settings, segments, { fetchImpl: async () => json(data) }), { code: 'FORMAT' });
  }
});

test('invalid JSON fails safely once without exposing the body', async () => {
  let calls = 0;
  await assert.rejects(libre.translateLibreSegments(settings, segments, { fetchImpl: async () => { calls++; return new Response('private-ai-key libre-only-key page text'); } }), (error) => error.code === 'FORMAT' && !/private-ai-key|libre-only-key|page text/.test(error.message));
  assert.equal(calls, 1);
});

test('Libre auth, request and missing path errors are actionable and never expose provider bodies', async () => {
  for (const [status, code, hint] of [[401, 'AUTH', /LibreTranslate.*Key/], [403, 'AUTH', /权限/], [400, 'REQUEST', /语言模型.*字符/], [404, 'REQUEST', /路径/], [418, 'REQUEST', /LibreTranslate/]]) {
    let calls = 0;
    await assert.rejects(libre.translateLibreSegments(settings, segments, { fetchImpl: async () => {
      calls++;
      return { ok: false, status, json: () => assert.fail('error body must not be read'), body: { cancel: async () => {} } };
    } }), (error) => error.code === code && error.fatal && hint.test(error.message) && !/private-ai-key|libre-only-key/.test(error.message));
    assert.equal(calls, 1);
  }
});

test('Libre retries 429 and 5xx only once and can recover on the second attempt', async () => {
  for (const status of [429, 500, 503, 599]) {
    let calls = 0;
    let releases = 0;
    const result = await libre.translateLibreSegments(settings, segments, { retryDelayMs: 1, fetchImpl: async () => ++calls === 1
      ? { ok: false, status, body: { cancel: async () => { releases++; } } }
      : reply(['你好', '更多']) });
    assert.equal(calls, 2);
    assert.equal(releases, 1);
    assert.equal(result.translations.length, 2);
  }
});

test('persistent Libre rate limits and 5xx are fatal after exactly two requests', async () => {
  for (const [status, code] of [[429, 'RATE_LIMIT'], [503, 'SERVICE']]) {
    let calls = 0;
    await assert.rejects(libre.translateLibreSegments(settings, segments, { retryDelayMs: 1, fetchImpl: async () => { calls++; return new Response('secret provider body', { status }); } }), (error) => error.code === code && error.fatal && !/secret provider body/.test(error.message));
    assert.equal(calls, 2);
  }
});

test('Libre network errors are fatal without retry or raw transport details', async () => {
  let calls = 0;
  await assert.rejects(libre.translateLibreSegments(settings, segments, { fetchImpl: async () => { calls++; throw new Error('private-ai-key libre-only-key'); } }), (error) => error.code === 'NETWORK' && error.fatal && !/private-ai-key|libre-only-key/.test(error.message));
  assert.equal(calls, 1);
});

test('Libre deadline interrupts transports, bodies and retry waits that ignore abort signals', async () => {
  for (const fetchImpl of [never, async () => ({ ok: true, json: never }), async () => new Response('', { status: 429 })]) {
    await assert.rejects(libre.translateLibreSegments(settings, segments, { timeoutMs: 15, retryDelayMs: 1000, fetchImpl }), { code: 'TIMEOUT', fatal: true });
  }
});

test('Libre has one deadline across the first request, backoff and second body', async () => {
  let calls = 0;
  const pending = libre.translateLibreSegments(settings, segments, { timeoutMs: 200, retryDelayMs: 50, fetchImpl: async () => {
    calls++;
    if (calls === 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return new Response('', { status: 503 });
    }
    return { ok: true, json: async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { translatedText: ['你好', '更多'] };
    } };
  } });
  await assert.rejects(pending, { code: 'TIMEOUT', fatal: true });
  assert.equal(calls, 2);
});

test('external cancellation interrupts fetch, body and backoff even when they ignore the signal', async () => {
  for (const fetchImpl of [never, async () => ({ ok: true, json: never }), async () => new Response('', { status: 429 })]) {
    const controller = new AbortController();
    const pending = libre.translateLibreSegments(settings, segments, { signal: controller.signal, retryDelayMs: 1000, fetchImpl });
    setTimeout(() => controller.abort(), 5);
    await assert.rejects(pending, { code: 'CANCELLED', fatal: false });
  }
});

test('an already cancelled Libre batch never opens a network request', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(libre.translateLibreSegments(settings, segments, { signal: controller.signal, fetchImpl: async () => assert.fail('network called') }), { code: 'CANCELLED' });
});

test('unconfigured or non-Libre settings fail before any network call', async () => {
  for (const input of [{ ...settings, libreEndpoint: '' }, { ...settings, provider: 'ai' }, { ...settings, libreEndpoint: 'https://host.invalid/?api_key=secret' }]) {
    await assert.rejects(libre.translateLibreSegments(input, segments, { fetchImpl: async () => assert.fail('network called') }), { code: 'CONFIG', fatal: true });
  }
});

test('Libre retains shared limits of eight segments, 6000 total and 3000 per segment', async () => {
  for (const input of [[], [{ id: 'a', text: 'x'.repeat(3001) }], Array.from({ length: 9 }, (_, i) => ({ id: String(i), text: 'text' })), [{ id: 'a', text: 'x'.repeat(3000) }, { id: 'b', text: 'x'.repeat(3000) }, { id: 'c', text: 'z' }], [{ id: 'a', text: 'one' }, { id: 'a', text: 'two' }]]) {
    await assert.rejects(libre.translateLibreSegments(settings, input, { fetchImpl: async () => assert.fail('network called') }), { code: 'INPUT' });
  }
  const result = await libre.translateLibreSegments(settings, [{ id: 'a', text: 'x'.repeat(3000) }, { id: 'b', text: 'x'.repeat(3000) }], { fetchImpl: async () => reply(['一', '二']) });
  assert.equal(result.translations.length, 2);
});
