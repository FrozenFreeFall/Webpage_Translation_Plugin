import { DEFAULT_SETTINGS, normalizeSettings, publicConfig, errorResult, TranslationError, validateSegments } from './shared.js';
import { translateSegments } from './translator.js';
import { isPdfReaderURL, pdfReaderURL } from './pdf-entry.js';
import { lookupDictionary, fetchPronunciation, dictionaryWord } from './dictionary.js';

const cancelled = () => new TranslationError('CANCELLED', '本次翻译已结束，请重新开启。');
const forbidden = () => new TranslationError('FORBIDDEN', '此页面无权执行该操作。', true);

export function createBackground(api, { translator = translateSegments, dictionary = lookupDictionary, audioFetcher = fetchPronunciation } = {}) {
  const sessions = new Map();
  const selections = new Map();
  const tests = new Set();
  let settings = { ...DEFAULT_SETTINGS };
  let revision = '';
  const ready = (async () => {
    // Complete the trust restriction BEFORE reading any stored key or accepting work.
    await api.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    const saved = await api.storage.local.get(['settings', 'revision']);
    try { settings = normalizeSettings(saved.settings || DEFAULT_SETTINGS); }
    catch { settings = { ...DEFAULT_SETTINGS }; }
    revision = saved.revision || crypto.randomUUID();
  })();

  function cancelTab(tabId) {
    const current = sessions.get(tabId);
    if (current) current.controller.abort();
    sessions.delete(tabId);
    cancelSelection(tabId);
  }
  function cancelSelection(tabId) {
    selections.get(tabId)?.controller.abort();
    selections.delete(tabId);
  }
  function cancelAll() {
    for (const tabId of sessions.keys()) cancelTab(tabId);
    for (const tabId of selections.keys()) cancelSelection(tabId);
    for (const controller of tests) controller.abort();
  }
  function isTrusted(sender) {
    return sender?.id === api.runtime.id && ['options.html', 'popup.html'].some((file) => sender.url === api.runtime.getURL(file));
  }
  function pageSender(sender) {
    const readable = /^https?:\/\//.test(sender?.url || '') || isPdfReaderURL(sender?.url, api.runtime.getURL('pdf.html'));
    if (sender?.id !== api.runtime.id || !Number.isInteger(sender?.tab?.id) || sender.frameId !== 0 || !readable) throw forbidden();
    return sender.tab.id;
  }
  function sessionId(message) {
    if (typeof message.sessionId !== 'string' || !/^[\w-]{1,128}$/.test(message.sessionId)) throw new TranslationError('INPUT', '无效的翻译会话。');
    return message.sessionId;
  }
  function getSession(message, sender) {
    const current = sessions.get(pageSender(sender));
    if (!current || current.id !== sessionId(message) || current.documentId !== sender.documentId || current.url !== sender.url || current.controller.signal.aborted) throw cancelled();
    return current;
  }
  function selectionSender(sender) {
    const id = pageSender(sender);
    if (!/^https?:\/\//.test(sender.url)) throw forbidden();
    return id;
  }
  function requestId(message) {
    if (typeof message.requestId !== 'string' || !/^[\w-]{1,128}$/.test(message.requestId)) throw new TranslationError('INPUT', '无效的划词请求。');
    return message.requestId;
  }
  function currentSelection(message, sender) {
    const current = selections.get(selectionSender(sender));
    if (!current || current.id !== requestId(message) || current.documentId !== sender.documentId || current.url !== sender.url || current.controller.signal.aborted) throw cancelled();
    return current;
  }
  function checkSelection(current, tabId) {
    if (current.controller.signal.aborted || selections.get(tabId) !== current) throw cancelled();
  }
  async function translateDefinitions(result, current, tabId, savedSettings) {
    if (savedSettings.targetLanguage === 'en') return;
    const definitions = result.meanings.flatMap(meaning => meaning.definitions);
    const segments = definitions.map((item, index) => ({ id: `sense${index}`, text: item.text }));
    const translated = new Map();
    let complete = true;
    try {
      for (let index = 0; index < segments.length; index += 8) {
        const response = await translator(savedSettings, segments.slice(index, index + 8), { signal: current.controller.signal });
        checkSelection(current, tabId);
        for (const item of response.translations || []) if (typeof item.text === 'string' && item.text.trim() && item.text.length <= 6000) translated.set(item.id, item.text);
      }
    } catch (error) { checkSelection(current, tabId); complete = false; }
    definitions.forEach((item, index) => {
      const value = translated.get(`sense${index}`);
      item.original = item.text;
      if (value) item.text = value;
      else complete = false;
    });
    const labels = { microsoft: '微软', google: '谷歌', libretranslate: 'LibreTranslate', ai: 'AI' };
    result.translationNotice = complete ? `释义翻译：${labels[savedSettings.provider]}；英文原释义来自词典。` : '部分释义未能翻译，保留英文原释义；可重试或使用普通翻译。';
  }

  async function handle(message, sender) {
    try {
      await ready;
      if (!message || typeof message.type !== 'string' || sender?.id !== api.runtime.id) throw forbidden();
      switch (message.type) {
        case 'IT_GET_PUBLIC_CONFIG':
          if (!isTrusted(sender)) pageSender(sender);
          return { ok: true, config: publicConfig(settings, revision) };
        case 'IT_OPEN_OPTIONS':
          if (!isTrusted(sender)) pageSender(sender);
          await api.runtime.openOptionsPage();
          return { ok: true };
        case 'IT_OPEN_PDF_READER': {
          let source;
          if (isTrusted(sender)) source = message.url || '';
          else { pageSender(sender); source = sender.url; }
          const url = pdfReaderURL(api.runtime.getURL('pdf.html'), source);
          const tab = await api.tabs.create({ url });
          return { ok: true, tabId: tab.id };
        }
        case 'IT_GET_SETTINGS':
          if (!isTrusted(sender)) throw forbidden();
          return { ok: true, settings: { ...settings } };
        case 'IT_SAVE_SETTINGS': {
          if (!isTrusted(sender)) throw forbidden();
          const next = normalizeSettings(message.settings);
          const nextRevision = crypto.randomUUID();
          await api.storage.local.set({ settings: next, revision: nextRevision });
          settings = next;
          revision = nextRevision;
          cancelAll();
          const tabs = await api.tabs.query({});
          // tabs.sendMessage targets content scripts; reader extension pages listen
          // on runtime.onMessage and need their own secret-free broadcast.
          await Promise.allSettled([api.runtime.sendMessage({ type: 'IT_CONFIG_CHANGED' })]);
          await Promise.allSettled(tabs.filter((tab) => Number.isInteger(tab.id)).map((tab) => api.tabs.sendMessage(tab.id, { type: 'IT_CONFIG_CHANGED' })));
          return { ok: true, config: publicConfig(settings, revision) };
        }
        case 'IT_TEST_CONNECTION': {
          if (!isTrusted(sender)) throw forbidden();
          const draft = normalizeSettings(message.settings);
          const controller = new AbortController();
          tests.add(controller);
          try {
            const result = await translator(draft, [{ id: 'test', text: 'Hello, welcome to this webpage.' }], { signal: controller.signal });
            if (!result.translations?.length) throw new TranslationError('FORMAT', '连接成功，但翻译服务未返回有效译文。');
            return { ok: true, text: result.translations[0].text };
          } finally { tests.delete(controller); }
        }
        case 'IT_SET_SELECTION_ENABLED': {
          if (!isTrusted(sender)) throw forbidden();
          if (typeof message.enabled !== 'boolean') throw new TranslationError('INPUT', '划词翻译开关无效。');
          const next = { ...settings, selectionEnabled: message.enabled };
          await api.storage.local.set({ settings: next });
          settings = next;
          if (!message.enabled) for (const tabId of selections.keys()) cancelSelection(tabId);
          const tabs = await api.tabs.query({});
          await Promise.allSettled([api.runtime.sendMessage({ type: 'IT_SELECTION_CONFIG_CHANGED' })]);
          await Promise.allSettled(tabs.filter(tab => Number.isInteger(tab.id)).map(tab => api.tabs.sendMessage(tab.id, { type: 'IT_SELECTION_CONFIG_CHANGED' })));
          return { ok: true, config: publicConfig(settings, revision) };
        }
        case 'IT_SELECTION_TRANSLATE': {
          const tabId = selectionSender(sender);
          const id = requestId(message);
          if (!settings.selectionEnabled) throw new TranslationError('DISABLED', '划词翻译已关闭。');
          if (!['dictionary', 'translate'].includes(message.mode) || typeof message.text !== 'string' || !message.text.trim() || message.text.length > 3000) throw new TranslationError('INPUT', '请选择 1 至 3000 字符。');
          const text = message.text.trim();
          if (message.mode === 'dictionary') dictionaryWord(text);
          cancelSelection(tabId);
          const current = { id, documentId: sender.documentId, url: sender.url, controller: new AbortController(), audio: new Set(), audioActive: false };
          selections.set(tabId, current);
          const savedSettings = { ...settings };
          try {
            if (message.mode === 'translate') {
              const result = await translator(savedSettings, [{ id: 'selection', text }], { signal: current.controller.signal });
              checkSelection(current, tabId);
              const value = result.translations?.find(item => item.id === 'selection')?.text;
              if (typeof value !== 'string' || !value.trim()) throw new TranslationError('FORMAT', '翻译服务未返回有效译文，请重试。');
              return { ok: true, config: publicConfig(savedSettings, revision), translations: [{ id: 'selection', text: value }] };
            }
            const result = await dictionary(text, { signal: current.controller.signal });
            checkSelection(current, tabId);
            await translateDefinitions(result, current, tabId, savedSettings);
            checkSelection(current, tabId);
            current.audio = new Set(result.phonetics.map(item => item.audio).filter(Boolean));
            return { ok: true, config: publicConfig(savedSettings, revision), dictionary: result };
          } catch (error) {
            checkSelection(current, tabId);
            cancelSelection(tabId);
            throw error;
          }
        }
        case 'IT_SELECTION_AUDIO': {
          const current = currentSelection(message, sender);
          if (typeof message.audio !== 'string' || !current.audio.has(message.audio)) throw new TranslationError('INPUT', '此发音不属于当前单词。');
          if (current.audioActive) throw new TranslationError('BUSY', '发音正在加载，请稍候。');
          current.audioActive = true;
          try {
            const dataUrl = await audioFetcher(message.audio, { signal: current.controller.signal });
            checkSelection(current, sender.tab.id);
            return { ok: true, dataUrl };
          } catch (error) { checkSelection(current, sender.tab.id); throw error; }
          finally { current.audioActive = false; }
        }
        case 'IT_CANCEL_SELECTION': {
          const tabId = selectionSender(sender);
          const current = selections.get(tabId);
          if (current?.id === requestId(message) && current.documentId === sender.documentId && current.url === sender.url) cancelSelection(tabId);
          return { ok: true };
        }
        case 'IT_START_SESSION': {
          const tabId = pageSender(sender);
          const id = sessionId(message);
          const previous = sessions.get(tabId);
          previous?.controller.abort();
          sessions.delete(tabId);
          sessions.set(tabId, { id, documentId: sender.documentId, url: sender.url, controller: new AbortController(), active: 0 });
          return { ok: true, config: publicConfig(settings, revision) };
        }
        case 'IT_CANCEL_SESSION': {
          const tabId = pageSender(sender);
          const current = sessions.get(tabId);
          if (current?.id === sessionId(message) && current.documentId === sender.documentId) {
            current.controller.abort();
            sessions.delete(tabId);
          }
          return { ok: true };
        }
        case 'IT_TRANSLATE': {
          const current = getSession(message, sender);
          validateSegments(message.segments);
          if (current.active >= 2) throw new TranslationError('BUSY', '当前页面正在处理其他翻译批次，请稍后重试。');
          current.active++;
          try {
            const result = await translator(settings, message.segments.map(({ id, text }) => ({ id, text })), { signal: current.controller.signal });
            if (current.controller.signal.aborted || sessions.get(sender.tab.id) !== current) throw cancelled();
            return { ok: true, ...result };
          } catch (error) {
            if (error instanceof TranslationError && error.fatal) current.controller.abort();
            if (current.controller.signal.aborted && !(error instanceof TranslationError && error.fatal)) throw cancelled();
            throw error;
          } finally { current.active--; }
        }
        default: throw new TranslationError('INPUT', '不支持的操作。');
      }
    } catch (error) { return errorResult(error); }
  }
  return { handle, cancelTab };
}

if (globalThis.chrome?.runtime?.onMessage) {
  const app = createBackground(chrome);
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message?.type?.startsWith('IT_')) return false;
    app.handle(message, sender).then(sendResponse);
    return true;
  });
  chrome.tabs.onRemoved.addListener((tabId) => app.cancelTab(tabId));
  chrome.tabs.onUpdated.addListener((tabId, change) => { if (change.url) app.cancelTab(tabId); });
}
