import test from 'node:test';
import assert from 'node:assert/strict';

const { lookupDictionary, fetchPronunciation } = await import('../src/dictionary.js').catch(() => ({}));
const audio = 'https://api.dictionaryapi.dev/media/pronunciations/en/fidelity-us.mp3';
const entry = () => [{ word: 'fidelity', phonetic: '/fɪˈdeləti/', phonetics: [{ text: '/fɪˈdeləti/', audio, sourceUrl: 'https://commons.wikimedia.org/w/index.php?curid=75797336', license: { name: 'BY-SA 4.0', url: 'https://creativecommons.org/licenses/by-sa/4.0' } }], meanings: [{ partOfSpeech: 'noun', definitions: [{ definition: 'Loyalty to a person.' }, { definition: 'Accuracy of a reproduction.' }] }], sourceUrls: ['https://en.wiktionary.org/wiki/fidelity'], license: { name: 'CC BY-SA 3.0', url: 'https://creativecommons.org/licenses/by-sa/3.0' } }];

test('dictionary uses one fixed word-only request and keeps factual fields with attribution', async () => {
  assert.equal(typeof lookupDictionary, 'function');
  const calls = [];
  const result = await lookupDictionary('Fidelity', { fetchImpl: async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify(entry())); } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.dictionaryapi.dev/api/v2/entries/en/fidelity');
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.referrerPolicy, 'no-referrer');
  assert.equal(result.phonetics[0].audio, audio);
  assert.equal(result.meanings[0].partOfSpeech, 'noun');
  assert.equal(result.meanings[0].definitions.length, 2);
  assert.ok(result.sources.some(source => source.url === 'https://en.wiktionary.org/wiki/fidelity'));
  assert.ok(result.sources.some(source => source.url === 'https://commons.wikimedia.org/w/index.php?curid=75797336'));
  assert.ok(result.licenses.some(license => license.name === 'CC BY-SA 3.0'));
  assert.ok(result.licenses.some(license => license.name === 'BY-SA 4.0'));
});

test('invalid words send nothing; missing entries and malformed replies have controlled errors', async () => {
  assert.equal(typeof lookupDictionary, 'function');
  let calls = 0;
  const fetchImpl = async () => { calls++; return new Response('not found', { status: 404 }); };
  for (const word of ['two words', 'a/b', '中文', '', 'a'.repeat(81), 'hello?token=secret']) await assert.rejects(lookupDictionary(word, { fetchImpl }), { code: 'INPUT' });
  assert.equal(calls, 0);
  await assert.rejects(lookupDictionary('absent', { fetchImpl }), { code: 'NOT_FOUND' });
  await assert.rejects(lookupDictionary('word', { fetchImpl: async () => new Response('{bad') }), { code: 'FORMAT' });
  await assert.rejects(lookupDictionary('word', { fetchImpl: async () => new Response('{}') }), { code: 'FORMAT' });
});

test('untrusted URLs are discarded and bounded dictionary fields remain literal text', async () => {
  assert.equal(typeof lookupDictionary, 'function');
  const entries = entry();
  entries[0].phonetics.push({ text: '/x/', audio: 'https://api.dictionaryapi.dev.evil.test/a.mp3' }, { audio: 'http://127.0.0.1/a' }, { audio: 'https://user:secret@api.dictionaryapi.dev/media/pronunciations/en/a.mp3' });
  entries[0].sourceUrls.push('javascript:alert(1)', 'https://attacker.test/');
  entries[0].meanings[0].definitions[0].definition = '<img src=x onerror=alert(1)>';
  entries[0].meanings[0].definitions.push(...Array.from({ length: 100 }, () => ({ definition: 'x'.repeat(1000) })));
  const result = await lookupDictionary('fidelity', { fetchImpl: async () => new Response(JSON.stringify(entries)) });
  assert.equal(result.phonetics.filter(item => item.audio).length, 1);
  assert.equal(result.meanings[0].definitions[0].text, '<img src=x onerror=alert(1)>');
  assert.ok(result.meanings.flatMap(item => item.definitions).length <= 12);
  assert.ok(result.meanings.flatMap(item => item.definitions).every(item => item.text.length <= 1000));
  assert.ok(!JSON.stringify(result.sources).includes('attacker'));
});

