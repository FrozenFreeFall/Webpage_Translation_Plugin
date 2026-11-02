import { getDocument, GlobalWorkerOptions } from '../vendor/pdfjs/pdf.mjs';
import { extractPageBlocks, makeTranslationBatches } from './pdf-model.js';
import { normalizePdfSource as safeDocumentURL } from './pdf-entry.js';

GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.mjs', import.meta.url).href;

const $ = (id) => document.getElementById(id);
const ui = Object.fromEntries(['fileName', 'documentDetails', 'fileInput', 'openFile', 'chooseFile', 'openSettings', 'engineName', 'targetLanguage', 'translateButton', 'outlineToggle', 'outlinePanel', 'outlineList', 'modeCompare', 'modeReading', 'modeOriginal', 'pageNumber', 'pageTotal', 'previousPage', 'nextPage', 'zoomSelect', 'syncScroll', 'status', 'retryButton', 'emptyState', 'readerWorkspace', 'urlForm', 'urlInput', 'originalPane', 'originalScroll', 'canvasWrapper', 'translatedPane', 'translationScroll', 'translationContent', 'translationTitle', 'translationNotice', 'translationLayoutLabel', 'originalPageLabel', 'passwordDialog', 'passwordForm', 'passwordInput', 'passwordHint', 'passwordCancel'].map((id) => [id, $(id)]));
const providers = { google: '谷歌免费', microsoft: '微软免费', ai: 'AI 自定义', libretranslate: 'LibreTranslate' };
const languageName = (language) => language === 'en' ? 'English' : '简体中文';
let pdf = null, loadingTask = null, renderTask = null, pdfPage = null, current = null;
let documentGeneration = 0, pageGeneration = 0, renderGeneration = 0, translationGeneration = 0, configGeneration = 0;
let pageNumber = 1, translationSession = null, translating = false, disposed = false, config = null;
let passwordCallback = null, outlineItems = [], figures = [], resizeTimer = 0, syncFrame = 0, wasNarrow = innerWidth <= 580;
const cache = new Map();

async function send(message) {
  try { return await chrome.runtime.sendMessage(message); }
  catch { return { ok: false, error: { code: 'CONNECTION', message: '无法连接扩展后台，请重新打开阅读器后重试。', fatal: true } }; }
}

function status(message, kind = 'info') {
  ui.status.textContent = message;
  ui.status.dataset.kind = kind;
}

function friendly(error, fallback = '操作未完成，请稍后重试。') {
  return typeof error?.message === 'string' && error.message.trim() ? error.message.slice(0, 240) : fallback;
}

function configKey(value) {
  return value ? `${value.revision}|${value.provider}|${value.targetLanguage}` : '';
}

function applyConfig(value) {
  config = value;
  ui.engineName.textContent = providers[value?.provider] || '翻译设置';
  ui.targetLanguage.textContent = languageName(value?.targetLanguage);
  ui.translationTitle.textContent = document.body.dataset.mode === 'reading' ? '双语阅读' : `译文 · ${languageName(value?.targetLanguage)}`;
  ui.translationContent.lang = value?.targetLanguage || 'zh-CN';
}

function clearTranslations() {
  for (const entry of cache.values()) { entry.translations.clear(); entry.errors.clear(); }
  if (current && !cache.has(current.number)) { current.translations.clear(); current.errors.clear(); }
  updateTranslationBlocks();
}

async function readConfig() {
  const token = ++configGeneration;
  const response = await send({ type: 'IT_GET_PUBLIC_CONFIG' });
  if (token !== configGeneration || disposed) return;
  if (response?.ok && response.config) {
    if (config && configKey(config) !== configKey(response.config)) { cancelTranslation(); clearTranslations(); }
    applyConfig(response.config);
  } else {
    ui.engineName.textContent = '设置暂不可用';
    status(friendly(response?.error), 'error');
  }
}

function pendingBlocks(entry = current) {
  return entry?.blocks.filter((block) => block.kind !== 'code' && !entry.translations.has(block.id)) || [];
}

