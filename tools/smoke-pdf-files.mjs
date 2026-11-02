// Usage: node tools/smoke-pdf-files.mjs [--live-microsoft] <local.pdf> [more.pdf ...]
// Uses real unpacked-extension PDF.js rendering and a controlled HTTP provider.
// Source documents are read in place. Artifacts contain aggregate stats/images,
// never extracted source text or provider payloads.
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { chromium, browserOptions, root } from '../tests/browser-helpers.mjs';
import { translateSegments } from '../src/translator.js';
import { DEFAULT_SETTINGS } from '../src/shared.js';

const liveMicrosoft = process.argv.includes('--live-microsoft');
const files = process.argv.slice(2).filter(argument => argument !== '--live-microsoft');
if (!files.length) throw new Error('Pass one or more local PDF file paths.');
const artifacts = path.join(root, 'tests/artifacts');
await mkdir(artifacts, { recursive: true });
const profile = await mkdtemp(path.join(os.tmpdir(), 'it-real-pdf-smoke-'));
let context;
const reports = [];
const hash = value => createHash('sha256').update(value).digest('hex');

async function rendered(page, number) {
  await page.waitForFunction(expected => {
    const canvas = document.querySelector('#pdfCanvas');
    return Number(document.querySelector('#pageNumber')?.value) === expected
      && canvas?.dataset.rendered === 'true' && canvas.width > 0 && canvas.height > 0;
  }, number, { timeout: 60000 });
}

async function navigate(page, number) {
  const current = Number(await page.locator('#pageNumber').inputValue());
  if (current === number) return rendered(page, number);
  const previous = await page.locator('#pdfCanvas').elementHandle();
  await page.locator('#pageNumber').fill(String(number));
  await page.locator('#pageNumber').press('Tab');
  await page.waitForFunction(canvas => !canvas.isConnected, previous, { timeout: 60000 });
  await rendered(page, number);
}

async function pageStats(page, number) {
  return page.evaluate(number => {
    const canvas = document.querySelector('#pdfCanvas');
    const bytes = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let ink = 0;
    for (let i = 0; i < bytes.length; i += 100) if (bytes[i + 3] && (bytes[i] < 230 || bytes[i + 1] < 230 || bytes[i + 2] < 230)) ink++;
    const originals = [...document.querySelectorAll('#translationContent .source-text')];
    const code = [...document.querySelectorAll('#translationContent .source-code')];
    return {
      page: number, canvasWidth: canvas.width, canvasHeight: canvas.height,
      sampledInkPixels: ink, textBlocks: originals.length,
      textCharacters: originals.reduce((sum, element) => sum + element.textContent.length, 0),
      codeBlocks: code.length, codeCharacters: code.reduce((sum, element) => sum + element.textContent.length, 0),
      figures: document.querySelectorAll('#translationContent .figure-block').length,
    };
  }, number);
}

