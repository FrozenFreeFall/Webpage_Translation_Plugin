import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium, browserOptions, root } from './browser-helpers.mjs';

const sampleUrl = 'https://pdf.fixture.test/guide.pdf';
const fixture = name => path.join(root, 'tests/fixtures', name);
const translations = page => page.locator('#translationContent .translated-text:not(.is-pending):not(.is-error)');

async function extension(t) {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'it-pdf-test-'));
  const context = await chromium.launchPersistentContext(profile, {
    ...browserOptions(),
    viewport: { width: 1440, height: 1000 },
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
  });
  t.after(async () => {
    await context.close();
    if (path.dirname(profile) === os.tmpdir() && path.basename(profile).startsWith('it-pdf-test-')) await rm(profile, { recursive: true, force: true });
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
  const base = `chrome-extension://${new URL(worker.url()).host}`;
  const sample = await readFile(fixture('sample.pdf'));
  await context.route(sampleUrl, route => route.fulfill({ contentType: 'application/pdf', body: sample }));
  const errors = [];
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  return { context, page, base, errors };
}

async function openSample(page, base, number = 1) {
  await page.goto(`${base}/pdf.html?file=${encodeURIComponent(sampleUrl)}&page=${number}`);
  await ready(page, number);
}

async function ready(page, number = 1) {
  await page.waitForFunction(expected => {
    const canvas = document.querySelector('#pdfCanvas');
    const button = document.querySelector('#translateButton');
    return Number(document.querySelector('#pageNumber')?.value) === expected
      && canvas?.width > 0 && canvas?.height > 0 && canvas.dataset.rendered === 'true' && button && !button.disabled;
  }, number);
}

async function translated(page) {
  await page.waitForFunction(() => document.querySelector('#translateButton')?.dataset.state === 'translated');
  const text = (await translations(page).allTextContents()).filter(value => value.trim());
  assert.ok(text.length > 0, 'at least one extracted paragraph has a visible translation');
  return text;
}

async function waitForTransport(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(predicate(), 'the expected provider request reached the HTTP boundary');
}

function response(body, label = '测试译文', target = 'zh-Hans') {
  return JSON.stringify(body.map((_, index) => ({ translations: [{ text: `${label} ${index + 1}（${target}）`, to: target }] })));
}

async function microsoft(context, handler) {
  const calls = [];
  await context.route('https://edge.microsoft.com/translate/translatetext*', async route => {
    const body = route.request().postDataJSON();
    const target = new URL(route.request().url()).searchParams.get('to');
    const call = { body, target, headers: route.request().headers() };
    calls.push(call);
    if (handler) await handler(route, call, calls.length);
    else await route.fulfill({ contentType: 'application/json', body: response(body, '测试译文', target) });
  });
  return calls;
}

async function saveTarget(context, base, target) {
  const options = await context.newPage();
  await options.goto(`${base}/options.html`);
  await options.locator('#targetLanguage').selectOption(target);
  await options.locator('#consent').check();
  await options.locator('#save').click();
  await options.waitForFunction(() => document.querySelector('#status').textContent.includes('已保存'));
  await options.close();
}

test('PDF entry: real content click opens a new reader using the source URL without translating', { timeout: 30000 }, async t => {
  const { context, page, base, errors } = await extension(t);
  const calls = await microsoft(context);
  const source = 'https://pdf.fixture.test/download?document=guide#page=2';
  const sample = await readFile(fixture('sample.pdf'));
  // An ordinary HTML fixture exercises PDF detection and the real message/tab
  // route. It makes no claim about a browser's native PDF viewer or its UI.
  await context.route('https://pdf.fixture.test/download*', route => route.fulfill(route.request().resourceType() === 'document'
    ? { contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>PDF source fixture</title><main><p id="sourceNote">Keep this original tab open.</p><embed type="application/pdf" hidden></main>' }
    : { contentType: 'application/pdf', body: sample }));
  await page.goto(source);
  const opened = context.waitForEvent('page');
  await page.getByRole('button', { name: '翻译当前 PDF', exact: true }).click();
  const reader = await opened;
  reader.setDefaultTimeout(10000);
  reader.on('pageerror', error => errors.push(error.message));
  await reader.waitForURL(`${base}/pdf.html?*`);
  const route = new URL(reader.url());
  assert.equal(route.searchParams.get('file'), 'https://pdf.fixture.test/download?document=guide');
  assert.equal(route.searchParams.get('page'), '2');
  await ready(reader, 2);
  await reader.waitForTimeout(100);
  assert.equal(await reader.locator('#pageTotal').textContent(), '2');
  assert.equal(await reader.locator('#translateButton').getAttribute('data-state'), 'idle');
  assert.equal(calls.length, 0, 'opening from the source page must wait for explicit reader translation');
  assert.equal(page.isClosed(), false);
  assert.equal(page.url(), source);
  assert.equal(await page.locator('#sourceNote').textContent(), 'Keep this original tab open.');
  assert.equal(await page.locator('[data-it-translation]').count(), 0);
  assert.deepEqual(errors, []);
});

test('PDF reader: real PDF.js canvas and extraction, explicit current-page translation, shared bilingual modes', { timeout: 45000 }, async t => {
  const { context, page, base, errors } = await extension(t);
  const calls = await microsoft(context);
  await openSample(page, base);
  assert.equal(await page.locator('#pageTotal').textContent(), '2');
  assert.equal(await page.locator('#modeCompare').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#translateButton').getAttribute('data-state'), 'idle');
  await page.waitForTimeout(100);
  assert.equal(calls.length, 0, 'opening a PDF must not send its text to a provider');
  const pixels = await page.locator('#pdfCanvas').evaluate(canvas => {
    const bytes = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let dark = 0, colored = 0;
    for (let i = 0; i < bytes.length; i += 100) {
      if (bytes[i + 3] > 0 && bytes[i] < 140 && bytes[i + 1] < 140 && bytes[i + 2] < 140) dark++;
      if (bytes[i + 3] > 0 && bytes[i + 2] > bytes[i] + 20) colored++;
    }
    return { dark, colored };
  });
  assert.ok(pixels.dark > 50, 'source text was rendered into a real canvas');
  assert.ok(pixels.colored > 20, 'the PDF figure is retained in the rendered source');
  await page.locator('#translateButton').click();
  const first = await translated(page);
  assert.ok(calls.length > 0);
  const sent = JSON.stringify(calls.map(call => call.body));
  assert.match(sent, /This original document explains/);
  assert.doesNotMatch(sent, /privateExample|return value|Second page|Changing pages/);
  assert.ok(calls.every(call => !call.headers.authorization && !call.headers.cookie));
  const count = calls.length;
  await page.locator('#modeReading').click();
  assert.equal(await page.locator('body').getAttribute('data-mode'), 'reading');
  assert.equal(await page.locator('#modeReading').getAttribute('aria-pressed'), 'true');
  assert.match(await page.locator('#translationContent').textContent(), /A small guide to reliable PDF reading/);
  assert.match(await page.locator('#translationContent').textContent(), /function privateExample\(value\)\s*\{\s*return value \* 2;\s*\}/);
  assert.ok(await page.locator('#translationContent .source-text:visible').count() > 0);
  assert.deepEqual(await translations(page).allTextContents().then(text => text.filter(value => value.trim())), first);
  await page.locator('#modeCompare').click();
  assert.equal(await page.locator('body').getAttribute('data-mode'), 'compare');
  assert.deepEqual(await translations(page).allTextContents().then(text => text.filter(value => value.trim())), first);
  await page.waitForTimeout(100);
  assert.equal(calls.length, count, 'switching bilingual modes reuses the current page result');
  await mkdir(path.join(root, 'tests/artifacts'), { recursive: true });
  await page.screenshot({ path: path.join(root, 'tests/artifacts/pdf-compare-desktop.png'), fullPage: true });
  await page.locator('#modeReading').click();
  await page.setViewportSize({ width: 390, height: 844 });
  if (await page.locator('#outlineToggle').getAttribute('aria-expanded') === 'true') await page.locator('#outlineToggle').click();
  await page.screenshot({ path: path.join(root, 'tests/artifacts/pdf-reading-narrow.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'the narrow reader does not overflow the viewport');
  assert.deepEqual(errors, []);
});

test('PDF reader: navigation and explicit cancellation discard late responses', { timeout: 45000 }, async t => {
  const { context, page, base, errors } = await extension(t);
  const pending = [];
  const calls = await microsoft(context, (route, call) => new Promise(resolve => pending.push(async label => {
    try { await route.fulfill({ contentType: 'application/json', body: response(call.body, label) }); }
    catch { /* A cancelled real fetch may already have released the route. */ }
    resolve();
  })));
  t.after(async () => { for (const release of pending.splice(0)) await release('cleanup'); });
  await openSample(page, base);
  await page.locator('#translateButton').click();
  await page.waitForFunction(() => document.querySelector('#translateButton')?.dataset.state === 'loading');
  await waitForTransport(() => pending.length === 1);
  assert.equal(pending.length, 1);
  await page.locator('#nextPage').click();
  await ready(page, 2);
  await pending.shift()('过期的第一页译文');
  // Let the released HTTP response and extension message cross process boundaries.
  await page.waitForTimeout(100);
  await page.locator('#modeReading').click();
  assert.match(await page.locator('#translationContent').textContent(), /Second page: lifecycle/);
  assert.doesNotMatch(await page.locator('#translationContent').textContent(), /过期的第一页译文|A small guide/);
  assert.equal(calls.length, 1, 'navigating does not automatically translate the next page');
  await page.locator('#translateButton').click();
  await page.waitForFunction(() => document.querySelector('#translateButton')?.dataset.state === 'loading');
  await waitForTransport(() => pending.length === 1);
  assert.equal(pending.length, 1);
  await page.locator('#translateButton').click();
  await pending.shift()('已取消的第二页译文');
  await page.waitForFunction(() => document.querySelector('#translateButton')?.dataset.state !== 'loading');
  await page.waitForTimeout(100);
  assert.doesNotMatch(await page.locator('#translationContent').textContent(), /已取消的第二页译文/);
  assert.equal(calls.length, 2);
  assert.deepEqual(errors, []);
});

test('PDF reader: local file picker, image-only PDF, invalid PDF and failed download are recoverable', { timeout: 45000 }, async t => {
  const { context, page, base, errors } = await extension(t);
  const calls = await microsoft(context);
  await page.goto(`${base}/pdf.html`);
  await page.locator('#fileInput').setInputFiles(fixture('sample.pdf'));
  await ready(page);
  assert.equal(await page.locator('#pageTotal').textContent(), '2');
  await page.locator('#modeReading').click();
  assert.match(await page.locator('#translationContent').textContent(), /A small guide/);
  await page.locator('#fileInput').setInputFiles(fixture('scanned.pdf'));
  await page.waitForFunction(() => /暂无可提取文字|没有可提取|未提取到|扫描/.test(document.querySelector('#status')?.textContent || ''));
  assert.equal(await page.locator('#translateButton').isDisabled(), true);
  assert.equal(await page.locator('#pageTotal').textContent(), '1');
  await page.locator('#fileInput').setInputFiles(fixture('invalid.pdf'));
  await page.waitForFunction(() => document.querySelector('#status')?.dataset.kind === 'error');
  assert.equal(await page.locator('#translateButton').isDisabled(), true);
  assert.ok((await page.locator('#status').textContent()).length > 10, 'invalid files receive an actionable error');
  let failedDownloadRequested = false;
  await context.route('https://pdf.fixture.test/unavailable.pdf', route => {
    failedDownloadRequested = true;
    return route.fulfill({ status: 503, body: 'Unavailable' });
  });
  await page.locator('#urlInput').fill('https://pdf.fixture.test/unavailable.pdf');
  await page.locator('#urlInput').press('Enter');
  await waitForTransport(() => failedDownloadRequested);
  await page.waitForFunction(() => document.querySelector('#status')?.dataset.kind === 'error' && /网络|下载|获取|503/.test(document.querySelector('#status')?.textContent || ''));
  await page.locator('#fileInput').setInputFiles(fixture('sample.pdf'));
  await ready(page);
  assert.equal(await page.locator('#pageTotal').textContent(), '2');
  assert.equal(calls.length, 0);
  assert.deepEqual(errors, []);
});

test('PDF reader: provider errors can retry and saving settings invalidates translated and pending results', { timeout: 45000 }, async t => {
  const { context, page, base, errors } = await extension(t);
  let fail = true, hold = false, release;
  const calls = await microsoft(context, async (route, call) => {
    if (fail) return route.fulfill({ status: 400, contentType: 'application/json', body: '{"error":{"message":"fixture rejection"}}' });
    if (hold) await new Promise(resolve => { release = resolve; });
    try { await route.fulfill({ contentType: 'application/json', body: response(call.body, '配置对应译文', call.target) }); }
    catch { /* Settings changes abort the provider fetch. */ }
  });
  t.after(() => release?.());
  await openSample(page, base);
  await page.locator('#translateButton').click();
  await page.locator('#retryButton').waitFor({ state: 'visible' });
  assert.ok((await page.locator('#status').textContent()).trim().length > 0);
  fail = false;
  await page.locator('#retryButton').click();
  await translated(page);
  assert.equal(calls.at(-1).target, 'zh-Hans');
  const before = calls.length;
  await saveTarget(context, base, 'en');
  await page.waitForFunction(() => ![...document.querySelectorAll('#translationContent .translated-text:not(.is-pending):not(.is-error)')].some(element => element.textContent.trim()));
  assert.doesNotMatch(await page.locator('#translationContent').textContent(), /配置对应译文/);
  assert.equal(calls.length, before, 'saving settings clears results without sending more PDF text');
  await page.locator('#translateButton').click();
  await translated(page);
  assert.equal(calls.at(-1).target, 'en');
  await saveTarget(context, base, 'zh-CN');
  await page.waitForFunction(() => document.querySelector('#translateButton')?.dataset.state === 'idle');
  hold = true;
  await page.locator('#translateButton').click();
  await page.waitForFunction(() => document.querySelector('#translateButton')?.dataset.state === 'loading');
  await waitForTransport(() => typeof release === 'function');
  assert.equal(typeof release, 'function');
  await saveTarget(context, base, 'en');
  release();
  await page.waitForFunction(() => document.querySelector('#translateButton')?.dataset.state === 'idle');
  await page.waitForTimeout(100);
  assert.equal((await translations(page).allTextContents()).filter(value => value.trim()).length, 0);
  assert.deepEqual(errors, []);
});