function updateControls() {
  const ready = Boolean(pdf && current && !disposed);
  const pending = pendingBlocks();
  const completed = current?.translations.size || 0;
  const errors = current?.errors.size || 0;
  let state = 'idle', text = '翻译当前页';
  if (translating) { state = 'loading'; text = '取消翻译'; }
  else if (errors) { state = completed ? 'partial' : 'error'; text = '继续翻译当前页'; }
  else if (completed && !pending.length) { state = 'translated'; text = '当前页已翻译'; }
  else if (completed) { state = 'partial'; text = '继续翻译当前页'; }
  ui.translateButton.dataset.state = state;
  ui.translateButton.textContent = text;
  ui.translateButton.disabled = !translating && (!ready || !pending.length);
  ui.retryButton.hidden = translating || !ready || !errors;
  ui.previousPage.disabled = !pdf || pageNumber <= 1;
  ui.nextPage.disabled = !pdf || pageNumber >= pdf.numPages;
  ui.pageNumber.disabled = !pdf;
  ui.pageNumber.value = String(pageNumber);
  ui.pageNumber.max = String(pdf?.numPages || 1);
  ui.pageTotal.textContent = String(pdf?.numPages || 0);
}

function cancelTranslation(message = '') {
  translationGeneration++;
  const previous = translationSession;
  translationSession = null;
  const wasTranslating = translating;
  translating = false;
  if (previous) void send({ type: 'IT_CANCEL_SESSION', sessionId: previous });
  if (wasTranslating && current) {
    for (const block of pendingBlocks()) current.errors.set(block.id, '此段尚未完成，点击继续翻译。');
    updateTranslationBlocks();
  }
  updateControls();
  if (message) status(message);
}

function cancelRendering() {
  renderGeneration++;
  if (renderTask) { renderTask.cancel(); renderTask = null; }
}

function closePassword() {
  passwordCallback = null;
  ui.passwordInput.value = '';
  if (ui.passwordDialog.open) ui.passwordDialog.close();
}

function destroyDocument() {
  cancelTranslation();
  cancelRendering();
  closePassword();
  const task = loadingTask, previous = pdf;
  loadingTask = null;
  pdf = null;
  pdfPage = null;
  current = null;
  cache.clear();
  figures = [];
  outlineItems = [];
  // A loading task owns its document and worker; destroy it exactly once.
  if (task) void task.destroy().catch(() => {});
  else if (previous) void previous.destroy().catch(() => {});
}

function nameFromURL(value) {
  try { return decodeURIComponent(new URL(value).pathname.split('/').filter(Boolean).at(-1) || '在线 PDF'); }
  catch { return '在线 PDF'; }
}

function loadingError(error, isFileURL) {
  if (error?.name === 'PasswordException') return '无法打开加密 PDF。请重新选择文件，并输入正确的文档密码。';
  if (error?.name === 'InvalidPDFException') return '这份文件不是有效的 PDF，或文件已损坏。请选择其他 PDF。';
  if (error?.name === 'MissingPDFException') return '找不到 PDF。请检查链接，或选择已下载的本地文件。';
  if (isFileURL) return '无法读取本地链接。请点击“选择 PDF 文件”直接打开，或在扩展详情中允许访问文件网址。';
  return '无法载入 PDF。请检查链接与网络；需要登录的文档可以下载后，使用“选择 PDF 文件”打开。';
}

