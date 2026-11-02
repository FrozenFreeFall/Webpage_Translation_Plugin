import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium, browserOptions, root } from './browser-helpers.mjs';

const sentence = 'Keep the original text visible while you read the translation.';
const definitions = ['Faithfulness to a person or cause.', 'Accuracy of a reproduced image or sound.'];
const translated = new Map([[sentence, '阅读译文时，保持原文可见。'], [definitions[0], '忠实；忠诚'], [definitions[1], '保真度；还原程度']]);
const markup = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Selection integration</title>
<style>body{margin:0;color:#20213a;font:18px/1.8 system-ui}main{padding:64px 80px;max-width:1000px}h1{font-size:30px}p{margin:15px 0}</style>
<main><h1>Reading with a dictionary</h1><p id="sentence">${sentence}</p>
<p id="word">The new renderer reproduces images with higher fidelity.</p>
<p>Keep technical explanations simple so readers can follow each idea without losing their place.</p>
<p>Several independent translation tools can work together while preserving the original page.</p>
<p>The page translation should continue when a temporary word dictionary is closed.</p>
<input id="private" value="Never send this private field"></main></html>`;

// A short real PCM WAV verifies the audio request without a remote file or decoder stub.
function pronunciation() {
  const samples = 800;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) bytes.writeInt16LE(Math.round(Math.sin(index / 8000 * 440 * Math.PI * 2) * 5000), 44 + index * 2);
  return bytes;
}

async function select(page, selector, text) {
  return page.evaluate(({ selector, text }) => {
    const node = document.querySelector(selector).firstChild;
    const range = document.createRange();
    const start = text === undefined ? 0 : node.textContent.indexOf(text);
    if (start < 0) throw new Error('Missing fixture text');
    range.setStart(node, start); range.setEnd(node, text === undefined ? node.textContent.length : start + text.length);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    const box = range.getBoundingClientRect();
    return { x: box.x, bottom: box.bottom };
  }, { selector, text });
}

test('real extension selects words beneath the anchor and keeps page translation independent', { timeout: 90000 }, async t => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'it-selection-integration-'));
  const context = await chromium.launchPersistentContext(profile, { ...browserOptions(), viewport: { width: 1280, height: 1000 }, args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`] });
  let releasePage;
  const pageGate = new Promise(resolve => { releasePage = resolve; });
  t.after(async () => {
    releasePage();
    await context.close();
    if (path.dirname(profile) === os.tmpdir() && path.basename(profile).startsWith('it-selection-integration-')) await rm(profile, { recursive: true, force: true });
  });
  const errors = [];
  const requests = { microsoft: [], dictionary: [], audio: [] };
  let holdPage = false, pendingPages = 0;
  // Block unconfigured web destinations; all feature traffic below is controlled.
  await context.route(/^https?:\/\//, route => route.abort());
  await context.route('https://selection.fixture.test/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: markup }));
  await context.route('https://edge.microsoft.com/translate/translatetext*', async route => {
    const text = route.request().postDataJSON();
    requests.microsoft.push({ text, headers: route.request().headers() });
    if (holdPage && text.some(item => !definitions.includes(item))) { pendingPages++; await pageGate; }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(text.map(item => ({ translations: [{ text: translated.get(item) || '整页译文：' + item.slice(0, 60), to: 'zh-Hans' }] }))) });
  });
  await context.route('https://api.dictionaryapi.dev/api/v2/entries/en/fidelity', async route => {
    requests.dictionary.push({ url: route.request().url(), headers: route.request().headers() });
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify([{
      word: 'fidelity', phonetic: '/fɪˈdel.ə.ti/',
      phonetics: [{ text: '/fɪˈdel.ə.ti/', audio: 'https://api.dictionaryapi.dev/media/pronunciations/en/fidelity-uk.wav' }],
      meanings: [{ partOfSpeech: 'noun', definitions: definitions.map(definition => ({ definition })) }],
      sourceUrls: ['https://en.wiktionary.org/wiki/fidelity'], license: { name: 'CC BY-SA 4.0', url: 'https://creativecommons.org/licenses/by-sa/4.0/' },
    }]) });
  });
  await context.route('https://api.dictionaryapi.dev/media/pronunciations/en/fidelity-uk.wav', async route => {
    requests.audio.push({ url: route.request().url(), headers: route.request().headers() });
    await route.fulfill({ contentType: 'audio/wav', body: pronunciation() });
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = new URL(worker.url()).host;
  assert.match(worker.url(), /src\/background.js$/);
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('https://selection.fixture.test/article');
  const ui = page.locator('#it-selection-root');
  const trigger = ui.getByRole('button', { name: '翻译所选文字', exact: true });
  const card = ui.getByRole('dialog');
  const ball = page.getByRole('button', { name: '翻译当前网页', exact: true });
  await ui.waitFor({ state: 'attached' }); await ball.waitFor();
  assert.equal(await page.locator('[data-it-translation]').count(), 0, 'a dormant selection host must not count as injected page translations');
  assert.equal(requests.microsoft.length + requests.dictionary.length + requests.audio.length, 0);
  await select(page, '#sentence');
  await trigger.waitFor({ state: 'visible' });
  assert.equal(requests.microsoft.length + requests.dictionary.length + requests.audio.length, 0, 'merely selecting text does not query a service');
  const image = await trigger.locator('img').evaluate(image => ({ src: image.src, loaded: image.complete && image.naturalWidth > 0 }));
  assert.equal(image.loaded, true, 'the real manifest must make the panda icon readable from the webpage');
  assert.equal(image.src, `chrome-extension://${extensionId}/assets/icons/icon-32.png`);
  await trigger.click();
  await card.getByText(translated.get(sentence), { exact: true }).waitFor();
  assert.deepEqual(requests.microsoft.map(call => call.text), [[sentence]]);
  await card.getByRole('button', { name: '关闭', exact: true }).click();

  const anchor = await select(page, '#word', 'fidelity');
  await trigger.click();
  await card.getByText('忠实；忠诚', { exact: true }).waitFor();
  assert.match(await card.innerText(), /n\. 名词/);
  assert.match(await card.innerText(), /fɪˈdel.ə.ti/);
  await card.getByText('保真度；还原程度', { exact: true }).waitFor();
  assert.equal(requests.dictionary.length, 1);
  assert.deepEqual(requests.microsoft.at(-1).text, definitions);
  assert.equal(requests.audio.length, 0, 'dictionary audio is not fetched with word data');
  const box = await card.boundingBox();
  assert.ok(Math.abs(box.y - anchor.bottom - 8) <= 2, 'the real word card should sit 8px beneath its selected word');
  assert.ok(Math.abs(box.x - anchor.x) <= 2, 'the real word card should align with the selected word');
  const pronounce = card.locator('.pronounce');
  await pronounce.click();
  await page.waitForFunction(() => {
    const button = document.querySelector('#it-selection-root').shadowRoot.querySelector('.pronounce');
    return !button.disabled && !button.textContent.includes('加载');
  });
  assert.equal(requests.audio.length, 1, 'an explicit pronunciation click fetches only its approved source');
  assert.doesNotMatch(await pronounce.innerText(), /失败/);
  for (const request of [...requests.microsoft, ...requests.dictionary, ...requests.audio]) {
    assert.equal(request.headers.cookie, undefined);
    assert.equal(request.headers.referer, undefined);
    assert.equal(request.headers.authorization, undefined);
  }
  await card.getByRole('button', { name: '关闭', exact: true }).click();

  holdPage = true;
  await ball.click();
  await page.getByRole('button', { name: '翻译中，点击取消并还原', exact: true }).waitFor();
  for (let attempt = 0; attempt < 30 && !pendingPages; attempt++) await page.waitForTimeout(50);
  assert.ok(pendingPages > 0, 'the ordinary page session must actually be in flight');
  await select(page, '#word', 'fidelity');
  await trigger.click();
  await card.getByText('忠实；忠诚', { exact: true }).waitFor();
  assert.equal(requests.audio.length, 1, 'opening another word card does not replay pronunciation');
  await card.getByRole('button', { name: '关闭', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '翻译中，点击取消并还原', exact: true }).isVisible(), true);
  holdPage = false; releasePage();
  await page.getByRole('button', { name: '显示原文', exact: true }).waitFor();
  const count = await page.locator('[data-it-translation]').count();
  assert.ok(count >= 5, 'closing the word task must let the real ordinary session finish');
  const popup = await context.newPage();
  popup.on('pageerror', error => errors.push(error.message));
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.waitForFunction(() => !document.querySelector('#selectionEnabled').disabled);
  await popup.locator('#selectionEnabled').uncheck();
  await popup.waitForFunction(() => !document.querySelector('#selectionEnabled').disabled);
  assert.match(await popup.locator('#status').innerText(), /已关闭/);
  assert.equal(await page.locator('[data-it-translation]').count(), count, 'the dedicated preference switch must not restore ordinary translations');
  await select(page, '#sentence');
  await page.waitForTimeout(150);
  assert.equal(await trigger.isVisible(), false);
  assert.equal(await page.getByRole('button', { name: '显示原文', exact: true }).isVisible(), true);
  await page.getByRole('button', { name: '显示原文', exact: true }).click();
  assert.equal(await page.locator('[data-it-translation]').count(), 0);
  assert.doesNotMatch(JSON.stringify(requests), /Never send this private field/);
  assert.deepEqual(errors, []);
});
