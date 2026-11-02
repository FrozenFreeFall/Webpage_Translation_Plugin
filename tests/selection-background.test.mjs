import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackground } from '../src/background.js';
import { normalizeSettings, publicConfig, DEFAULT_SETTINGS, TranslationError } from '../src/shared.js';

const page = (documentId = 'doc1') => ({ id: 'extension-test', tab: { id: 1 }, frameId: 0, documentId, url: 'https://article.test/' });
const trusted = { id: 'extension-test', url: 'chrome-extension://extension-test/popup.html' };
const audio = 'https://api.dictionaryapi.dev/media/pronunciations/en/fidelity-us.mp3';
const dictionaryResult = () => ({ word: 'fidelity', phonetics: [{ text: '/fɪˈdeləti/', audio }], meanings: [{ partOfSpeech: 'noun', definitions: [{ text: 'Loyalty.' }, { text: 'Accuracy.' }] }], sources: [{ name: 'Free Dictionary API', url: 'https://dictionaryapi.dev/' }], licenses: [] });
function harness(dependencies = {}, settings = {}) {
  const stored = { settings: { ...DEFAULT_SETTINGS, ...settings }, revision: 'r1' };
  const events = [];
  const api = { runtime: { id: 'extension-test', getURL: s => `chrome-extension://extension-test/${s}`, sendMessage: async m => events.push(m) }, storage: { local: { setAccessLevel: async () => {}, get: async () => stored, set: async v => Object.assign(stored, v) } }, tabs: { query: async () => [{ id: 1 }], sendMessage: async (_id, m) => events.push(m) } };
  const translator = dependencies.translator || (async (_settings, segments) => ({ translations: segments.map(({ id, text }) => ({ id, text: '译：' + text })), failures: [] }));
  return { app: createBackground(api, { translator, dictionary: async () => dictionaryResult(), ...dependencies }), stored, events };
}
const query = (requestId = 'word1', mode = 'dictionary', text = 'fidelity') => ({ type: 'IT_SELECTION_TRANSLATE', requestId, mode, text });

test('selection enabled setting is public, strict and defaults on', () => {
  assert.equal(normalizeSettings({}).selectionEnabled, true);
  assert.equal(normalizeSettings({ selectionEnabled: false }).selectionEnabled, false);
  assert.throws(() => normalizeSettings({ selectionEnabled: 'false' }), { code: 'CONFIG' });
  assert.equal(publicConfig(DEFAULT_SETTINGS).selectionEnabled, true);
});

test('word lookups and their cancellation do not stop the normal page/subtitle session', async () => {
  let normalSignal;
  const { app } = harness({ translator: async (_settings, segments, { signal }) => { if (segments[0].id === 'normal') normalSignal = signal; return { translations: segments.map(({ id, text }) => ({ id, text: '译：' + text })), failures: [] }; } });
  await app.handle({ type: 'IT_START_SESSION', sessionId: 'normal' }, page());
  const original = { type: 'IT_TRANSLATE', sessionId: 'normal', segments: [{ id: 'normal', text: 'Page text.' }] };
  assert.equal((await app.handle(original, page())).ok, true);
  const result = await app.handle(query(), page());
  assert.equal(result.ok, true);
  assert.equal(result.dictionary.meanings[0].definitions[0].original, 'Loyalty.');
  assert.equal(result.dictionary.meanings[0].definitions[0].text, '译：Loyalty.');
  await app.handle({ type: 'IT_CANCEL_SELECTION', requestId: 'word1' }, page());
  assert.equal(normalSignal.aborted, false);
  assert.equal((await app.handle(original, page())).ok, true);
});

test('ordinary selection translates saved provider only and rejects invalid or disabled requests', async () => {
  const calls = [];
  const { app } = harness({ translator: async (settings, segments) => { calls.push({ settings, segments }); return { translations: [{ id: 'selection', text: '短句译文' }], failures: [] }; } });
  const result = await app.handle({ ...query('sentence', 'translate', 'A sentence.'), provider: 'ai', apiKey: 'attacker' }, page());
  assert.equal(result.translations[0].text, '短句译文');
  assert.equal(calls[0].settings.provider, 'microsoft');
  assert.equal(calls[0].settings.apiKey, '');
  assert.deepEqual(calls[0].segments, [{ id: 'selection', text: 'A sentence.' }]);
  assert.doesNotMatch(JSON.stringify(result), /attacker|endpoint|apiKey/);
  for (const message of [query('bad/', 'translate', 'text'), query('a', 'unknown'), query('a', 'translate', 'x'.repeat(3001)), query('a', 'translate', '')]) assert.equal((await app.handle(message, page())).error.code, 'INPUT');
  assert.equal((await app.handle(query(), { ...page(), frameId: 1 })).error.code, 'FORBIDDEN');
  assert.equal((await app.handle(query(), { ...page(), url: 'chrome-extension://extension-test/pdf.html' })).error.code, 'FORBIDDEN');
});

test('new selections, wrong documents, navigation and settings reject stale replies and audio', async () => {
  const pending = [];
  const { app } = harness({ dictionary: async (_word, { signal }) => { await new Promise(resolve => pending.push({ resolve, signal })); return dictionaryResult(); } });
  const first = app.handle(query('old'), page());
  await new Promise(resolve => setTimeout(resolve, 0));
  const next = app.handle(query('new'), page());
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(pending[0].signal.aborted, true);
  await app.handle({ type: 'IT_CANCEL_SELECTION', requestId: 'old' }, page());
  assert.equal(pending[1].signal.aborted, false);
  pending.forEach(item => item.resolve());
  assert.equal((await first).error.code, 'CANCELLED');
  assert.equal((await next).ok, true);
  assert.equal((await app.handle({ type: 'IT_SELECTION_AUDIO', requestId: 'new', audio }, page('other'))).error.code, 'CANCELLED');
  app.cancelTab(1);
  assert.equal((await app.handle({ type: 'IT_SELECTION_AUDIO', requestId: 'new', audio }, page())).error.code, 'CANCELLED');
});