async function loadDocument(source, label, requestedPage = 1) {
  const token = ++documentGeneration;
  pageGeneration++;
  destroyDocument();
  ui.readerWorkspace.hidden = true;
  ui.emptyState.hidden = false;
  ui.fileName.textContent = label;
  ui.documentDetails.textContent = '正在本地解析 PDF…';
  ui.translationContent.replaceChildren();
  status('正在载入 PDF…');
  updateControls();
  try {
    const data = source instanceof File ? { data: new Uint8Array(await source.arrayBuffer()) } : { url: safeDocumentURL(source) };
    if (token !== documentGeneration || disposed) return;
    const task = getDocument({
      ...data,
      cMapUrl: new URL('../vendor/pdfjs/cmaps/', import.meta.url).href,
      cMapPacked: true,
      standardFontDataUrl: new URL('../vendor/pdfjs/standard_fonts/', import.meta.url).href,
      wasmUrl: new URL('../vendor/pdfjs/wasm/', import.meta.url).href,
      isEvalSupported: false,
    });
    loadingTask = task;
    task.onPassword = (updatePassword, reason) => {
      if (token !== documentGeneration || disposed) return;
      passwordCallback = updatePassword;
      ui.passwordHint.textContent = reason === 2 ? '密码不正确，请再试一次。' : '输入文档密码以继续阅读。密码仅用于本地打开文件。';
      ui.passwordInput.value = '';
      if (!ui.passwordDialog.open) ui.passwordDialog.showModal();
      ui.passwordInput.focus();
      status('这份 PDF 已加密，请输入文档密码。');
    };
    const loaded = await task.promise;
    if (token !== documentGeneration || disposed) { void loaded.destroy().catch(() => {}); return; }
    pdf = loaded;
    closePassword();
    ui.emptyState.hidden = true;
    ui.readerWorkspace.hidden = false;
    ui.documentDetails.textContent = `${pdf.numPages} 页 · 文档仅在当前标签页解析`;
    ui.fileName.title = label;
    document.title = `${label} · PDF 双语阅读器`;
    pageNumber = Math.min(pdf.numPages, Math.max(1, Math.trunc(Number(requestedPage) || 1)));
    void readOutline(token, loaded);
    await showPage(pageNumber);
  } catch (error) {
    if (token !== documentGeneration || disposed) return;
    closePassword();
    const failedTask = loadingTask;
    loadingTask = null;
    if (failedTask) void failedTask.destroy().catch(() => {});
    status(loadingError(error, typeof source === 'string' && source.startsWith('file:')), 'error');
    ui.documentDetails.textContent = '请选择 PDF 文件，或尝试其他链接';
    ui.readerWorkspace.hidden = true;
    ui.emptyState.hidden = false;
    updateControls();
  }
}

async function readOutline(token, documentProxy) {
  ui.outlineList.replaceChildren();
  const message = document.createElement('p');
  message.className = 'outline-empty';
  message.textContent = '正在读取目录…';
  ui.outlineList.append(message);
  try {
    const outline = await documentProxy.getOutline();
    if (token !== documentGeneration || disposed) return;
    if (!outline?.length) { message.textContent = '这份 PDF 没有目录。你可以使用上方页码跳转。'; return; }
    const destinationCache = new Map();
    let count = 0;
    async function build(items, depth = 0) {
      const list = document.createElement('ul');
      list.className = 'outline-list';
      for (const item of items) {
        if (++count > 1000 || token !== documentGeneration) break;
        const li = document.createElement('li'); li.className = 'outline-item';
        const button = document.createElement('button'); button.type = 'button'; button.textContent = String(item.title || '未命名章节');
        let number = null;
        try {
          const destination = typeof item.dest === 'string' ? await documentProxy.getDestination(item.dest) : item.dest;
          if (Array.isArray(destination)) {
            const reference = destination[0];
            if (Number.isInteger(reference)) number = reference + 1;
            else if (reference && typeof reference === 'object') {
              const key = `${reference.num}:${reference.gen}`;
              if (!destinationCache.has(key)) destinationCache.set(key, await documentProxy.getPageIndex(reference));
              number = destinationCache.get(key) + 1;
            }
          }
        } catch { /* An invalid bookmark must not prevent reading the document. */ }
        if (token !== documentGeneration || disposed) return list;
        button.disabled = !Number.isInteger(number) || number < 1 || number > documentProxy.numPages;
        if (!button.disabled) {
          const page = document.createElement('span'); page.className = 'outline-page'; page.textContent = String(number); button.append(page);
          button.addEventListener('click', () => void showPage(number));
          outlineItems.push({ button, page: number });
        }
        li.append(button);
        if (item.items?.length && depth < 8) li.append(await build(item.items, depth + 1));
        list.append(li);
      }
      return list;
    }
    const list = await build(outline);
    if (token !== documentGeneration || disposed) return;
    ui.outlineList.replaceChildren(list);
    updateOutline();
  } catch {
    if (token === documentGeneration) message.textContent = '暂时无法读取目录，可以使用上方页码跳转。';
  }
}

