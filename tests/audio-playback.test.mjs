import test from 'node:test';
import assert from 'node:assert/strict';
const playbackModule = await import('../src/audio-playback.js').catch(() => ({}));
const offscreenModule = await import('../src/audio-offscreen.js').catch(() => ({}));
const { createAudioPlayback } = playbackModule;
const { installAudioOffscreen } = offscreenModule;
const audio = 'data:audio/wav;base64,UklGRg==';
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const failure = code => error => error.code === code;
const origin = 'chrome-extension://test-extension/';
const sender = { id: 'test-extension', url: origin + 'src/background.js' };

function offscreenHarness() {
  const listeners = [], instances = [], pending = [];
  class AudioFixture {
    constructor(source) { this.src = source; this.paused = true; instances.push(this); this.events = new Map(); }
    play() { this.paused = false; const task = deferred(); pending.push(task); return task.promise; }
    pause() { this.paused = true; }
    removeAttribute(name) { if (name === 'src') this.src = ''; }
    load() {}
    addEventListener(name, listener) { this.events.set(name, listener); }
    removeEventListener(name, listener) { if (this.events.get(name) === listener) this.events.delete(name); }
    emit(name) { this.events.get(name)?.(); }
  }
  const api = { runtime: { id: 'test-extension', getURL: file => origin + file, onMessage: { addListener: listener => listeners.push(listener) } } };
  installAudioOffscreen(api, AudioFixture);
  function dispatch(message, from = sender) {
    return new Promise(resolve => {
      const keep = listeners[0](message, from, resolve);
      if (keep !== true) resolve(undefined);
    });
  }
  return { dispatch, instances, pending };
}
function playbackHarness(options = {}) {
  const messages = [], contexts = [], creations = [];
  const offscreen = options.offscreen || offscreenHarness();
  const api = {
    runtime: {
      id: 'test-extension', getURL: file => origin + file,
      getContexts: async filter => { contexts.push(filter); return options.getContexts ? options.getContexts(filter) : []; },
      sendMessage: async message => { messages.push(message); return options.sendMessage ? options.sendMessage(message) : offscreen.dispatch(message); },
    },
    offscreen: { createDocument: async args => { creations.push(args); await options.createDocument?.(args); } },
  };
  return { player: createAudioPlayback(api), messages, contexts, creations, offscreen };
}
const playMessage = (token, dataUrl = audio) => ({ target: 'it-audio-offscreen', type: 'IT_AUDIO_PLAY', token, dataUrl });
const stopMessage = token => ({ target: 'it-audio-offscreen', type: 'IT_AUDIO_STOP', token });

test('audio playback exposes an extension-owned pronunciation player', () => {
  assert.equal(typeof createAudioPlayback, 'function', 'audio helper is missing');
  assert.equal(typeof installAudioOffscreen, 'function', 'offscreen document listener is missing');
});

test('concurrent pronunciation requests create one offscreen document and only the latest request plays', async () => {
  const ready = deferred();
  const h = playbackHarness({ createDocument: () => ready.promise });
  const old = h.player.play('tab-1/old', audio);
  const rejected = assert.rejects(old, failure('CANCELLED'));
  await tick();
  const next = h.player.play('tab-2/new', audio);
  await tick();
  assert.equal(h.creations.length, 1);
  ready.resolve();
  await tick();
  assert.equal(h.offscreen.instances.length, 1);
  h.offscreen.pending[0].resolve();
  await next;
  await rejected;
  assert.deepEqual(h.contexts[0], { contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [origin + 'audio-offscreen.html'] });
  assert.deepEqual(h.creations[0].reasons, ['AUDIO_PLAYBACK']);
  assert.equal(h.creations[0].url, 'audio-offscreen.html');
  await h.player.stop('tab-2/new');
});

test('existing offscreen documents are reused and play waits until the audio has started', async () => {
  const h = playbackHarness({ getContexts: async () => [{ contextId: 'audio', documentUrl: origin + 'audio-offscreen.html', contextType: 'OFFSCREEN_DOCUMENT' }] });
  let completed = false;
  const request = h.player.play('tab/current', audio).then(() => { completed = true; });
  await tick();
  assert.equal(h.creations.length, 0);
  assert.equal(completed, false);
  h.offscreen.pending[0].resolve();
  await request;
  assert.equal(completed, true);
  await h.player.stop('tab/current');
});

test('stop during offscreen creation prevents a delayed ensure from starting sound', async () => {
  const ready = deferred();
  const h = playbackHarness({ createDocument: () => ready.promise });
  const request = h.player.play('old', audio);
  const rejected = assert.rejects(request, failure('CANCELLED'));
  await tick();
  await h.player.stop('old');
  ready.resolve();
  await tick();
  await rejected;
  assert.equal(h.offscreen.instances.length, 0);
});

