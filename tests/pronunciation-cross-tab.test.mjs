import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackground } from '../src/background.js';
import { DEFAULT_SETTINGS } from '../src/shared.js';

test('newer explicit pronunciation supersedes an earlier cross-tab download without cancelling dictionaries', async () => {
  const pending = [], plays = [];
  let playing;
  const audio = 'https://api.dictionaryapi.dev/media/pronunciations/en/hello-uk.mp3';
  const api = {
    runtime: { id: 'test', getURL: file => 'chrome-extension://test/' + file },
    storage: { local: { setAccessLevel: async () => {}, get: async () => ({ settings: { ...DEFAULT_SETTINGS, targetLanguage: 'en' } }) } },
  };
  const app = createBackground(api, {
    dictionary: async () => ({ phonetics: [{ audio }], meanings: [] }),
    audioFetcher: async (_url, { signal }) => {
      // Deliberately allow a cancelled transport to finish; the caller must check ownership.
      await new Promise(resolve => pending.push({ resolve, signal }));
      return 'data:audio/wav;base64,UklGRg==';
    },
    audioPlayer: { play: async scope => { plays.push(scope); playing = scope; }, stop: async scope => { if (playing === scope) playing = undefined; } },
  });
  const sender = id => ({ id: 'test', tab: { id }, frameId: 0, documentId: 'doc' + id, url: 'https://example.test/' + id });
  const tick = () => new Promise(resolve => setImmediate(resolve));
  for (const id of [1, 2]) assert.equal((await app.handle({ type: 'IT_SELECTION_TRANSLATE', requestId: 'word' + id, mode: 'dictionary', text: 'hello' }, sender(id))).ok, true);
  const first = app.handle({ type: 'IT_SELECTION_AUDIO', requestId: 'word1', audio, play: true }, sender(1));
  await tick();
  const second = app.handle({ type: 'IT_SELECTION_AUDIO', requestId: 'word2', audio, play: true }, sender(2));
  await tick();
  pending[1].resolve();
  assert.deepEqual(await second, { ok: true, played: true });
  pending[0].resolve();
  const stale = await first;
  assert.equal(pending[0].signal.aborted, true, 'new explicit intent must abort the older cross-tab download');
  assert.equal(stale.error?.code, 'CANCELLED');
  assert.deepEqual(plays, ['2:doc2:word2']);
  assert.equal((await app.handle({ type: 'IT_STOP_SELECTION_AUDIO', requestId: 'word1' }, sender(1))).ok, true, 'old dictionary remains live');
  assert.equal(playing, '2:doc2:word2', 'old-tab stop must not stop the newer owner');
  assert.equal((await app.handle({ type: 'IT_STOP_SELECTION_AUDIO', requestId: 'word2' }, sender(2))).ok, true);
  assert.equal(playing, undefined);
});