function updateOutline() {
  const activePage = Math.max(0, ...outlineItems.filter((item) => item.page <= pageNumber).map((item) => item.page));
  for (const item of outlineItems) {
    if (item.page === activePage) item.button.setAttribute('aria-current', 'page');
    else item.button.removeAttribute('aria-current');
  }
}

function rememberPage(entry) {
  cache.delete(entry.number);
  cache.set(entry.number, entry);
  while (cache.size > 5) cache.delete(cache.keys().next().value);
}

async function showPage(number) {
  const documentProxy = pdf;
  if (!documentProxy || disposed) return;
  const next = Math.min(documentProxy.numPages, Math.max(1, Math.trunc(Number(number) || 1)));
  const token = ++pageGeneration;
  const docToken = documentGeneration;
  cancelTranslation();
  cancelRendering();
  if (pdfPage) pdfPage.cleanup();
  current = null;
  figures = [];
  pdfPage = null;
  pageNumber = next;
  updateControls();
  updateOutline();
  status(`正在读取第 ${next} 页…`);
  placeholder('正在读取页面', '原稿与可翻译段落很快就会显示。');
  const blank = document.createElement('canvas'); blank.id = 'pdfCanvas'; blank.setAttribute('role', 'img'); blank.setAttribute('aria-label', `PDF 原稿第 ${next} 页`);
  ui.canvasWrapper.replaceChildren(blank);
  ui.originalScroll.scrollTop = 0;
  ui.translationScroll.scrollTop = 0;
  try {
    const page = await documentProxy.getPage(next);
    if (token !== pageGeneration || docToken !== documentGeneration || disposed) return;
    pdfPage = page;
    const viewport = page.getViewport({ scale: 1 });
    let entry = cache.get(next);
    if (!entry) {
      const text = await page.getTextContent();
      if (token !== pageGeneration || docToken !== documentGeneration || disposed) return;
      entry = { number: next, blocks: extractPageBlocks(text, viewport), translations: new Map(), errors: new Map(), viewport };
    }
    rememberPage(entry);
    current = entry;
    ui.originalPageLabel.textContent = `第 ${next} 页 · PDF 原始页面`;
    renderTranslationContent();
    updateControls();
    if (!entry.blocks.length) status('当前页没有可提取文字，可能是扫描件。请阅读左侧原稿，或先使用 OCR 工具识别后重新打开。');
    else if (!entry.blocks.some((block) => block.kind !== 'code')) status('当前页仅提取到代码，代码保留原文，无需发送翻译。');
    else if (!pendingBlocks(entry).length) status('已恢复当前标签页中的译文，切换模式可继续阅读。', 'success');
    else status('已载入当前页。点击“翻译当前页”开始；图示与代码保留原文。');
    await renderOriginal(page, entry, token, docToken);
  } catch (error) {
    if (token !== pageGeneration || docToken !== documentGeneration || disposed) return;
    status('当前页读取失败，请切换页面后重试，或重新打开文件。', 'error');
    placeholder('当前页暂时无法读取', '可以切换页面后重试，或重新打开这份 PDF。');
    updateControls();
  }
}

