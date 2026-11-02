import { TranslationError } from './shared.js';

const TARGET = 'it-audio-offscreen';
const START_TIMEOUT = 15000;
const audioError = () => new TranslationError('AUDIO', '发音播放失败，请重试。');
const cancelled = () => new TranslationError('CANCELLED', '本次发音已结束。');

// Keep the same bounded, non-network media boundary in the worker and document.
export function isAudioDataURL(value) {
  if (typeof value !== 'string' || value.length > 3_000_000) return false;
  const prefix = /^data:audio\/(?:mpeg|mp3|ogg|wav|x-wav|webm|mp4);base64,/.exec(value);
  if (!prefix) return false;
  const body = value.slice(prefix[0].length);
  return body.length > 0 && body.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(body);
}

export function createAudioPlayback(api) {
  let ensuring;
  let current;

  function ensureDocument() {
    if (!ensuring) {
      ensuring = (async () => {
        if (!api.offscreen?.createDocument || !api.runtime?.getContexts || !api.runtime?.sendMessage) throw audioError();
        const contexts = await api.runtime.getContexts({
          contextTypes: ['OFFSCREEN_DOCUMENT'],
          documentUrls: [api.runtime.getURL('audio-offscreen.html')],
        });
        if (!contexts.length) await api.offscreen.createDocument({
          url: 'audio-offscreen.html', reasons: ['AUDIO_PLAYBACK'],
          justification: 'Play a pronunciation explicitly requested by the user outside webpage media restrictions.',
        });
      })().finally(() => { ensuring = undefined; });
    }
    return ensuring;
  }

  async function sendStop(token) {
    // A destroyed/offline document must never leave cancellation waiting forever.
    let timer;
    try {
      await Promise.race([
        Promise.resolve().then(() => api.runtime.sendMessage({ target: TARGET, type: 'IT_AUDIO_STOP', token })),
        new Promise(resolve => { timer = setTimeout(resolve, 2000); }),
      ]);
    } catch {} finally { clearTimeout(timer); }
  }

  function cancel(owner, reason = cancelled()) {
    if (current === owner) current = undefined;
    clearTimeout(owner.timer);
    owner.signal?.removeEventListener('abort', owner.abort);
    owner.reject(reason);
    if (!owner.stopping) owner.stopping = owner.sent ? sendStop(owner.token) : Promise.resolve();
    return owner.stopping;
  }

  function play(scope, dataUrl, { signal } = {}) {
    if (typeof scope !== 'string' || !scope || scope.length > 1024 || !isAudioDataURL(dataUrl)) {
      return Promise.reject(new TranslationError('INPUT', '发音内容无效，请重试。'));
    }
    if (signal?.aborted) return Promise.reject(cancelled());
    if (current) void cancel(current);
    let resolve, reject;
    const result = new Promise((yes, no) => { resolve = yes; reject = no; });
    const owner = { scope, token: crypto.randomUUID(), signal, resolve, reject, sent: false };
    current = owner;
    owner.abort = () => { void cancel(owner); };
    owner.timer = setTimeout(() => { void cancel(owner, new TranslationError('TIMEOUT', '发音播放超时，请重试。')); }, START_TIMEOUT);
    signal?.addEventListener('abort', owner.abort, { once: true });
    void (async () => {
      try {
        await ensureDocument();
        if (current !== owner || signal?.aborted) throw cancelled();
        owner.sent = true;
        const response = await api.runtime.sendMessage({ target: TARGET, type: 'IT_AUDIO_PLAY', token: owner.token, dataUrl });
        if (current !== owner || signal?.aborted) throw cancelled();
        if (!response || response.token !== owner.token || response.ok !== true) {
          const code = response?.error?.code;
          if (code === 'CANCELLED') throw cancelled();
          if (code === 'TIMEOUT') throw new TranslationError('TIMEOUT', '发音播放超时，请重试。');
          throw audioError();
        }
        clearTimeout(owner.timer);
        owner.resolve();
        // Retain the abort listener after startup: selection cancellation also
        // stops sound which has already begun, without affecting a newer owner.
      } catch (error) {
        if (current === owner) void cancel(owner, error instanceof TranslationError ? error : audioError());
      }
    })();
    return result;
  }

  async function stop(scope) {
    if (current?.scope === scope) await cancel(current);
  }
  return { play, stop };
}
