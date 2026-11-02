(() => {
  'use strict';
  if (globalThis.__IT_SELECTION__ || window.top !== window || !/^https?:$/.test(location.protocol) || document.contentType === 'application/pdf' || /\.pdf$/i.test(location.pathname)) return;
  globalThis.__IT_SELECTION__ = true;
  const SKIP = 'script,style,noscript,template,input,textarea,select,option,button,iframe,canvas,svg,math,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[data-it-translation],#it-translation-root,#it-selection-root,#movie_player,.html5-video-player,.it-youtube-host';
  const names = { microsoft: '微软免费', google: '谷歌免费', libretranslate: 'LibreTranslate', ai: 'AI 自定义' };
  const parts = { noun: 'n. 名词', verb: 'v. 动词', adjective: 'adj. 形容词', adverb: 'adv. 副词', pronoun: 'pron. 代词', preposition: 'prep. 介词', conjunction: 'conj. 连词', interjection: 'interj. 感叹词', exclamation: '感叹词', determiner: '限定词', article: '冠词' };
  let config = { selectionEnabled: true }, snapshot = null, current = null, serial = 0, audioSerial = 0, audio = null, audioButton = null, utterance = null, voiceWaitCleanup = null, debounce, disposed = false, lastURL = location.href;
  const host = document.createElement('div');
  host.id = 'it-selection-root';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host{all:initial!important;position:fixed!important;top:0!important;left:0!important;width:0!important;height:0!important;z-index:2147483646!important;pointer-events:none!important;color-scheme:light!important;font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif!important}
    *,*::before,*::after{box-sizing:border-box} [hidden]{display:none!important}
    button,a{font:inherit}button{cursor:pointer}button:disabled{cursor:wait;opacity:.6}button:focus-visible,a:focus-visible,summary:focus-visible{outline:3px solid #9690fa;outline-offset:2px}
    button{border:1px solid #deddf1;border-radius:7px;background:#fff;color:#4f46e5;padding:5px 10px;line-height:1.4}button:hover{background:#f4f3ff}button:active{background:#eae8ff}
    .trigger{position:fixed;display:grid;place-items:center;pointer-events:auto;width:28px;height:28px;padding:0;border:0;border-radius:8px;background:#4f46e5;box-shadow:0 2px 8px #26225326}
    .trigger img{width:28px;height:28px;display:block}
    .card{position:fixed;pointer-events:auto;display:flex;flex-direction:column;width:360px;max-width:calc(100vw - 16px);border:1px solid #deddf5;border-radius:12px;background:#fff;color:#20213a;box-shadow:0 8px 28px #2622531c;overflow:hidden;overflow-wrap:anywhere;text-align:left;font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
    .card:focus{outline:none}.card.word{width:330px}.head{display:flex;align-items:center;gap:9px;padding:12px 14px 10px;flex:none}.head img{width:26px;height:26px}.title{font-size:14px;font-weight:650;flex:1}.head button{padding:4px 6px;border:0;color:#656780;font-size:12px;background:transparent}
    .body{padding:0 14px 12px;overflow:auto;overscroll-behavior:contain;min-height:0;scrollbar-width:thin}.source{padding:8px 11px;border-radius:8px;background:#f6f6ff;color:#656780;font-size:13px;white-space:pre-wrap}.source summary{cursor:pointer;list-style:none}.source summary::-webkit-details-marker{display:none}.source:not([open]) .preview{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.source[open] .preview{display:none}.source .full{white-space:pre-wrap}.source-label{font-size:12px;color:#656780;margin-bottom:2px}.hint{font-size:12px;color:#656780}.translated{font-size:16px;font-weight:600;line-height:1.7;white-space:pre-wrap;margin:14px 0 0;padding-top:12px;border-top:1px solid #eeeefa}.status{margin:10px 0;color:#656780;white-space:pre-wrap}.error{color:#a33a36}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
    .foot{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 14px 12px;flex:none}.context{font-size:11px;color:#656780;max-width:65%;line-height:1.5}.copy{background:#4f46e5;border-color:#4f46e5;color:white;flex:none}.copy:hover{background:#4338ca}.word .copy{background:#fff;color:#4f46e5;border-color:#d8d5ff}
    h2{font-size:25px;font-weight:750;line-height:1.25;margin:3px 0 8px}.phonetics{display:flex;align-items:center;gap:7px;flex-wrap:wrap;color:#656780;font-size:13px}.phonetic{white-space:pre-wrap}.pronounce{font-size:12px;padding:3px 7px}.pos{display:inline-block;color:#656780;background:#f2f2fb;border:1px solid #ededf6;border-radius:6px;font-size:12px;padding:2px 7px;margin:14px 0 3px}.definitions{margin:3px 0 0;padding-left:25px}.definitions li{padding:4px 0 5px 2px;line-height:1.6}.definitions li::marker{color:#4f46e5;font-weight:650}.definition{white-space:pre-wrap}.more{padding:3px 0;border:0;background:transparent;font-size:12px;margin-top:6px}.originals{font-size:12px;color:#656780;margin-top:9px}.originals summary{cursor:pointer;color:#4f46e5}.originals p{margin:5px 0;white-space:pre-wrap}.notice{margin:9px 0 0;font-size:11px;line-height:1.5;color:#656780}.sources{display:flex;gap:4px 8px;flex-wrap:wrap;font-size:10px;line-height:1.4;margin-top:8px}.sources a{color:#656780;text-decoration:none}.sources a:hover{text-decoration:underline}
  `;
  const trigger = document.createElement('button'); trigger.className = 'trigger'; trigger.type = 'button';
  trigger.setAttribute('aria-label', '翻译所选文字'); trigger.title = '翻译所选文字'; trigger.hidden = true;
  const logoURL = chrome.runtime.getURL('assets/icons/icon-32.png');
  const logo = document.createElement('img'); logo.src = logoURL; logo.alt = ''; trigger.append(logo);
  const card = document.createElement('section'); card.className = 'card'; card.hidden = true;
  card.setAttribute('role', 'dialog'); card.setAttribute('aria-label', '划词翻译'); card.tabIndex = -1;
  // This template is constant. Page selections and provider fields use textContent.
  card.innerHTML = '<div class="head"><img alt=""><span class="title">划词翻译</span><button type="button" class="settings">设置</button><button type="button" class="close">关闭</button></div><div class="body"></div><div class="foot"><span class="context"></span><button type="button" class="copy" hidden>复制译文</button></div>';
  card.querySelector('.head img').src = logoURL;
  const body = card.querySelector('.body'), title = card.querySelector('.title'), context = card.querySelector('.context'), copy = card.querySelector('.copy');
  shadow.append(style, trigger, card); (document.body || document.documentElement).append(host);

  async function send(message) {
    try { return await chrome.runtime.sendMessage(message); }
    catch { return { ok: false, error: { code: 'CONNECTION', message: '插件连接已断开，请刷新页面后重试。' } }; }
  }
  function element(tag, className, text) {
    const node = document.createElement(tag); if (className) node.className = className;
    if (text !== undefined) node.textContent = text; return node;
  }
  function action(text, callback, className = '') {
    const button = element('button', className, text); button.type = 'button'; button.dataset.label = text;
    button.addEventListener('click', event => { if (event.isTrusted) callback(event); }); return button;
  }
  function isOwnSelection(selection) {
    return [selection?.anchorNode, selection?.focusNode].some(node => node && (node.getRootNode() === shadow || node === host));
  }
  function candidate() {
    const selection = getSelection();
    if (!selection || !selection.rangeCount || selection.isCollapsed || isOwnSelection(selection) || document.designMode === 'on') return null;
    const range = selection.getRangeAt(0).cloneRange();
    if (range.startContainer.getRootNode() !== document || range.endContainer.getRootNode() !== document) return null;
    const common = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
    if (!common?.isConnected || common.closest(SKIP)) return null;
    // Reject every intersected forbidden region BEFORE serializing the selection.
    for (const blocked of common.querySelectorAll(SKIP)) if (range.intersectsNode(blocked)) return null;
    const rects = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth);
    if (!rects.length) return null;
    const anchor = rects[rects.length - 1];
    if (anchor.bottom < 0 || anchor.top > innerHeight || anchor.right < 0 || anchor.left > innerWidth) return null;
    const text = selection.toString().trim();
    return text ? { text, range } : null;
  }
  function sameSelection(a, b) {
    return a && b && a.text === b.text && a.range.startContainer === b.range.startContainer && a.range.endContainer === b.range.endContainer && a.range.startOffset === b.range.startOffset && a.range.endOffset === b.range.endOffset;
  }
  function stopAudio() {
    audioSerial++;
    if (audioButton?.isConnected) { audioButton.disabled = false; audioButton.textContent = audioButton.dataset.label || '发音'; }
    audioButton = null;
    if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); audio = null; }
    voiceWaitCleanup?.();
    if (utterance) { globalThis.speechSynthesis?.cancel(); utterance = null; }
  }
  function cancelCurrent() {
    if (current) void send({ type: 'IT_CANCEL_SELECTION', requestId: current.id });
    current = null; serial++; stopAudio();
  }
  function close() {
    cancelCurrent(); snapshot = null; trigger.hidden = true; card.hidden = true; copy.hidden = true;
    body.replaceChildren(); context.textContent = ''; delete card.dataset.mode;
  }
  function anchorRect() {
    if (!snapshot?.range.startContainer.isConnected || !snapshot.range.endContainer.isConnected) return null;
    const rects = [...snapshot.range.getClientRects()].filter(rect => rect.width && rect.height && rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth);
    return rects.at(-1) || null;
  }
  const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));
  function position() {
    const anchor = anchorRect();
    if (!anchor) { close(); return; }
    if (!trigger.hidden) {
      trigger.style.left = `${clamp(anchor.right + 6, 8, innerWidth - 36)}px`;
      trigger.style.top = `${clamp(anchor.bottom + 5, 8, innerHeight - 36)}px`;
    }
    if (card.hidden) return;
    card.style.maxHeight = `${Math.max(40, innerHeight - 16)}px`;
    const width = card.getBoundingClientRect().width;
    // The word itself anchors the card, rather than a remote viewport margin.
    card.style.left = `${clamp(anchor.left, 8, innerWidth - width - 8)}px`;
    const height = card.getBoundingClientRect().height;
    const below = innerHeight - anchor.bottom - 16, above = anchor.top - 16;
    let top = anchor.bottom + 8;
    if (below < Math.min(height, 180) && above > below) {
      card.style.maxHeight = `${Math.max(40, above)}px`;
      top = anchor.top - card.getBoundingClientRect().height - 8;
    } else card.style.maxHeight = `${Math.max(40, below)}px`;
    card.style.top = `${clamp(top, 8, innerHeight - card.getBoundingClientRect().height - 8)}px`;
  }
  function checkSelection() {
    if (disposed || config.selectionEnabled === false) return;
    const selection = getSelection();
    if (isOwnSelection(selection)) return;
    const next = candidate();
    if (!next) {
      if (!card.hidden && document.activeElement === host) return;
      close(); return;
    }
    if (sameSelection(snapshot, next)) return;
    close(); snapshot = next; trigger.hidden = false; position();
  }
  function scheduleSelection() { clearTimeout(debounce); debounce = setTimeout(checkSelection, 60); }
  function wordOf(text) {
    const word = text.replace(/^[\p{P}\p{Z}]+|[\p{P}\p{Z}]+$/gu, '').replaceAll('’', "'");
    return word.length <= 80 && /^[a-z]+(?:[-'][a-z]+)*$/i.test(word) ? word : null;
  }
  function sourcePreview(text) {
    const box = element('details', 'source');
    const summary = element('summary');
    summary.append(element('div', 'source-label', '原文 · 点击展开'), element('div', 'preview', text));
    box.append(summary, element('div', 'full', text)); box.addEventListener('toggle', position); return box;
  }
  function ordinaryContext() { context.textContent = `${names[config.provider] || '当前引擎'} · ${config.targetLanguage === 'en' ? '英文' : '简体中文'}`; }
  function showError(message) {
    const status = element('p', 'status error', message); status.setAttribute('role', 'status');
    body.append(status);
    const actions = element('div', 'actions');
    actions.append(action('重试', () => void request(current?.mode || 'translate')));
    if (card.dataset.mode === 'dictionary') actions.append(action('普通翻译', () => void request('translate')));
    body.append(actions); position();
  }
  function safeLink(parent, text, value) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password) return;
      const link = element('a', '', text); link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; parent.append(link);
    } catch { /* Missing or unsafe attribution remains plain unavailable data. */ }
  }
  async function localVoice(synth) {
    const find = () => synth.getVoices().find(voice => voice.localService === true && /^en(?:-|_)/i.test(voice.lang));
    const available = find(); if (available) return available;
    return new Promise(resolve => {
      let timer;
      const finish = voice => { clearTimeout(timer); synth.removeEventListener('voiceschanged', changed); if (voiceWaitCleanup === cancel) voiceWaitCleanup = null; resolve(voice); };
      const changed = () => { const voice = find(); if (voice) finish(voice); };
      const cancel = () => finish(null);
      voiceWaitCleanup = cancel; synth.addEventListener('voiceschanged', changed);
      timer = setTimeout(() => finish(null), 1500); changed();
    });
  }
  async function speakLocal(button, owner) {
    if (current !== owner) return;
    const synth = globalThis.speechSynthesis;
    if (!synth || typeof globalThis.SpeechSynthesisUtterance !== 'function') { button.textContent = '本机朗读不可用'; return; }
    if (synth.speaking && !utterance) { button.textContent = '页面正在朗读 · 稍后重试'; return; }
    stopAudio(); const token = audioSerial; audioButton = button;
    button.disabled = true; button.textContent = '加载本机声音…';
    try {
      const voice = await localVoice(synth);
      if (current !== owner || token !== audioSerial) return;
      if (!voice) { button.textContent = '未安装本机英语声音'; return; }
      const spoken = new SpeechSynthesisUtterance(wordOf(snapshot.text)); spoken.voice = voice; spoken.lang = voice.lang; utterance = spoken;
      const finish = error => {
        if (utterance === spoken) utterance = null;
        if (current === owner && token === audioSerial) button.textContent = error ? '朗读失败 · 重试' : '本机朗读';
      };
      spoken.onend = () => finish(false); spoken.onerror = () => finish(true);
      synth.speak(spoken); button.textContent = '再次本机朗读';
    } catch { if (current === owner && token === audioSerial) button.textContent = '朗读失败 · 重试'; }
    finally { if (current === owner && token === audioSerial) button.disabled = false; }
  }
  function addLocalSpeech(parent, owner) {
    if (parent.querySelector('.local-speech')) return;
    const button = action('本机朗读', () => void speakLocal(button, owner), 'pronounce local-speech');
    button.title = '使用本机英语声音合成朗读；并非词典原声'; parent.append(button); position();
  }
  async function pronounce(button, url, owner) {
    if (current !== owner) return;
    stopAudio(); const token = audioSerial; audioButton = button; button.disabled = true; button.textContent = '加载发音…';
    const response = await send({ type: 'IT_SELECTION_AUDIO', requestId: owner.id, audio: url });
    if (current !== owner || token !== audioSerial) return;
    try {
      if (!response?.ok || typeof response.dataUrl !== 'string' || !/^data:audio\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+$/i.test(response.dataUrl)) throw new Error();
      const playing = new Audio(response.dataUrl); audio = playing;
      playing.onended = () => { if (current === owner && token === audioSerial) button.textContent = '发音'; };
      playing.onerror = () => { if (current === owner && token === audioSerial) { button.textContent = '发音失败 · 重试'; button.disabled = false; addLocalSpeech(button.parentElement, owner); } };
      await playing.play();
      if (current !== owner || token !== audioSerial) { playing.pause(); return; }
      button.textContent = '再次发音';
    } catch { if (current === owner && token === audioSerial) { button.textContent = '发音失败 · 重试'; addLocalSpeech(button.parentElement, owner); } }
    finally { if (current === owner && token === audioSerial) button.disabled = false; }
  }
  function renderDictionary(data, owner) {
    body.replaceChildren(element('h2', '', snapshot.text));
    if (data.word && data.word.toLowerCase() !== wordOf(snapshot.text)?.toLowerCase()) body.append(element('div', 'hint', `词条：${data.word}`));
    const phonetics = element('div', 'phonetics');
    const entries = Array.isArray(data.phonetics) ? data.phonetics.slice(0, 3) : [];
    if (!entries.some(entry => entry.text)) phonetics.append(element('span', 'hint', '暂无音标'));
    let hasAudio = false;
    for (const entry of entries) {
      const region = { UK: '英', US: '美', AU: '澳', 英: '英', 美: '美', 澳: '澳' }[entry.region] || '';
      if (entry.text) phonetics.append(element('span', 'phonetic', `${region ? region + ' ' : ''}${entry.text}`));
      if (entry.audio) { hasAudio = true; const button = action(`${region ? region + '音 · ' : ''}发音`, () => void pronounce(button, entry.audio, owner), 'pronounce'); phonetics.append(button); }
    }
    if (!hasAudio) { phonetics.append(element('span', 'hint', '暂无词典发音')); addLocalSpeech(phonetics, owner); }
    body.append(phonetics);
    const meanings = Array.isArray(data.meanings) ? data.meanings : [];
    const all = meanings.flatMap(meaning => (Array.isArray(meaning.definitions) ? meaning.definitions : []).filter(definition => typeof definition.text === 'string' && definition.text.trim()).map(definition => ({ ...definition, part: meaning.partOfSpeech }))).slice(0, 24);
    if (!all.length) {
      body.append(element('p', 'status', '暂无词典释义。'));
      body.append(action('普通翻译', () => void request('translate'))); position(); return;
    }
    let expanded = false;
    const senses = element('div', 'senses');
    function renderSenses() {
      senses.replaceChildren(); let previousPart = null, list;
      for (const [index, definition] of (expanded ? all : all.slice(0, 3)).entries()) {
        if (definition.part !== previousPart || !list) {
          senses.append(element('span', 'pos', parts[definition.part] || definition.part || '词性未提供'));
          list = element('ol', 'definitions'); list.start = index + 1; senses.append(list); previousPart = definition.part;
        }
        const item = element('li'); item.append(element('span', 'definition', definition.text)); list.append(item);
      }
    }
    renderSenses(); body.append(senses);
    if (all.length > 3) {
      const more = action('更多释义', () => { expanded = !expanded; more.textContent = expanded ? '收起释义' : '更多释义'; renderSenses(); position(); }, 'more'); body.append(more);
    }
    const originals = all.filter(definition => definition.original && definition.original !== definition.text);
    if (originals.length) {
      const details = element('details', 'originals'); details.append(element('summary', '', '查看英文原释义'));
      originals.forEach(definition => details.append(element('p', '', definition.original))); details.addEventListener('toggle', position); body.append(details);
    }
    if (data.translationNotice) body.append(element('p', 'notice', data.translationNotice));
    const sources = element('div', 'sources');
    for (const source of [...(data.sources || []).slice(0, 9), ...(data.licenses || []).slice(0, 8)]) safeLink(sources, source.name, source.url);
    body.append(sources);
    context.textContent = '单词释义'; copy.textContent = '复制释义'; copy.hidden = false;
    owner.copyText = () => [snapshot.text, ...entries.filter(entry => entry.text).map(entry => entry.text), ...(expanded ? all : all.slice(0, 3)).map(definition => `${parts[definition.part] || definition.part || ''} ${definition.text}`)].join('\n');
    position();
  }
  async function request(mode) {
    if (!snapshot) return;
    cancelCurrent(); const token = serial;
    const captured = snapshot;
    current = { id: crypto.randomUUID(), mode }; const owner = current;
    trigger.hidden = true; card.hidden = false; copy.hidden = true;
    card.dataset.mode = mode; card.classList.toggle('word', mode === 'dictionary');
    title.textContent = mode === 'dictionary' ? '单词释义' : '划词翻译'; card.setAttribute('aria-label', title.textContent);
    body.replaceChildren(mode === 'dictionary' ? element('h2', '', captured.text) : sourcePreview(captured.text));
    const loading = element('p', 'status', mode === 'dictionary' ? '正在查词…' : '正在翻译…'); loading.setAttribute('role', 'status'); body.append(loading);
    ordinaryContext(); position(); card.focus({ preventScroll: true });
    if (captured.text.length > 3000) { loading.remove(); showError('一次最多翻译 3000 字符，请缩小选区。'); return; }
    const cfg = await send({ type: 'IT_GET_PUBLIC_CONFIG' });
    if (token !== serial || current !== owner) return;
    if (cfg?.ok) config = cfg.config;
    if (config.selectionEnabled === false) { close(); return; }
    if (!cfg?.ok || (mode === 'translate' && !config.configured)) {
      loading.remove(); body.append(element('p', 'status error', cfg?.error?.message || '请先配置当前翻译引擎。'));
      body.append(action('去设置', () => void send({ type: 'IT_OPEN_OPTIONS' }))); position(); return;
    }
    const response = await send({ type: 'IT_SELECTION_TRANSLATE', requestId: owner.id, text: mode === 'dictionary' ? wordOf(captured.text) : captured.text, mode });
    if (token !== serial || current !== owner || snapshot !== captured) return;
    loading.remove();
    if (!response?.ok) { showError(response?.error?.message || '未获取到结果，请重试。'); return; }
    if (response.config) config = response.config;
    if (mode === 'dictionary' && response.dictionary) { renderDictionary(response.dictionary, owner); return; }
    const text = response.translations?.find(item => item.id === 'selection')?.text;
    if (typeof text !== 'string' || !text.trim()) { showError('服务没有返回有效结果，请重试。'); return; }
    body.append(element('div', 'translated', text)); ordinaryContext(); copy.textContent = '复制译文'; copy.hidden = false;
    owner.copyText = () => text; position();
  }
  trigger.addEventListener('pointerdown', event => event.preventDefault());
  // Owned controls must not also activate the host page's keyboard shortcuts.
  for (const type of ['keydown', 'keyup']) shadow.addEventListener(type, event => event.stopPropagation());
  trigger.addEventListener('click', event => {
    if (!event.isTrusted || !snapshot) return;
    void request(wordOf(snapshot.text) ? 'dictionary' : 'translate');
  });
  card.querySelector('.close').addEventListener('click', event => { if (event.isTrusted) close(); });
  card.querySelector('.settings').addEventListener('click', event => { if (event.isTrusted) void send({ type: 'IT_OPEN_OPTIONS' }); });
  copy.addEventListener('click', async event => {
    if (!event.isTrusted) return;
    const owner = current; if (!owner?.copyText) return;
    try {
      await navigator.clipboard.writeText(owner.copyText());
      if (current !== owner) return;
      copy.textContent = '已复制'; setTimeout(() => { if (current === owner) copy.textContent = owner.mode === 'dictionary' ? '复制释义' : '复制译文'; }, 1200);
    } catch { if (current === owner) copy.textContent = '复制失败 · 重试'; }
  });
  document.addEventListener('selectionchange', scheduleSelection);
  document.addEventListener('pointerdown', event => { if (!event.composedPath().includes(host)) close(); }, true);
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && (!trigger.hidden || !card.hidden)) { close(); event.stopPropagation(); } }, true);
  addEventListener('scroll', event => { if (!event.composedPath().includes(host)) close(); }, true);
  addEventListener('resize', position);
  document.addEventListener('yt-navigate-start', close);
  async function readConfig() {
    const response = await send({ type: 'IT_GET_PUBLIC_CONFIG' });
    if (!response?.ok) return;
    config = response.config;
    if (config.selectionEnabled === false) close();
  }
  chrome.runtime.onMessage.addListener(message => {
    if (message?.type === 'IT_CONFIG_CHANGED') { close(); void readConfig(); }
    if (message?.type === 'IT_SELECTION_CONFIG_CHANGED') void readConfig();
  });
  function routeCheck() {
    if (location.href !== lastURL) { lastURL = location.href; close(); }
    if (snapshot && (!snapshot.range.startContainer.isConnected || !snapshot.range.endContainer.isConnected)) close();
  }
  let interval = setInterval(routeCheck, 500);
  addEventListener('pagehide', () => { disposed = true; clearTimeout(debounce); clearInterval(interval); close(); });
  addEventListener('pageshow', () => { if (disposed) { disposed = false; interval = setInterval(routeCheck, 500); void readConfig(); } });
  void readConfig();
})();