async function renderOriginal(page = pdfPage, entry = current, pageToken = pageGeneration, docToken = documentGeneration) {
  if (!page || !entry || disposed) return;
  cancelRendering();
  const token = renderGeneration;
  const base = entry.viewport;
  const readingHidden = document.body.dataset.mode === 'reading';
  const availableWidth = readingHidden ? Math.max(220, ui.translatedPane.clientWidth - 40) : Math.max(100, ui.originalScroll.clientWidth - (innerWidth <= 580 ? 12 : innerWidth <= 800 ? 20 : 36));
  const scale = ui.zoomSelect.value === 'fit' ? Math.min(3, Math.max(.15, availableWidth / base.width)) : Number(ui.zoomSelect.value);
  const viewport = page.getViewport({ scale });
  const pixelRatio = Math.min(devicePixelRatio || 1, 2, Math.sqrt(16000000 / (viewport.width * viewport.height)));
  const canvas = document.createElement('canvas'); canvas.id = 'pdfCanvas';
  canvas.width = Math.max(1, Math.floor(viewport.width * pixelRatio));
  canvas.height = Math.max(1, Math.floor(viewport.height * pixelRatio));
  canvas.style.width = `${viewport.width}px`; canvas.style.height = `${viewport.height}px`;
  canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', `PDF 原稿第 ${entry.number} 页；双语阅读模式可阅读提取的原文`);
  ui.canvasWrapper.replaceChildren(canvas);
  const task = page.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport, transform: pixelRatio === 1 ? null : [pixelRatio, 0, 0, pixelRatio, 0, 0], background: '#ffffff' });
  renderTask = task;
  try {
    await task.promise;
    if (token !== renderGeneration || pageToken !== pageGeneration || docToken !== documentGeneration || current !== entry || disposed) return;
    renderTask = null;
    canvas.dataset.rendered = 'true';
    figures = extractFigures(canvas, entry);
    renderTranslationContent(true);
  } catch (error) {
    if (error?.name === 'RenderingCancelledException' || token !== renderGeneration || pageToken !== pageGeneration || docToken !== documentGeneration || disposed) return;
    status('原稿图像渲染失败。可使用双语阅读查看已提取文字，或重新打开文件。', 'error');
  }
}

// Preserve standalone artwork from the actual rendered page. These are original
// raster crops, not translated diagrams; prose remains in a readable page flow.
function extractFigures(canvas, entry) {
  if (!entry.blocks.length) return [];
  const scale = canvas.height / entry.viewport.height;
  const occupied = entry.blocks.map((block) => [Math.max(0, block.y - 4), Math.min(entry.viewport.height, block.y + block.height + 5)]).sort((a, b) => a[0] - b[0]);
  const gaps = []; let bottom = 0;
  for (const [top, end] of occupied) { if (top - bottom >= 35) gaps.push([bottom, top]); bottom = Math.max(bottom, end); }
  if (entry.viewport.height - bottom >= 35) gaps.push([bottom, entry.viewport.height]);
  const output = [];
  for (const [top, end] of gaps) {
    if (output.length >= 8) break;
    const y = Math.max(0, Math.floor(top * scale)), height = Math.min(canvas.height - y, Math.ceil((end - top) * scale));
    if (height < 12) continue;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    let pixels;
    try { pixels = context.getImageData(0, y, canvas.width, height).data; } catch { continue; }
    let minX = canvas.width, minY = height, maxX = 0, maxY = 0, count = 0;
    for (let row = 0; row < height; row += 2) {
      for (let x = 0; x < canvas.width; x += 2) {
        const offset = (row * canvas.width + x) * 4;
        if (pixels[offset] < 225 || pixels[offset + 1] < 225 || pixels[offset + 2] < 225) {
          minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, row); maxY = Math.max(maxY, row); count++;
        }
      }
    }
    if (count < 25 || maxX - minX < 35 * scale || maxY - minY < 17 * scale) continue;
    const pad = Math.max(2, Math.ceil(scale * 3));
    const sx = Math.max(0, minX - pad), sy = Math.max(0, minY - pad);
    const width = Math.min(canvas.width - sx, maxX - minX + pad * 2 + 2), cropHeight = Math.min(height - sy, maxY - minY + pad * 2 + 2);
    const crop = document.createElement('canvas'); crop.width = width; crop.height = cropHeight;
    crop.getContext('2d').drawImage(canvas, sx, y + sy, width, cropHeight, 0, 0, width, cropHeight);
    crop.style.width = `${width / scale}px`;
    crop.setAttribute('role', 'img'); crop.setAttribute('aria-label', '原稿图示，保留原文');
    output.push({ y: top + sy / scale, canvas: crop });
  }
  return output;
}