try {
  context = await chromium.launchPersistentContext(profile, {
    ...browserOptions(), viewport: { width: 1440, height: 1000 },
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
  const base = `chrome-extension://${new URL(worker.url()).host}`;
  let currentReport, sentTexts = [];
  await context.route('https://edge.microsoft.com/translate/translatetext*', async route => {
    const body = route.request().postDataJSON();
    sentTexts.push(...body);
    currentReport.translation.requests++;
    currentReport.translation.sentSegments += body.length;
    currentReport.translation.sentCharacters += body.reduce((sum, text) => sum + text.length, 0);
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body.map((_, index) => ({ translations: [{ text: `受控接口测试译文 · 第 ${index + 1} 段`, to: 'zh-Hans' }] }))) });
  });
  for (const [index, file] of files.entries()) {
    const info = await stat(file);
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    currentReport = { file: path.basename(file), bytes: info.size, pages: [], translation: { requests: 0, sentSegments: 0, sentCharacters: 0 }, pageErrors: errors };
    sentTexts = [];
    reports.push(currentReport);
    console.log(JSON.stringify({ phase: 'opening', file: currentReport.file, bytes: info.size }));
    await page.goto(`${base}/pdf.html`);
    await page.locator('#fileInput').setInputFiles(file);
    await rendered(page, 1);
    const count = Number(await page.locator('#pageTotal').textContent());
    currentReport.pageCount = count;
    assert.ok(count > 1);
    for (const number of [...new Set([1, Math.min(5, count), Math.min(10, count), count, Math.min(22, count), Math.min(50, count)])]) {
      await navigate(page, number);
      const stats = await pageStats(page, number);
      currentReport.pages.push(stats);
      assert.ok(stats.sampledInkPixels > 10, 'the actual page contains rendered artwork or text');
      console.log(JSON.stringify({ phase: 'rendered', file: currentReport.file, ...stats }));
    }
    assert.equal(currentReport.translation.requests, 0, 'loading/navigating must not send document text');
    // Prefer a later body page with code, then a later page with ordinary prose.
    const chosen = [...currentReport.pages].reverse().find(item => item.page >= 15 && item.codeBlocks && item.textBlocks)
      || [...currentReport.pages].reverse().find(item => item.page >= 15 && item.page !== count && item.textBlocks)
      || currentReport.pages.find(item => item.textBlocks);
    assert.ok(chosen, 'a tested page has extractable prose for explicit translation');
    await navigate(page, chosen.page);
    const codeBefore = await page.locator('#translationContent .source-code').allTextContents();
    const codeHash = hash(JSON.stringify(codeBefore));
    await page.locator('#translateButton').click();
    await page.waitForFunction(() => document.querySelector('#translateButton')?.dataset.state === 'translated', null, { timeout: 60000 });
    const completed = () => page.locator('#translationContent .translated-text:not(.is-pending):not(.is-error)').allTextContents();
    const originalResults = await completed();
    assert.ok(originalResults.length > 0);
    const requestCount = currentReport.translation.requests;
    for (const code of codeBefore) for (const line of code.split('\n').map(value => value.trim()).filter(value => value.length >= 16)) {
      assert.ok(!sentTexts.some(text => text.includes(line)), 'source code must not be submitted as prose');
    }
    await page.screenshot({ path: path.join(artifacts, `real-pdf-${index + 1}-compare.png`), fullPage: true });
    await page.locator('#modeReading').click();
    assert.deepEqual(await completed(), originalResults);
    assert.equal(hash(JSON.stringify(await page.locator('#translationContent .source-code').allTextContents())), codeHash);
    await page.screenshot({ path: path.join(artifacts, `real-pdf-${index + 1}-reading.png`), fullPage: true });
    await page.locator('#modeCompare').click();
    assert.deepEqual(await completed(), originalResults);
    await page.waitForTimeout(100);
    assert.equal(currentReport.translation.requests, requestCount, 'mode switches must reuse the completed result');
    assert.deepEqual(errors, []);
    currentReport.translation = { ...currentReport.translation, page: chosen.page, translatedBlocks: originalResults.length, sharedModes: true, unchangedCodeBlocks: codeBefore.length, codeSubmitted: false, requestsBeforeExplicitClick: 0 };
    currentReport.result = 'passed';
    console.log(JSON.stringify({ phase: 'complete', file: currentReport.file, pageCount: count, translation: currentReport.translation }));
    if (liveMicrosoft) {
      const paragraphs = await page.locator('#translationContent .source-text').allTextContents();
      const prose = (paragraphs.find(text => text.length >= 50 && text.length <= 1000) || paragraphs.find(text => text.length >= 50) || paragraphs[0]).slice(0, 1000);
      const live = { provider: 'microsoft', sourceCharacters: prose.length, httpStatuses: [], timeoutMs: 20000 };
      const started = Date.now();
      try {
        const result = await translateSegments({ ...DEFAULT_SETTINGS, provider: 'microsoft', targetLanguage: 'zh-CN', apiKey: '' }, [{ id: 'real_pdf_short_prose', text: prose }], {
          timeoutMs: 20000,
          fetchImpl: async (...arguments_) => { const result = await fetch(...arguments_); live.httpStatuses.push(result.status); return result; },
        });
        live.resultCharacters = result.translations[0]?.text.length || 0;
        live.result = live.resultCharacters > 0 ? 'passed' : 'empty';
      } catch (error) {
        live.result = 'failed';
        live.errorCode = error.code || error.name;
        live.message = error.message;
      }
      live.elapsedMs = Date.now() - started;
      currentReport.liveMicrosoft = live;
      console.log(JSON.stringify({ phase: 'live-microsoft', file: currentReport.file, ...live }));
    }
    await page.close();
  }
} catch (error) {
  console.error(error.stack || error.message);
  if (reports.length) reports.at(-1).result = 'failed';
  process.exitCode = 1;
} finally {
  await writeFile(path.join(artifacts, 'real-pdf-smoke.json'), JSON.stringify({ generatedAt: new Date().toISOString(), reports }, null, 2));
  if (context) await context.close();
  if (path.dirname(profile) === os.tmpdir() && path.basename(profile).startsWith('it-real-pdf-smoke-')) await rm(profile, { recursive: true, force: true });
}
