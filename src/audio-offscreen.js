import { isAudioDataURL } from './audio-playback.js';

const TARGET = 'it-audio-offscreen';
const validToken = value => typeof value === 'string' && /^[A-Za-z0-9:_-]{1,160}$/.test(value);
const responseError = (token, code, message) => ({ ok: false, token, error: { code, message } });

export function installAudioOffscreen(api, AudioClass = globalThis.Audio) {
  let current;
  // An offscreen document is closed by Chrome after 30 seconds without audio.
  // Tombstones also reject a STOP delivered before its corresponding PLAY.
  const retired = new Set();

  function release(owner, code = 'CANCELLED', message = '本次发音已结束。') {
    if (current === owner) current = undefined;
    retired.add(owner.token);
    clearTimeout(owner.timer);
    owner.audio.removeEventListener('ended', owner.ended);
    owner.audio.removeEventListener('error', owner.error);
    try { owner.audio.pause(); owner.audio.removeAttribute('src'); owner.audio.load(); } catch {}
    owner.respond(responseError(owner.token, code, message));
  }

  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.target !== TARGET) return false;
    const token = validToken(message.token) ? message.token : '';
    if (sender?.id !== api.runtime.id || sender.url !== api.runtime.getURL('src/background.js') || sender.tab !== undefined) {
      sendResponse(responseError(token, 'FORBIDDEN', '此页面无权执行该操作。'));
      return false;
    }
    if (!token || !['IT_AUDIO_PLAY', 'IT_AUDIO_STOP'].includes(message.type)) {
      sendResponse(responseError(token, 'INPUT', '发音请求无效。'));
      return false;
    }
    if (message.type === 'IT_AUDIO_STOP') {
      retired.add(token);
      if (current?.token === token) release(current);
      sendResponse({ ok: true, token });
      return false;
    }
    if (!isAudioDataURL(message.dataUrl)) {
      sendResponse(responseError(token, 'INPUT', '发音内容无效。'));
      return false;
    }
    if (retired.has(token) || current?.token === token) {
      sendResponse(responseError(token, 'CANCELLED', '本次发音已结束。'));
      return false;
    }
    if (current) release(current);
    let audio;
    try { audio = new AudioClass(message.dataUrl); }
    catch { sendResponse(responseError(token, 'AUDIO', '发音播放失败，请重试。')); return false; }
    let responded = false;
    const owner = { token, audio, respond: value => { if (!responded) { responded = true; sendResponse(value); } } };
    current = owner;
    owner.ended = () => release(owner);
    owner.error = () => release(owner, 'AUDIO', '发音格式不可用，请重试。');
    audio.addEventListener('ended', owner.ended);
    audio.addEventListener('error', owner.error);
    owner.timer = setTimeout(() => release(owner, 'TIMEOUT', '发音播放超时，请重试。'), 12000);
    try {
      Promise.resolve(audio.play()).then(() => {
        if (current !== owner || retired.has(token)) return;
        clearTimeout(owner.timer);
        owner.respond({ ok: true, token });
      }, () => { if (current === owner) owner.error(); });
    } catch { owner.error(); }
    return true;
  });
}

if (globalThis.chrome?.runtime?.onMessage) installAudioOffscreen(globalThis.chrome);
