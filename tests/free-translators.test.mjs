import test from 'node:test';
import assert from 'node:assert/strict';
const free = await import('../src/free-translators.js').catch(() => ({}));
const dispatcher = await import('../src/translator.js').catch(() => ({}));
const segments = [{ id: 'a', text: 'Hello & world?' }, { id: 'b', text: 'Read more.' }];
const settings = (provider, targetLanguage = 'zh-CN') => ({ provider, targetLanguage, endpoint: 'https://secret.invalid', model: 'private-model', apiKey: 'private-key' });
const json = (data) => new Response(JSON.stringify(data));
const google = (text) => json([[[text, 'original', null, null]]]);
const microsoft = (texts) => json(texts.map((text) => ({ translations: [{ text, to: 'zh-Hans' }] })));
function security(url, init) {
  assert.equal(init.method, 'POST');
  assert.equal(init.credentials, 'omit');
  assert.equal(init.redirect, 'error');
  assert.equal(init.referrerPolicy, 'no-referrer');
  assert.doesNotMatch(JSON.stringify({ url, headers: init.headers, body: init.body }), /private-key|private-model|secret.invalid|Authorization|Cookie/i);
}
test('google serializes requests, joins sentences and keeps text out of URLs', async () => {
  assert.equal(typeof free.translateFreeSegments, 'function');
  let calls = 0;
  let active = false;
  const result = await free.translateFreeSegments(settings('google'), segments, { fetchImpl: async (url, init) => {
    security(url, init);
    assert.equal(url, 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t');
    assert.equal(active, false);
    active = true;
    assert.equal(new URLSearchParams(init.body).get('q'), segments[calls++].text);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active = false;
    return json([[['你', 'Hello'], ['好', 'world']]]);
  } });
  assert.deepEqual(result, { translations: [{ id: 'a', text: '你好' }, { id: 'b', text: '你好' }], failures: [] });
  assert.equal(calls, 2);
});
test('microsoft batches plain strings once and maps output in input order', async () => {
  assert.equal(typeof free.translateFreeSegments, 'function');
  let calls = 0;
  const result = await free.translateFreeSegments(settings('microsoft'), segments, { fetchImpl: async (url, init) => {
    calls++;
    security(url, init);
    assert.equal(url, 'https://edge.microsoft.com/translate/translatetext?isEnterpriseClient=false&to=zh-Hans');
    assert.deepEqual(JSON.parse(init.body), segments.map(({ text }) => text));
    return microsoft(['你好', '更多']);
  } });
  assert.equal(calls, 1);
  assert.deepEqual(result.translations, [{ id: 'a', text: '你好' }, { id: 'b', text: '更多' }]);
});
test('English language is mapped on both fixed endpoints', async () => {
  assert.equal(typeof free.translateFreeSegments, 'function');
  for (const provider of ['google', 'microsoft']) {
    await free.translateFreeSegments(settings(provider, 'en'), [segments[0]], { fetchImpl: async (url) => {
      assert.equal(new URL(url).searchParams.get(provider === 'google' ? 'tl' : 'to'), 'en');
      return provider === 'google' ? google('Hello') : microsoft(['Hello']);
    } });
  }
});
test('google retains successful segments after ordinary malformed or network failures', async () => {
  assert.equal(typeof free.translateFreeSegments, 'function');
  for (const first of [() => json({}), () => { throw new Error('private-key'); }]) {
    let calls = 0;
    const result = await free.translateFreeSegments(settings('google'), segments, { fetchImpl: async () => ++calls === 1 ? first() : google('更多') });
    assert.deepEqual(result.translations, [{ id: 'b', text: '更多' }]);
    assert.equal(result.failures[0].id, 'a');
    assert.doesNotMatch(result.failures[0].error.message, /private-key/);
  }
});
test('microsoft rejects count mismatches and both providers reject invalid text', async () => {
  assert.equal(typeof free.translateFreeSegments, 'function');
  await assert.rejects(free.translateFreeSegments(settings('microsoft'), segments, { fetchImpl: async () => microsoft(['一']) }), { code: 'FORMAT' });
  for (const text of ['', '  ', 12, null, {}]) {
    const result = await free.translateFreeSegments(settings('google'), [segments[0]], { fetchImpl: async () => google(text) });
    assert.equal(result.translations.length, 0);
    assert.equal(result.failures[0].error.code, 'FORMAT');
    await assert.rejects(free.translateFreeSegments(settings('microsoft'), [segments[0]], { fetchImpl: async () => microsoft([text]) }), { code: 'FORMAT' });
  }
});
test('Google rejects malformed outer and inner response structures', async () => {
  for (const data of [{ 0: [['误接受', 'original']] }, [null], [[]], [[null]], [[['有效'], [false]]]]) {
    const result = await free.translateFreeSegments(settings('google'), [segments[0]], { fetchImpl: async () => json(data) });
    assert.equal(result.translations.length, 0);
    assert.equal(result.failures[0].error.code, 'FORMAT');
  }
});
test('429 and 5xx retry at most once; persistent rate limit is fatal before later segments', async () => {
  assert.equal(typeof free.translateFreeSegments, 'function');
  for (const provider of ['google', 'microsoft']) {
    for (const status of [429, 503]) {
      let calls = 0;
      const result = await free.translateFreeSegments(settings(provider), [segments[0]], { retryDelayMs: 1, fetchImpl: async () => ++calls === 1 ? new Response('', { status }) : provider === 'google' ? google('一') : microsoft(['一']) });
      assert.equal(calls, 2);
      assert.equal(result.translations.length, 1);
    }
    let calls = 0;
    await assert.rejects(free.translateFreeSegments(settings(provider), segments, { retryDelayMs: 1, fetchImpl: async () => { calls++; return new Response('private-key', { status: 429 }); } }), (error) => error.code === 'RATE_LIMIT' && error.fatal);
    assert.equal(calls, 2);
  }
});
test('401/403/404 mean free interface unavailable and never request API keys or fallback', async () => {
  assert.equal(typeof free.translateFreeSegments, 'function');
  for (const provider of ['google', 'microsoft']) for (const status of [401, 403, 404]) {
    let calls = 0;
    await assert.rejects(free.translateFreeSegments(settings(provider), segments, { fetchImpl: async () => { calls++; return new Response('private-key', { status }); } }), (error) => error.fatal && /免费/.test(error.message) && !/Key|private-key/.test(error.message));
    assert.equal(calls, 1);
  }
});
test('batch deadline bounds fetch, response body reads and retry waits even if transport ignores abort', async () => {
  assert.equal(typeof free.translateFreeSegments, 'function');
  for (const provider of ['google', 'microsoft']) for (const fetchImpl of [async () => new Promise(() => {}), async () => ({ ok: true, json: () => new Promise(() => {}) }), async () => new Response('', { status: 429 })]) {
    await assert.rejects(free.translateFreeSegments(settings(provider), segments, { fetchImpl, timeoutMs: 15, retryDelayMs: 1000 }), { code: 'TIMEOUT', fatal: true });
  }
});
test('Google deadline is shared by all serial segments', async () => {
  assert.equal(typeof free.translateFreeSegments, 'function');
  let calls = 0;
  await assert.rejects(free.translateFreeSegments(settings('google'), segments, { timeoutMs: 60, fetchImpl: async () => { calls++; await new Promise((resolve) => setTimeout(resolve, 40)); return google('一'); } }), { code: 'TIMEOUT', fatal: true });
  assert.equal(calls, 2);
});
test('external cancellation interrupts request and backoff, and pre-aborted input sends nothing', async () => {
  assert.equal(typeof free.translateFreeSegments, 'function');
  for (const provider of ['google', 'microsoft']) for (const duringBackoff of [false, true]) {
    const controller = new AbortController();
    const pending = free.translateFreeSegments(settings(provider), segments, { signal: controller.signal, retryDelayMs: 1000, fetchImpl: async () => duringBackoff ? new Response('', { status: 429 }) : new Promise(() => {}) });
    setTimeout(() => controller.abort(), 5);
    await assert.rejects(pending, { code: 'CANCELLED' });
    await assert.rejects(free.translateFreeSegments(settings(provider), segments, { signal: controller.signal, fetchImpl: async () => assert.fail('network called') }), { code: 'CANCELLED' });
  }
});
test('dispatcher routes ai unchanged and rejects unknown providers or invalid segments before network', async () => {
  assert.equal(typeof dispatcher.translateSegments, 'function');
  await assert.rejects(dispatcher.translateSegments(settings('unknown'), segments, { fetchImpl: async () => assert.fail('network called') }), { code: 'CONFIG' });
  for (const provider of ['google', 'microsoft']) await assert.rejects(dispatcher.translateSegments(settings(provider), [], { fetchImpl: async () => assert.fail('network called') }), { code: 'INPUT' });
  const result = await dispatcher.translateSegments(settings('ai'), [segments[0]], { fetchImpl: async (url, init) => {
    assert.equal(url, 'https://secret.invalid/chat/completions');
    assert.equal(init.headers.Authorization, 'Bearer private-key');
    return json({ choices: [{ message: { content: JSON.stringify({ translations: [{ id: 'a', text: '你好' }] }) } }] });
  } });
  assert.equal(result.translations[0].text, '你好');
});
