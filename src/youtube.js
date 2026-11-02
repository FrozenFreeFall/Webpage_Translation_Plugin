(() => {
  'use strict';
  // This controller reads only YouTube's rendered captions, in the extension's
  // isolated world. It never reaches into player APIs or requests audio/tracks.
  if (globalThis.__IT_YOUTUBE__ || window.top !== window || !/^https?:$/.test(location.protocol) || !['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(location.hostname)) return;

  const CAPTIONS = '.ytp-caption-segment';
  const CAPTION_UI = '.ytp-caption-segment,.caption-window,.caption-window-container,.ytp-subtitles-button';
  const listeners = new Set(), cache = new Map();
  let active = false, state = 'off', message = '', disposed = false;
  let player = null, host = null, toggleButton = null, translation = null, statusBox = null, statusMessage = null;
  let playerObserver = null, resizeObserver = null, video = null;
  let activation = 0, generation = 0, cueVersion = 0, config = null, sessionId = null, blocked = false, nativeCCOwner = null;
  let currentCue = '', currentLanguage = '', observedCue = '', observedLanguage = '', displayedItem = null, queued = null, running = false, seeking = false, ccDisabled = false;
  let cueTimer = null, maxCueTimer = null, missingTimer = null, reconcileTimer = null, interval = null, lastURL = location.href;

  function isSupported() { return location.pathname === '/watch' && Boolean(new URL(location.href).searchParams.get('v')); }
  function getStatus() { return { active, state, message }; }
  function update(nextState = state, nextMessage = '') {
    state = nextState; message = nextMessage;
    if (toggleButton) {
      toggleButton.setAttribute('aria-label', active ? '关闭字幕翻译' : '开启字幕翻译');
      toggleButton.setAttribute('aria-pressed', String(active));
      toggleButton.title = active ? '关闭字幕翻译' : '开启字幕翻译';
      toggleButton.dataset.state = state;
    }
    if (statusBox) {
      statusBox.hidden = !active || !message;
      statusMessage.textContent = message;
      statusBox.querySelector('.retry').hidden = state !== 'error';
    }
    for (const listener of listeners) { try { listener(getStatus()); } catch { /* A consumer must not interrupt caption cleanup. */ } }
  }
  async function send(payload) {
    try { return await chrome.runtime.sendMessage(payload); }
    catch { return { ok: false, error: { code: 'CONNECTION', message: '无法连接扩展后台，请刷新网页后重试。', fatal: true } }; }
  }
  function friendly(error) { return typeof error?.message === 'string' && error.message.trim() ? error.message.slice(0, 240) : '字幕翻译失败，请重试或检查翻译设置。'; }
  function cancelSession() {
    const previous = sessionId; sessionId = null;
    if (previous) void send({ type: 'IT_CANCEL_SESSION', sessionId: previous });
  }
  function clearTranslation() {
    displayedItem = null;
    if (!translation) return;
    translation.hidden = true; translation.textContent = '';
  }
  function invalidate() {
    generation++; cueVersion++; queued = null; currentCue = ''; currentLanguage = ''; observedCue = ''; observedLanguage = '';
    clearTimeout(cueTimer); clearTimeout(maxCueTimer); clearTimeout(missingTimer); cueTimer = maxCueTimer = missingTimer = null;
    clearTranslation(); cancelSession();
  }
  function stop() {
    active = false; activation++; blocked = false; seeking = false; ccDisabled = false;
    restoreNativeCC();
    invalidate(); config = null; update('off');
  }
  function restoreNativeCC() {
    const owned = nativeCCOwner; nativeCCOwner = null;
    // Navigation may reuse a button for another video. Restore only the same
    // live player and URL whose CC state this activation changed.
    if (owned && owned.url === location.href && owned.player === player && document.querySelector('#movie_player') === owned.player && owned.button.isConnected && owned.player.contains(owned.button) && owned.button.getAttribute('aria-pressed') === 'true') owned.button.click();
  }
  function onNativeCCClick(event) {
    if (event.isTrusted && event.target.closest?.('.ytp-subtitles-button')) nativeCCOwner = null;
  }
  function routeCheck() {
    if (location.href === lastURL) return false;
    lastURL = location.href; stop(); cache.clear();
    return true;
  }
  function visible(element) {
    if (!element.isConnected || !element.getClientRects().length || element.closest('[hidden],[aria-hidden="true"]')) return false;
    const css = getComputedStyle(element);
    return css.display !== 'none' && css.visibility !== 'hidden' && css.visibility !== 'collapse' && css.opacity !== '0';
  }
  function readCue() {
    if (!player) return { text: '', language: '' };
    const segments = Array.from(player.querySelectorAll(CAPTIONS)).filter(visible);
    return {
      text: segments.map(segment => segment.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' '),
      language: segments[0]?.closest('[lang]')?.getAttribute('lang') || '',
    };
  }
  function positionTranslation() {
    if (!player || !translation || translation.hidden) return;
    const bounds = player.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const segments = Array.from(player.querySelectorAll(CAPTIONS)).filter(visible);
    const nativeBottom = segments.length ? Math.max(...segments.map(segment => segment.getBoundingClientRect().bottom)) - bounds.top : bounds.height - 90;
    // Leave native caption layout untouched. The additional line follows its
    // current position, including YouTube's dragged captions and fullscreen.
    translation.style.top = `${Math.max(8, Math.min(nativeBottom + 5, bounds.height - translation.offsetHeight - 8))}px`;
  }
  function remember(key, text) {
    cache.delete(key); cache.set(key, text);
    if (cache.size > 200) cache.delete(cache.keys().next().value);
  }
  function cacheKey(item) { return JSON.stringify([config?.revision, config?.provider, config?.targetLanguage, new URL(location.href).searchParams.get('v'), item.language, item.text]); }
  function visiblePrefix(prefix, text) {
    if (prefix === text) return true;
    if (!prefix || !text.startsWith(prefix)) return false;
    // Growing auto-captions may retain a completed phrase. Never treat part of
    // a word ("cat" in "catch") as an unchanged source phrase.
    return !/[\p{L}\p{N}_]$/u.test(prefix) || !/^[\p{L}\p{N}_]/u.test(text.slice(prefix.length));
  }
  function trackCue(cue) {
    if (cue.text === observedCue && cue.language === observedLanguage) return;
    if (observedCue && (cue.language !== observedLanguage || !visiblePrefix(observedCue, cue.text))) {
      cueVersion++; queued = null; clearTranslation();
    }
    observedCue = cue.text; observedLanguage = cue.language;
  }
  function current(item) {
    if (routeCheck() || !active || disposed || seeking || ccDisabled || item.generation !== generation || item.version !== cueVersion || !player?.isConnected || player.querySelector('.ytp-subtitles-button')?.getAttribute('aria-pressed') === 'false') return false;
    const cue = readCue();
    return visiblePrefix(item.text, cue.text) && cue.language === item.language;
  }
  function show(text, item) {
    if (!current(item)) return;
    displayedItem = item;
    translation.textContent = text; translation.lang = config?.targetLanguage || 'zh-CN'; translation.hidden = false;
    positionTranslation(); update('translated');
  }
  function configured(value) { return value?.configured === true; }
  function configurationError(value) {
    return value?.provider === 'libretranslate' ? '请先在设置中填写 LibreTranslate 服务地址。' : '请在设置中选择免费翻译，或配置 AI 服务及 API Key。';
  }
  async function ensureSession(item) {
    if (sessionId) return sessionId;
    const id = crypto.randomUUID(); sessionId = id;
    const response = await send({ type: 'IT_START_SESSION', sessionId: id });
    if (!current(item)) return null;
    if (!response?.ok || !configured(response.config)) {
      blocked = true; cancelSession();
      update('error', response?.ok ? configurationError(response.config) : friendly(response?.error));
      return null;
    }
    if (config?.revision !== response.config.revision || config?.targetLanguage !== response.config.targetLanguage) cache.clear();
    config = response.config;
    return id;
  }
  async function drain() {
    if (running) return;
    running = true;
    try {
      while (active && queued && !blocked) {
        const item = queued; queued = null;
        if (!current(item)) continue;
        let key = cacheKey(item);
        if (cache.has(key)) { const saved = cache.get(key); remember(key, saved); show(saved, item); continue; }
        update('translating');
        const id = await ensureSession(item);
        if (!id || !current(item)) continue;
        key = cacheKey(item);
        const response = await send({ type: 'IT_TRANSLATE', sessionId: id, segments: [{ id: 'cue', text: item.text }] });
        // A fatal reply ends the entire backend session, even when its cue is
        // obsolete. Never let a later cue reuse that aborted session. Replies
        // from an earlier seek/activation cannot affect the current session.
        if (!response?.ok && response?.error?.fatal && !routeCheck() && active && item.generation === generation && id === sessionId) {
          blocked = true; queued = null; clearTranslation(); cancelSession(); update('error', friendly(response.error)); continue;
        }
        if (id !== sessionId || !current(item)) continue;
        if (!response?.ok) {
          update('error', friendly(response?.error)); continue;
        }
        const values = response.translations?.filter(value => value.id === 'cue');
        const text = values?.length === 1 && typeof values[0].text === 'string' ? values[0].text.trim() : '';
        if (!text) { update('error', friendly(response.failures?.find(value => value.id === 'cue')?.error)); continue; }
        remember(key, text); show(text, item);
      }
    } catch {
      if (active) { blocked = true; update('error', '字幕翻译未完成，请重试或刷新网页。'); }
    } finally {
      running = false;
      if (active && queued && !blocked) void drain();
    }
  }
  function waitForCaptions() {
    if (missingTimer) return;
    missingTimer = setTimeout(() => {
      missingTimer = null;
      if (active && !seeking && !blocked && !readCue().text) update('error', '未检测到 YouTube 字幕。请开启 CC 或选择可用字幕；本功能不识别音频。');
    }, 2500);
  }
  function capture() {
    clearTimeout(cueTimer); clearTimeout(maxCueTimer); cueTimer = maxCueTimer = null;
    if (routeCheck() || !active || disposed || seeking || blocked || !config) return;
    if (!player?.isConnected) { clearTranslation(); update('waiting', '等待 YouTube 播放器和字幕…'); return; }
    const cc = player.querySelector('.ytp-subtitles-button');
    if (cc?.getAttribute('aria-pressed') === 'false') {
      if (!ccDisabled) invalidate();
      ccDisabled = true; update('error', 'YouTube 字幕已关闭。请开启播放器 CC 字幕，或点击重试。'); return;
    }
    if (ccDisabled) { ccDisabled = false; currentCue = ''; }
    const cue = readCue();
    trackCue(cue);
    if (!cue.text) {
      if (currentCue) { cueVersion++; queued = null; currentCue = ''; currentLanguage = ''; }
      clearTranslation();
      if (!cc || cc.getAttribute('aria-disabled') === 'true') update('error', '此视频暂无可用字幕。请在 YouTube 中选择带字幕的视频；本功能不识别音频。');
      else { update('waiting'); waitForCaptions(); }
      return;
    }
    clearTimeout(missingTimer); missingTimer = null;
    if (cue.text === currentCue && cue.language === currentLanguage) { positionTranslation(); return; }
    currentCue = cue.text; currentLanguage = cue.language; queued = null;
    if (!displayedItem || !current(displayedItem)) clearTranslation();
    if (cue.text.length > 3000) { clearTranslation(); update('error', '当前字幕超过 3000 字符，已跳过。请切换为较短的字幕后重试。'); return; }
    queued = { ...cue, generation, version: cueVersion }; void drain();
  }
  function scheduleCapture() {
    if (!active || seeking) return;
    clearTimeout(cueTimer); cueTimer = null;
    if (player?.querySelector('.ytp-subtitles-button')?.getAttribute('aria-pressed') === 'false') { nativeCCOwner = null; clearTranslation(); capture(); return; }
    // Retain only a translation whose complete source prefix is still visible.
    // Replacement/clearing invalidates the epoch before any response can render.
    const cue = readCue();
    trackCue(cue);
    if (displayedItem && !current(displayedItem)) clearTranslation();
    cueTimer = setTimeout(capture, 300);
    if (!maxCueTimer) maxCueTimer = setTimeout(capture, 1000);
  }
  async function toggle() {
    routeCheck();
    if (active) { stop(); return; }
    if (!isSupported() || disposed) return;
    active = true; activation++; blocked = false; invalidate();
    reconcile(); update('waiting', '等待 YouTube 字幕…');
    const token = activation;
    const cc = player?.querySelector('.ytp-subtitles-button');
    // This follows an explicit extension button click; playback is untouched.
    if (cc?.getAttribute('aria-pressed') === 'false' && cc.getAttribute('aria-disabled') !== 'true') {
      cc.click();
      if (cc.getAttribute('aria-pressed') === 'true') nativeCCOwner = { button: cc, player, url: location.href };
    }
    const response = await send({ type: 'IT_GET_PUBLIC_CONFIG' });
    if (routeCheck() || !active || token !== activation) return;
    if (!response?.ok || !configured(response.config)) {
      blocked = true; update('error', response?.ok ? configurationError(response.config) : friendly(response?.error)); return;
    }
    config = response.config; scheduleCapture();
  }
  function onSeeking() {
    if (!active) return;
    invalidate(); seeking = true; update('waiting');
  }
  function onSeeked() { seeking = false; if (active) scheduleCapture(); }
  function bindVideo() {
    const next = player?.querySelector('video') || null;
    if (next === video) return;
    if (video) { video.removeEventListener('seeking', onSeeking); video.removeEventListener('seeked', onSeeked); }
    video = next;
    if (video) { video.addEventListener('seeking', onSeeking); video.addEventListener('seeked', onSeeked); }
  }
  function detachPlayer() {
    playerObserver?.disconnect(); resizeObserver?.disconnect(); playerObserver = resizeObserver = null;
    player?.removeEventListener('click', onNativeCCClick, true); nativeCCOwner = null;
    if (video) { video.removeEventListener('seeking', onSeeking); video.removeEventListener('seeked', onSeeked); video = null; }
    host?.remove(); host = toggleButton = translation = statusBox = statusMessage = null; player = null;
  }
  function attachPlayer(next) {
    const ownership = nativeCCOwner?.player === next && nativeCCOwner.button === next.querySelector('.ytp-subtitles-button') && nativeCCOwner.url === location.href ? nativeCCOwner : null;
    detachPlayer(); player = next; nativeCCOwner = ownership;
    host = document.createElement('div'); host.className = 'it-youtube-host'; host.setAttribute('data-it-translation', 'youtube');
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      :host{all:initial!important;position:absolute!important;inset:0!important;display:block!important;z-index:60!important;pointer-events:none!important;font:14px/1.45 system-ui,sans-serif!important;color:#fff!important;color-scheme:dark!important}
      *{box-sizing:border-box}button{font:inherit;cursor:pointer;pointer-events:auto}button:focus-visible{outline:3px solid #ffd975;outline-offset:3px}[hidden]{display:none!important}
      .toggle{position:absolute;right:14px;top:14px;display:grid;place-items:center;width:36px;height:32px;padding:0;border:1px solid #ffffff75;border-radius:7px;background:#101820c9;color:#fff;font-size:17px;font-weight:650;box-shadow:0 2px 8px #0004}
      .toggle[aria-pressed=true]{background:#e7f4e7;color:#174b26;border-color:#b7d7b8}.toggle[data-state=translating]{border-color:#ffd975}
      .translation{position:absolute;left:50%;transform:translateX(-50%);width:max-content;max-width:92%;padding:3px 10px;border-radius:4px;background:#000b;color:#fff;text-align:center;white-space:pre-wrap;overflow-wrap:anywhere;font-size:clamp(17px,2.2vw,30px);line-height:1.35;text-shadow:0 1px 2px #000;pointer-events:none}
      .status{position:absolute;right:14px;top:54px;max-width:min(360px,calc(100% - 28px));padding:10px 12px;border:1px solid #ffffff45;border-radius:7px;background:#101820ed;color:#fff;font-size:13px;pointer-events:auto}.message{margin:0 0 8px;white-space:normal}.actions{display:flex;gap:8px}.actions button{padding:3px 9px;border:1px solid #ffffff80;border-radius:4px;background:#fff1;color:#fff}
      @media(max-width:640px){.translation{font-size:18px}.toggle{top:10px;right:10px}}
    `;
    toggleButton = document.createElement('button'); toggleButton.className = 'toggle'; toggleButton.type = 'button'; toggleButton.textContent = '译';
    translation = document.createElement('div'); translation.className = 'translation'; translation.hidden = true; translation.setAttribute('aria-live', 'off');
    statusBox = document.createElement('div'); statusBox.className = 'status'; statusBox.hidden = true; statusBox.setAttribute('role', 'status');
    statusMessage = document.createElement('p'); statusMessage.className = 'message';
    const actions = document.createElement('div'); actions.className = 'actions';
    const retry = document.createElement('button'); retry.className = 'retry'; retry.type = 'button'; retry.textContent = '重试';
    const settings = document.createElement('button'); settings.className = 'settings'; settings.type = 'button'; settings.textContent = '设置';
    actions.append(retry, settings); statusBox.append(statusMessage, actions); shadow.append(style, toggleButton, translation, statusBox); player.append(host);
    for (const control of [toggleButton, retry, settings]) {
      control.addEventListener('keydown', event => event.stopPropagation());
      control.addEventListener('keyup', event => event.stopPropagation());
    }
    player.addEventListener('click', onNativeCCClick, true);
    toggleButton.addEventListener('click', event => { if (event.isTrusted) { event.stopPropagation(); void toggle(); } });
    retry.addEventListener('click', event => { if (event.isTrusted) { event.stopPropagation(); stop(); void toggle(); } });
    settings.addEventListener('click', event => { if (!event.isTrusted) return; event.stopPropagation(); void send({ type: 'IT_OPEN_OPTIONS' }).then(result => { if (!result?.ok && active) update('error', friendly(result?.error)); }); });
    playerObserver = new MutationObserver(mutations => {
      if (routeCheck()) return;
      const relevant = mutations.some(mutation => {
        const element = mutation.target.nodeType === Node.ELEMENT_NODE ? mutation.target : mutation.target.parentElement;
        if (element?.closest('.it-youtube-host')) return false;
        if (element?.closest(CAPTION_UI)) return true;
        return mutation.type === 'childList' && [...mutation.addedNodes, ...mutation.removedNodes].some(node => node.nodeType === Node.ELEMENT_NODE && (node.matches(CAPTION_UI) || node.querySelector(CAPTION_UI)));
      });
      if (relevant) scheduleCapture();
      bindVideo();
    });
    playerObserver.observe(player, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['aria-pressed', 'aria-disabled', 'hidden', 'aria-hidden', 'style', 'class', 'lang'] });
    if (typeof ResizeObserver === 'function') { resizeObserver = new ResizeObserver(positionTranslation); resizeObserver.observe(player); }
    bindVideo(); update();
  }
  function reconcile() {
    reconcileTimer = null; routeCheck();
    const next = !disposed && isSupported() ? document.querySelector('#movie_player') : null;
    if (next === player && (!host || host.isConnected)) { bindVideo(); return; }
    const wasActive = active;
    if (wasActive) { invalidate(); update('waiting', '等待 YouTube 播放器和字幕…'); }
    if (next) attachPlayer(next); else detachPlayer();
    if (wasActive && next) scheduleCapture();
  }
  const documentObserver = new MutationObserver(() => {
    if (!reconcileTimer) reconcileTimer = setTimeout(reconcile, 0);
  });
  documentObserver.observe(document.documentElement, { subtree: true, childList: true });
  chrome.runtime.onMessage.addListener(payload => { if (payload?.type === 'IT_CONFIG_CHANGED') { stop(); cache.clear(); } return false; });
  addEventListener('popstate', reconcile); addEventListener('hashchange', reconcile);
  document.addEventListener('yt-navigate-start', () => { stop(); cache.clear(); }, true);
  document.addEventListener('yt-navigate-finish', reconcile, true);
  addEventListener('fullscreenchange', positionTranslation);
  addEventListener('pagehide', () => { disposed = true; stop(); cache.clear(); clearInterval(interval); detachPlayer(); });
  addEventListener('pageshow', () => { if (disposed) { disposed = false; lastURL = location.href; reconcile(); interval = setInterval(reconcile, 500); } });
  Object.defineProperty(globalThis, '__IT_YOUTUBE__', { value: Object.freeze({ isSupported, toggle, getStatus, stop, subscribe(listener) { if (typeof listener !== 'function') return () => {}; listeners.add(listener); try { listener(getStatus()); } catch {} return () => listeners.delete(listener); } }), configurable: false });
  reconcile(); interval = setInterval(reconcile, 500);
})();