test('aborting before and after playback cancels promptly, and old scopes cannot stop a newer sound', async () => {
  const h = playbackHarness();
  const early = new AbortController(); early.abort();
  await assert.rejects(h.player.play('aborted', audio, { signal: early.signal }), failure('CANCELLED'));
  assert.equal(h.creations.length, 0);
  const owner = new AbortController();
  const first = h.player.play('old', audio, { signal: owner.signal });
  await tick(); h.offscreen.pending[0].resolve(); await first;
  const next = h.player.play('new', audio);
  await tick(); h.offscreen.pending[1].resolve(); await next;
  owner.abort(); await h.player.stop('old');
  assert.equal(h.offscreen.instances[1].paused, false);
  await h.player.stop('new');
  assert.equal(h.offscreen.instances[1].paused, true);
  const live = new AbortController();
  const third = h.player.play('third', audio, { signal: live.signal });
  await tick(); h.offscreen.pending[2].resolve(); await third;
  live.abort(); await tick();
  assert.equal(h.offscreen.instances[2].paused, true);
});

test('new attempts in one scope have distinct tokens and delayed play acknowledgements cannot revive old audio', async () => {
  const h = playbackHarness();
  const first = h.player.play('same', audio);
  const rejected = assert.rejects(first, failure('CANCELLED'));
  await tick();
  const next = h.player.play('same', audio);
  await tick();
  assert.equal(h.offscreen.instances[0].paused, true);
  const plays = h.messages.filter(message => message.type === 'IT_AUDIO_PLAY');
  assert.notEqual(plays[0].token, plays[1].token);
  h.offscreen.pending[1].resolve(); await next;
  h.offscreen.pending[0].resolve(); await rejected;
  assert.equal(h.offscreen.instances[1].paused, false);
  assert.equal(h.offscreen.instances[0].paused, true);
  await h.player.stop('same');
});

test('unsupported media, empty base64, malformed base64 and data URLs above 3 MB never reach an audio sink', async () => {
  const h = playbackHarness();
  for (const dataUrl of ['https://audio.test/a.mp3', 'data:text/html;base64,SUQz', 'data:audio/mpeg;base64,', 'data:audio/mpeg;base64,$$$$', 'data:audio/mpeg;base64,AAA', 'data:audio/wav;base64,' + 'A'.repeat(3_000_000)]) {
    await assert.rejects(h.player.play('invalid', dataUrl), failure('INPUT'));
  }
  assert.equal(h.creations.length, 0);
  assert.equal(h.messages.length, 0);
  for (const scope of ['', null, 12]) await assert.rejects(h.player.play(scope, audio), failure('INPUT'));
});

test('audio decoder rejection reaches the caller and a later request can recover', async () => {
  const h = playbackHarness();
  const request = h.player.play('bad', audio);
  await tick();
  h.offscreen.pending[0].reject(new DOMException('Not supported', 'NotSupportedError'));
  await assert.rejects(request, failure('AUDIO'));
  assert.equal(h.offscreen.instances[0].paused, true);
  const recovery = h.player.play('good', audio);
  await tick(); h.offscreen.pending[1].resolve(); await recovery;
  await h.player.stop('good');
});

test('aborted pending play replies are ignored and unavailable offscreen support fails with a usable error', async () => {
  const reply = deferred();
  const h = playbackHarness({ sendMessage: message => message.type === 'IT_AUDIO_PLAY' ? reply.promise : Promise.resolve({ ok: true, token: message.token }) });
  const controller = new AbortController();
  const request = h.player.play('pending', audio, { signal: controller.signal });
  await tick(); controller.abort();
  await assert.rejects(request, failure('CANCELLED'));
  reply.resolve({ ok: true, token: h.messages[0].token });
  await tick();
  assert.equal(h.messages.filter(message => message.type === 'IT_AUDIO_PLAY').length, 1);
  const player = createAudioPlayback({ runtime: { getURL: file => origin + file } });
  await assert.rejects(player.play('unsupported', audio), failure('AUDIO'));
});

test('offscreen rejects web content scripts, other extension pages and other extensions before playing anything', async () => {
  const h = offscreenHarness();
  for (const from of [undefined, { id: 'other', url: sender.url }, { ...sender, tab: { id: 1 } }, { ...sender, url: 'https://page.test/' }, { ...sender, url: origin + 'popup.html' }, { id: 'test-extension' }]) {
    const response = await h.dispatch(playMessage('untrusted'), from === undefined ? null : from);
    assert.equal(response?.ok, false);
    assert.equal(response.error.code, 'FORBIDDEN');
  }
  assert.equal(h.instances.length, 0);
  assert.equal(await h.dispatch({ type: 'IT_AUDIO_PLAY', token: 'unrouted', dataUrl: audio }), undefined);
  assert.equal(h.instances.length, 0);
});