test('audio requires a live lookup match and stays lazy and independently cancellable', async () => {
  let calls = 0;
  const { app } = harness({ audioFetcher: async () => { calls++; return 'data:audio/mpeg;base64,SUQz'; } }, { targetLanguage: 'en' });
  assert.equal((await app.handle(query(), page())).ok, true);
  assert.equal(calls, 0);
  const message = { type: 'IT_SELECTION_AUDIO', requestId: 'word1', audio };
  assert.equal((await app.handle({ ...message, audio: 'https://attacker.test/a.mp3' }, page())).error.code, 'INPUT');
  assert.equal(calls, 0);
  assert.equal((await app.handle(message, page())).dataUrl, 'data:audio/mpeg;base64,SUQz');
  await app.handle({ type: 'IT_CANCEL_SELECTION', requestId: 'word1' }, page());
  assert.equal((await app.handle(message, page())).error.code, 'CANCELLED');
  assert.equal(calls, 1);
});

test('normal page start/stop does not revoke a completed word lookup or its audio', async () => {
  const { app } = harness({ audioFetcher: async () => 'data:audio/mpeg;base64,SUQz' }, { targetLanguage: 'en' });
  assert.equal((await app.handle(query(), page())).ok, true);
  await app.handle({ type: 'IT_START_SESSION', sessionId: 'normal' }, page());
  await app.handle({ type: 'IT_CANCEL_SESSION', sessionId: 'normal' }, page());
  assert.equal((await app.handle({ type: 'IT_SELECTION_AUDIO', requestId: 'word1', audio }, page())).ok, true);
});

test('global settings save and disabled toggle cancel pending dictionary/definition/audio work', async () => {
  let release;
  let signal;
  const { app } = harness({ dictionary: async (_word, options) => { signal = options.signal; await new Promise(resolve => { release = resolve; }); return dictionaryResult(); } });
  const pending = app.handle(query(), page());
  await new Promise(resolve => setTimeout(resolve, 0));
  const saved = await app.handle({ type: 'IT_SAVE_SETTINGS', settings: DEFAULT_SETTINGS }, trusted);
  assert.equal(saved.ok, true);
  assert.equal(signal.aborted, true);
  release();
  assert.equal((await pending).error.code, 'CANCELLED');

  let releaseAudio;
  const pronunciation = harness({ audioFetcher: async (_url, options) => { signal = options.signal; await new Promise(resolve => { releaseAudio = resolve; }); return 'data:audio/mpeg;base64,SUQz'; } }, { targetLanguage: 'en' });
  await pronunciation.app.handle(query(), page());
  const audioPending = pronunciation.app.handle({ type: 'IT_SELECTION_AUDIO', requestId: 'word1', audio }, page());
  await new Promise(resolve => setTimeout(resolve, 0));
  await pronunciation.app.handle({ type: 'IT_SET_SELECTION_ENABLED', enabled: false }, trusted);
  assert.equal(signal.aborted, true);
  releaseAudio();
  assert.equal((await audioPending).error.code, 'CANCELLED');
});

test('dictionary fields survive definition translation failure and English target sends no definitions', async () => {
  let calls = 0;
  const { app } = harness({ translator: async () => { calls++; throw new TranslationError('NETWORK', '网络失败'); } });
  const result = await app.handle(query(), page());
  assert.equal(result.ok, true);
  assert.equal(result.dictionary.meanings[0].definitions[0].text, 'Loyalty.');
  assert.match(result.dictionary.translationNotice, /英文|原释义/);
  assert.equal(result.dictionary.phonetics[0].audio, audio);
  assert.equal(calls, 1);
  const english = harness({ translator: async () => { throw new Error('must not call'); } }, { targetLanguage: 'en' });
  assert.equal((await english.app.handle(query(), page())).ok, true);
});

test('toolbar selection toggle is trusted, persists without changing revision or page sessions', async () => {
  const { app, stored, events } = harness();
  await app.handle({ type: 'IT_START_SESSION', sessionId: 'normal' }, page());
  assert.equal((await app.handle({ type: 'IT_SET_SELECTION_ENABLED', enabled: false }, page())).error.code, 'FORBIDDEN');
  const toggled = await app.handle({ type: 'IT_SET_SELECTION_ENABLED', enabled: false }, trusted);
  assert.equal(toggled.ok, true);
  assert.equal(toggled.config.selectionEnabled, false);
  assert.equal(stored.settings.selectionEnabled, false);
  assert.equal(stored.revision, 'r1');
  assert.ok(events.some(event => event.type === 'IT_SELECTION_CONFIG_CHANGED'));
  assert.ok(!events.some(event => event.type === 'IT_CONFIG_CHANGED'));
  assert.equal((await app.handle({ type: 'IT_TRANSLATE', sessionId: 'normal', segments: [{ id: 'normal', text: 'Page.' }] }, page())).ok, true);
  assert.equal((await app.handle(query(), page())).error.code, 'DISABLED');
});