function placeholder(title, description, action = null) {
  const node = document.createElement('div'); node.className = 'page-placeholder';
  const heading = document.createElement('strong'); heading.textContent = title;
  const text = document.createElement('p'); text.textContent = description;
  node.append(heading, text);
  if (action) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'text-button'; button.textContent = action.label;
    button.addEventListener('click', action.run); node.append(button);
  }
  ui.translationContent.replaceChildren(node);
}

function renderTranslationContent(preserveScroll = false) {
  if (!current) return;
  const scroll = ui.translationScroll.scrollTop;
  if (!current.blocks.length) {
    placeholder('当前页没有可提取文字', '这可能是一页扫描件或图片。可阅读原稿；如需翻译，请先用 OCR 工具识别文字，再打开识别后的 PDF。', { label: '查看原稿', run: () => setMode('original') });
    return;
  }
  const fontSizes = current.blocks.filter((block) => block.kind !== 'code').map((block) => block.fontSize).sort((a, b) => a - b);
  const normalSize = fontSizes[Math.floor(fontSizes.length / 2)] || 12;
  const fragment = document.createDocumentFragment();
  const flow = [...current.blocks.map((block) => ({ y: block.y, block })), ...figures].sort((a, b) => a.y - b.y);
  for (const item of flow) {
    if (item.canvas) {
      const figure = document.createElement('figure'); figure.className = 'figure-block';
      const caption = document.createElement('figcaption'); caption.textContent = '原稿图示 · 保留原文';
      figure.append(item.canvas, caption); fragment.append(figure); continue;
    }
    const { block } = item;
    if (block.kind === 'code') {
      const wrapper = document.createElement('div'); wrapper.className = 'code-block'; wrapper.dataset.blockId = block.id;
      const label = document.createElement('span'); label.className = 'code-label'; label.textContent = '代码 · 保留原文';
      const code = document.createElement('pre'); code.className = 'source-code'; code.textContent = block.text;
      wrapper.append(label, code); fragment.append(wrapper); continue;
    }
    const wrapper = document.createElement('article'); wrapper.className = 'text-block'; wrapper.dataset.blockId = block.id;
    if (block.fontSize >= normalSize * 1.22 || (block.fontSize >= 16 && block.text.length < 150)) wrapper.classList.add('is-heading');
    const source = document.createElement('p'); source.className = 'source-text'; source.textContent = block.text;
    const translated = document.createElement('p'); translated.className = 'translated-text';
    wrapper.append(source, translated); fragment.append(wrapper);
  }
  ui.translationContent.replaceChildren(fragment);
  updateTranslationBlocks();
  if (preserveScroll) ui.translationScroll.scrollTop = scroll;
}

function updateTranslationBlocks() {
  if (!current) return;
  for (const wrapper of ui.translationContent.querySelectorAll('.text-block')) {
    const id = wrapper.dataset.blockId, translated = wrapper.querySelector('.translated-text');
    const value = current.translations.get(id), error = current.errors.get(id);
    translated.className = 'translated-text';
    if (typeof value === 'string') translated.textContent = value;
    else if (error) { translated.textContent = error; translated.classList.add('is-error'); }
    else {
      translated.classList.add('is-pending');
      translated.textContent = translating ? '正在翻译…' : '等待翻译 · 点击上方“翻译当前页”';
    }
  }
}