test('offscreen validates audio payload and stop tokens cannot stop a different owner', async () => {
  const h = offscreenHarness();
  const invalid = await h.dispatch(playMessage('invalid', 'https://audio.test/track.mp3'));
  assert.equal(invalid.error.code, 'INPUT');
  assert.equal(h.instances.length, 0);
  const first = h.dispatch(playMessage('first'));
  h.pending[0].resolve(); await first;
  const next = h.dispatch(playMessage('next'));
  h.pending[1].resolve(); await next;
  await h.dispatch(stopMessage('first'));
  assert.equal(h.instances[1].paused, false);
  await h.dispatch(stopMessage('next'));
  assert.equal(h.instances[1].paused, true);
});

test('offscreen invalidates delayed audio owners and a stop arriving before its play cannot resurrect it', async () => {
  const h = offscreenHarness();
  const first = h.dispatch(playMessage('slow'));
  const next = h.dispatch(playMessage('fast'));
  h.pending[1].resolve(); assert.equal((await next).ok, true);
  h.pending[0].resolve();
  assert.equal((await first).error.code, 'CANCELLED');
  assert.equal(h.instances[0].paused, true);
  assert.equal(h.instances[1].paused, false);
  await h.dispatch(stopMessage('late'));
  const late = await h.dispatch(playMessage('late'));
  assert.equal(late.error.code, 'CANCELLED');
  assert.equal(h.instances.length, 2);
  await h.dispatch(stopMessage('fast'));
});

test('offscreen cancellation settles pending start promises even when Audio.play never settles', async () => {
  const h = offscreenHarness();
  const request = h.dispatch(playMessage('stalled'));
  await h.dispatch(stopMessage('stalled'));
  assert.equal((await request).error.code, 'CANCELLED');
  assert.equal(h.instances[0].paused, true);
});

test('startup timeout bounds a stalled offscreen ensure and its late completion cannot start sound', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const ready = deferred();
  const h = playbackHarness({ createDocument: () => ready.promise });
  const request = h.player.play('slow-create', audio);
  const rejection = assert.rejects(request, failure('TIMEOUT'));
  await tick();
  context.mock.timers.tick(15000);
  await rejection;
  ready.resolve(); await tick();
  assert.equal(h.messages.length, 0);
  assert.equal(h.offscreen.instances.length, 0);
});

test('offscreen timeout pauses an audio decoder that never starts and responds with a controlled error', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const h = offscreenHarness();
  const request = h.dispatch(playMessage('decoder-timeout'));
  context.mock.timers.tick(12000);
  assert.equal((await request).error.code, 'TIMEOUT');
  assert.equal(h.instances[0].paused, true);
  h.pending[0].resolve(); await tick();
  assert.equal(h.instances[0].paused, true);
});

test('startup timeout stops an unresponsive runtime request without accepting a late success', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const reply = deferred();
  const h = playbackHarness({ sendMessage: message => message.type === 'IT_AUDIO_PLAY' ? reply.promise : Promise.resolve({ ok: true, token: message.token }) });
  const request = h.player.play('slow-runtime', audio);
  const rejection = assert.rejects(request, failure('TIMEOUT'));
  await tick();
  context.mock.timers.tick(15000); await rejection; await tick();
  const start = h.messages.find(message => message.type === 'IT_AUDIO_PLAY');
  assert.equal(h.messages.some(message => message.type === 'IT_AUDIO_STOP' && message.token === start.token), true);
  reply.resolve({ ok: true, token: start.token }); await tick();
  assert.equal(h.messages.filter(message => message.type === 'IT_AUDIO_PLAY').length, 1);
});

test('failed creation releases the shared ensure so the next request can retry', async () => {
  let attempts = 0;
  const h = playbackHarness({ createDocument: async () => { if (++attempts === 1) throw new Error('Offscreen unavailable'); } });
  await assert.rejects(h.player.play('first', audio), failure('AUDIO'));
  const next = h.player.play('next', audio);
  await tick(); h.offscreen.pending[0].resolve(); await next;
  assert.equal(h.creations.length, 2);
  await h.player.stop('next');
});

test('wrong or missing playback acknowledgements are failures and stop the corresponding attempt', async () => {
  for (const response of [undefined, { ok: true, token: 'another-attempt' }, { ok: false, error: { code: 'FORBIDDEN', message: 'internal details' } }]) {
    const h = playbackHarness({ sendMessage: message => message.type === 'IT_AUDIO_PLAY' ? response : { ok: true, token: message.token } });
    await assert.rejects(h.player.play('scope', audio), failure('AUDIO'));
    await tick();
    const start = h.messages.find(message => message.type === 'IT_AUDIO_PLAY');
    assert.equal(h.messages.some(message => message.type === 'IT_AUDIO_STOP' && message.token === start.token), true);
  }
});