test('dictionary and audio enforce response limits, cancellation and deadlines even for stalled transports', async () => {
  assert.equal(typeof lookupDictionary, 'function');
  await assert.rejects(lookupDictionary('word', { fetchImpl: async () => new Response('[]', { headers: { 'content-length': '9999999' } }) }), { code: 'LIMIT' });
  let fetchSignal;
  await assert.rejects(lookupDictionary('word', { fetchImpl: async (_url, init) => { fetchSignal = init.signal; return new Response('[]', { headers: { 'content-length': '9999999' } }); } }), { code: 'LIMIT' });
  assert.equal(fetchSignal.aborted, true, 'oversized replies stop the underlying transport');
  await assert.rejects(lookupDictionary('word', { timeoutMs: 15, fetchImpl: async () => new Promise(() => {}) }), { code: 'TIMEOUT' });
  await assert.rejects(lookupDictionary('word', { timeoutMs: 15, fetchImpl: async () => new Response(new ReadableStream({ start() {} })) }), { code: 'TIMEOUT' });
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  await assert.rejects(lookupDictionary('word', { signal: controller.signal, fetchImpl: async () => { calls++; return new Response('[]'); } }), { code: 'CANCELLED' });
  assert.equal(calls, 0);
});

test('audio is fetched only through allowed URLs and bounded audio responses', async () => {
  assert.equal(typeof fetchPronunciation, 'function');
  let calls = 0;
  const fetchImpl = async (_url, init) => { calls++; assert.equal(init.credentials, 'omit'); assert.equal(init.referrerPolicy, 'no-referrer'); return new Response(new Uint8Array([73, 68, 51]), { headers: { 'content-type': 'audio/mpeg' } }); };
  for (const url of ['https://attacker.test/a.mp3', 'data:audio/mpeg;base64,AA==', 'https://api.dictionaryapi.dev/secret', 'https://ssl.gstatic.com/elsewhere/a.mp3']) await assert.rejects(fetchPronunciation(url, { fetchImpl }), { code: 'INPUT' });
  assert.equal(calls, 0);
  assert.equal(await fetchPronunciation(audio, { fetchImpl }), 'data:audio/mpeg;base64,SUQz');
  assert.equal(calls, 1);
  await assert.rejects(fetchPronunciation(audio, { fetchImpl: async () => new Response('HTML', { headers: { 'content-type': 'text/html' } }) }), { code: 'FORMAT' });
  await assert.rejects(fetchPronunciation(audio, { fetchImpl: async () => new Response(new Uint8Array(2_000_001), { headers: { 'content-type': 'audio/mpeg' } }) }), { code: 'LIMIT' });
});

test('active cancellation interrupts stalled dictionary/audio reads and provider errors stay controlled', async () => {
  assert.equal(typeof lookupDictionary, 'function');
  const controller = new AbortController();
  const pending = lookupDictionary('word', { signal: controller.signal, fetchImpl: async () => new Promise(() => {}) });
  controller.abort();
  await assert.rejects(pending, { code: 'CANCELLED' });
  await assert.rejects(lookupDictionary('word', { fetchImpl: async () => new Response('echoed-secret', { status: 429 }) }), error => error.code === 'NETWORK' && !error.message.includes('secret'));
  const audioController = new AbortController();
  const pendingAudio = fetchPronunciation(audio, { signal: audioController.signal, fetchImpl: async () => new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'audio/mpeg' } }) });
  await new Promise(resolve => setTimeout(resolve, 0));
  audioController.abort();
  await assert.rejects(pendingAudio, { code: 'CANCELLED' });
});