async function startTranslation() {
  if (!current || translating || !pendingBlocks().length || disposed) return;
  cancelTranslation();
  const entry = current, docToken = documentGeneration, pageToken = pageGeneration, token = ++translationGeneration;
  const session = crypto.randomUUID();
  translationSession = session;
  translating = true;
  const valid = () => token === translationGeneration && docToken === documentGeneration && pageToken === pageGeneration && current === entry && !disposed;
  updateControls(); updateTranslationBlocks(); status('正在连接已选择的翻译引擎…');
  try {
    const started = await send({ type: 'IT_START_SESSION', sessionId: session });
    if (!valid()) { void send({ type: 'IT_CANCEL_SESSION', sessionId: session }); return; }
    if (!started?.ok) throw new Error(friendly(started?.error));
    if (configKey(config) !== configKey(started.config)) clearTranslations();
    configGeneration++;
    applyConfig(started.config);
    if (!started.config?.configured) throw new Error(started.config?.provider === 'libretranslate' ? '请在扩展设置中填写 LibreTranslate 服务地址，再重试。' : '请先在扩展设置中选择免费引擎，或配置 AI 服务。');
    const pending = pendingBlocks(entry);
    pending.forEach((block) => entry.errors.delete(block.id));
    updateTranslationBlocks();
    const batches = makeTranslationBatches(pending);
    let cursor = 0, stopped = false, processed = 0;
    async function worker() {
      while (cursor < batches.length && valid() && !stopped) {
        const batch = batches[cursor++];
        const response = await send({ type: 'IT_TRANSLATE', sessionId: session, segments: batch });
        if (!valid()) return;
        for (const segment of batch) {
          const matches = response?.ok ? response.translations?.filter((item) => item.id === segment.id && typeof item.text === 'string' && item.text.trim()) : null;
          if (matches?.length === 1) { entry.translations.set(segment.id, matches[0].text); entry.errors.delete(segment.id); }
          else entry.errors.set(segment.id, friendly(response?.ok ? response.failures?.find((item) => item.id === segment.id)?.error : response?.error, '此段未返回译文，请重试。'));
        }
        processed += batch.length;
        if (!response?.ok && response?.error?.fatal) stopped = true;
        updateTranslationBlocks(); updateControls();
        status(`正在翻译当前页 · ${processed} / ${pending.length} 段`);
      }
    }
    await Promise.all([worker(), worker()]);
    if (!valid()) return;
    for (const block of pendingBlocks(entry)) if (!entry.errors.has(block.id)) entry.errors.set(block.id, '此段未完成翻译，请重试。');
    translating = false;
    updateTranslationBlocks(); updateControls();
    const missing = pendingBlocks(entry).length;
    if (missing) status(`${entry.translations.size ? '部分段落已完成。' : ''}${missing} 段未完成，可点击“重试未完成段落”。`, 'error');
    else status('当前页翻译完成 · 两种双语模式共用译文，切换即可继续阅读。', 'success');
  } catch (error) {
    if (!valid()) return;
    translating = false;
    for (const block of pendingBlocks(entry)) entry.errors.set(block.id, friendly(error));
    updateTranslationBlocks(); updateControls(); status(friendly(error), 'error');
  } finally {
    if (translationSession === session) {
      translationSession = null;
      void send({ type: 'IT_CANCEL_SESSION', sessionId: session });
    }
  }
}

function setMode(mode) {
  document.body.dataset.mode = mode;
  for (const [value, button] of [['compare', ui.modeCompare], ['reading', ui.modeReading], ['original', ui.modeOriginal]]) button.setAttribute('aria-pressed', String(value === mode));
  ui.translationTitle.textContent = mode === 'reading' ? '双语阅读' : `译文 · ${languageName(config?.targetLanguage)}`;
  ui.translationLayoutLabel.textContent = mode === 'reading' ? '原文后显示译文' : '段落重排';
  ui.syncScroll.disabled = mode !== 'compare';
  if (current && ui.zoomSelect.value === 'fit') void renderOriginal();
}

function syncScroll(from, to) {
  if (!ui.syncScroll.checked || document.body.dataset.mode !== 'compare' || syncFrame) return;
  const range = from.scrollHeight - from.clientHeight;
  const targetRange = to.scrollHeight - to.clientHeight;
  if (range <= 0 || targetRange <= 0) return;
  to.scrollTop = (from.scrollTop / range) * targetRange;
  syncFrame = requestAnimationFrame(() => requestAnimationFrame(() => { syncFrame = 0; }));
}

ui.openFile.addEventListener('click', () => ui.fileInput.click());
ui.chooseFile.addEventListener('click', () => ui.fileInput.click());
ui.fileInput.addEventListener('change', () => {
  const file = ui.fileInput.files?.[0];
  ui.fileInput.value = '';
  if (file) void loadDocument(file, file.name);
});
ui.urlForm.addEventListener('submit', (event) => {
  event.preventDefault();
  try { const url = safeDocumentURL(ui.urlInput.value.trim()); void loadDocument(url, nameFromURL(url)); }
  catch (error) { status(friendly(error), 'error'); }
});
ui.openSettings.addEventListener('click', async () => {
  const response = await send({ type: 'IT_OPEN_OPTIONS' });
  if (!response?.ok) status(friendly(response?.error), 'error');
});
ui.translateButton.addEventListener('click', () => {
  if (translating) cancelTranslation('翻译已取消。已完成的段落仍可阅读，点击继续可翻译剩余内容。');
  else void startTranslation();
});
ui.retryButton.addEventListener('click', () => void startTranslation());
ui.modeCompare.addEventListener('click', () => setMode('compare'));
ui.modeReading.addEventListener('click', () => setMode('reading'));
ui.modeOriginal.addEventListener('click', () => setMode('original'));
ui.outlineToggle.addEventListener('click', () => {
  ui.outlinePanel.hidden = !ui.outlinePanel.hidden;
  ui.outlineToggle.setAttribute('aria-expanded', String(!ui.outlinePanel.hidden));
  if (current && ui.zoomSelect.value === 'fit') void renderOriginal();
});
ui.previousPage.addEventListener('click', () => void showPage(pageNumber - 1));
ui.nextPage.addEventListener('click', () => void showPage(pageNumber + 1));
ui.pageNumber.addEventListener('change', () => void showPage(ui.pageNumber.value));
ui.pageNumber.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); void showPage(ui.pageNumber.value); } });
ui.zoomSelect.addEventListener('change', () => { if (current) void renderOriginal(); });
ui.originalScroll.addEventListener('scroll', () => syncScroll(ui.originalScroll, ui.translationScroll), { passive: true });
ui.translationScroll.addEventListener('scroll', () => syncScroll(ui.translationScroll, ui.originalScroll), { passive: true });
ui.passwordForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const callback = passwordCallback, value = ui.passwordInput.value;
  if (!callback || !value) return;
  closePassword(); callback(value);
});
function cancelPassword() {
  documentGeneration++; pageGeneration++;
  destroyDocument();
  ui.documentDetails.textContent = '文档尚未打开';
  status('已取消打开加密 PDF。可以重新选择文件并输入密码。');
  updateControls();
}
ui.passwordCancel.addEventListener('click', cancelPassword);
ui.passwordDialog.addEventListener('cancel', (event) => { event.preventDefault(); cancelPassword(); });
addEventListener('resize', () => {
  const narrow = innerWidth <= 580;
  if (narrow && !wasNarrow) {
    ui.outlinePanel.hidden = true;
    ui.outlineToggle.setAttribute('aria-expanded', 'false');
  }
  wasNarrow = narrow;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (current && ui.zoomSelect.value === 'fit') void renderOriginal(); }, 150);
});
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.type === 'IT_CONFIG_CHANGED') {
    cancelTranslation(); clearTranslations(); updateControls();
    status('翻译设置已更新，旧译文已清除。点击“翻译当前页”使用新设置。');
    void readConfig(); respond?.({ ok: true });
  }
  return false;
});
addEventListener('pagehide', () => {
  disposed = true; documentGeneration++; pageGeneration++; configGeneration++;
  clearTimeout(resizeTimer); if (syncFrame) cancelAnimationFrame(syncFrame);
  destroyDocument();
});

if (innerWidth <= 580) { ui.outlinePanel.hidden = true; ui.outlineToggle.setAttribute('aria-expanded', 'false'); }
void readConfig();
const query = new URLSearchParams(location.search);
const source = query.get('file');
if (source) {
  try { const url = safeDocumentURL(source); ui.urlInput.value = url; void loadDocument(url, nameFromURL(url), query.get('page')); }
  catch (error) { status(friendly(error), 'error'); }
}
