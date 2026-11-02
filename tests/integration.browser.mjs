import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { chromium, browserOptions, root } from './browser-helpers.mjs';

test('unpacked extension: real worker, options, content, mocked HTTP transport and restore', { timeout: 60000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'it-extension-test-'));
  const context = await chromium.launchPersistentContext(profile, {
    ...browserOptions(),
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
  });
  t.after(async () => {
    await context.close();
    if (path.dirname(profile) === os.tmpdir() && path.basename(profile).startsWith('it-extension-test-')) await rm(profile, { recursive: true, force: true });
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = new URL(worker.url()).host;
  assert.match(worker.url(), /src\/background.js$/);
  const calls = [];
  await context.route('https://model.fixture.test/**', async (route) => {
    const body = route.request().postDataJSON();
    calls.push({ body, authorization: route.request().headers().authorization });
    const segments = JSON.parse(body.messages[1].content).segments;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ translations: segments.map(({ id }) => ({ id, text: '这是一段用于验证翻译链路的中文译文。' })) }) } }] }) });
  });
  const optionsPage = await context.newPage();
  const errors = [];
  optionsPage.on('pageerror', (error) => errors.push(error.message));
  await optionsPage.goto(`chrome-extension://${extensionId}/options.html`);
  await optionsPage.locator('#provider').selectOption('ai');
  await optionsPage.locator('#endpoint').fill('https://model.fixture.test');
  await optionsPage.locator('#model').fill('fixture-model');
  await optionsPage.locator('#apiKey').fill('integration-key-not-real');
  await optionsPage.locator('#consent').check();
  await optionsPage.getByRole('button', { name: '保存设置', exact: true }).click();
  await optionsPage.waitForFunction(() => document.querySelector('#status').textContent.includes('已保存'));
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  const html = await readFile(path.join(root, 'tests/fixtures/article.html'), 'utf8');
  await page.route('https://article.fixture.test/**', (route) => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('https://article.fixture.test/article');
  const ball = page.getByRole('button', { name: '翻译当前网页', exact: true });
  await ball.waitFor();
  assert.equal(calls.length, 0);
  await page.locator('#note').fill('Still my private note');
  await ball.click();
  await page.getByRole('button', { name: '显示原文', exact: true }).waitFor();
  assert.ok(await page.locator('[data-it-translation]').count() >= 5);
  assert.ok(calls.length > 0);
  assert.equal(calls[0].authorization, 'Bearer integration-key-not-real');
  const payload = JSON.stringify(calls.map((call) => call.body));
  assert.doesNotMatch(payload, /Still my private note|Hidden text|privateExample/);
  await mkdir(path.join(root, 'tests/artifacts'), { recursive: true });
  await page.screenshot({ path: path.join(root, 'tests/artifacts/translation.png'), fullPage: true });
  await optionsPage.screenshot({ path: path.join(root, 'tests/artifacts/options.png'), fullPage: true });
  await page.getByRole('button', { name: '显示原文', exact: true }).click();
  assert.equal(await page.locator('[data-it-translation]').count(), 0);
  assert.equal(await page.locator('#note').inputValue(), 'Still my private note');
  const publicResult = await optionsPage.evaluate(() => chrome.tabs.query({}).then((tabs) => chrome.tabs.sendMessage(tabs.find((tab) => tab.url?.startsWith('https://article.fixture.test')).id, { type: 'IT_PAGE_STATUS' })));
  assert.equal(publicResult.state, 'original');
  const strict = await context.newPage();
  await strict.route('https://strict.fixture.test/**', (route) => route.fulfill({
    contentType: 'text/html', headers: { 'Content-Security-Policy': "default-src 'none'; style-src 'none'" },
    body: '<!doctype html><main><p>A page with a strict content security policy.</p></main>',
  }));
  await strict.goto('https://strict.fixture.test/');
  await strict.getByRole('button', { name: '翻译当前网页', exact: true }).waitFor();
  assert.equal(await strict.evaluate(() => getComputedStyle(document.querySelector('#it-translation-root').shadowRoot.querySelector('.ball')).width), '82px');
  assert.deepEqual(errors, []);
});

test('unpacked extension: free providers work without a key and switching restores old translation', { timeout: 60000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'it-extension-test-'));
  const context = await chromium.launchPersistentContext(profile, { ...browserOptions(), args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`] });
  t.after(async () => {
    await context.close();
    if (path.dirname(profile) === os.tmpdir() && path.basename(profile).startsWith('it-extension-test-')) await rm(profile, { recursive: true, force: true });
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = new URL(worker.url()).host;
  const calls = [];
  await context.route('https://edge.microsoft.com/translate/translatetext*', async (route) => {
    const body = route.request().postDataJSON();
    calls.push({ provider: 'microsoft', headers: route.request().headers(), body });
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body.map(() => ({ translations: [{ text: '微软免费译文', to: 'zh-Hans' }] }))) });
  });
  await context.route('https://translate.googleapis.com/**', async (route) => {
    const body = route.request().postData();
    calls.push({ provider: 'google', headers: route.request().headers(), body });
    const text = new URLSearchParams(body).get('q');
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify([[['谷歌免费译文', text, null, null]], null, 'en']) });
  });
  const optionsPage = await context.newPage();
  await optionsPage.goto(`chrome-extension://${extensionId}/options.html`);
  assert.equal(await optionsPage.locator('#provider').inputValue(), 'microsoft');
  assert.equal(await optionsPage.locator('#apiKey').isVisible(), false);
  const page = await context.newPage();
  await page.route('https://article.fixture.test/**', (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><html lang="en"><main><p>Hello, free webpage translation.</p><input id="private" value="PRIVATE_INPUT"></main></html>' }));
  await page.goto('https://article.fixture.test/free');
  await page.getByRole('button', { name: '翻译当前网页', exact: true }).click();
  await page.getByRole('button', { name: '显示原文', exact: true }).waitFor();
  assert.equal(await page.locator('[data-it-translation]').innerText(), '微软免费译文');
  assert.equal(calls[0].provider, 'microsoft');
  await optionsPage.locator('#provider').selectOption('google');
  await optionsPage.locator('#consent').check();
  await optionsPage.getByRole('button', { name: '保存设置', exact: true }).click();
  await optionsPage.waitForFunction(() => document.querySelector('#status').textContent.includes('已保存'));
  await page.getByRole('button', { name: '翻译当前网页', exact: true }).waitFor();
  assert.equal(await page.locator('[data-it-translation]').count(), 0);
  await page.getByRole('button', { name: '翻译当前网页', exact: true }).click();
  await page.getByRole('button', { name: '显示原文', exact: true }).waitFor();
  assert.equal(await page.locator('[data-it-translation]').innerText(), '谷歌免费译文');
  assert.equal(calls.at(-1).provider, 'google');
  assert.ok(calls.every((call) => !call.headers.authorization && !call.headers.cookie));
  assert.doesNotMatch(JSON.stringify(calls.map((call) => call.body)), /PRIVATE_INPUT/);
  await optionsPage.reload();
  assert.equal(await optionsPage.locator('#provider').inputValue(), 'google');
  await mkdir(path.join(root, 'tests/artifacts'), { recursive: true });
  await optionsPage.screenshot({ path: path.join(root, 'tests/artifacts/free-options.png'), fullPage: true });
  await page.getByRole('button', { name: '显示原文', exact: true }).click();
  assert.equal(await page.locator('#private').inputValue(), 'PRIVATE_INPUT');
});

test('unpacked extension: LibreTranslate uses a configured local HTTP instance and independent optional key', { timeout: 60000 }, async t => {
  const received = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      try {
        const body = JSON.parse(raw);
        received.push({ url: request.url, headers: request.headers, body });
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ translatedText: body.q.map((_, index) => `本地接口测试译文 ${index + 1}`) }));
      } catch { response.writeHead(400); response.end('{}'); }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const instance = `http://127.0.0.1:${server.address().port}/proxy`;
  const profile = await mkdtemp(path.join(os.tmpdir(), 'it-extension-test-'));
  const context = await chromium.launchPersistentContext(profile, { ...browserOptions(), args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`] });
  t.after(async () => {
    await context.close();
    if (path.dirname(profile) === os.tmpdir() && path.basename(profile).startsWith('it-extension-test-')) await rm(profile, { recursive: true, force: true });
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = new URL(worker.url()).host;
  const optionsPage = await context.newPage();
  await optionsPage.goto(`chrome-extension://${extensionId}/options.html`);
  await optionsPage.locator('#provider').selectOption('ai');
  await optionsPage.locator('#apiKey').fill('do-not-leak-ai-key');
  await optionsPage.locator('#provider').selectOption('libretranslate');
  await optionsPage.locator('#libreEndpoint').fill(instance);
  await optionsPage.locator('#consent').check();
  await optionsPage.locator('#test').click();
  await optionsPage.waitForFunction(() => !document.querySelector('#test').disabled && document.querySelector('#status').textContent.includes('连接成功'));
  assert.equal(received.length, 1);
  assert.equal(received[0].url, '/proxy/translate');
  assert.deepEqual(received[0].body, { q: ['Hello, welcome to this webpage.'], source: 'auto', target: 'zh', format: 'text' });
  await optionsPage.locator('#save').click();
  await optionsPage.waitForFunction(() => document.querySelector('#status').textContent.includes('已保存'));
  const page = await context.newPage();
  await page.route('https://article.fixture.test/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><html lang="en"><main><p>First local article paragraph.</p><p>Second local article paragraph.</p><input id="note" value="PRIVATE_INPUT"></main></html>' }));
  await page.goto('https://article.fixture.test/libre');
  await page.getByRole('button', { name: '翻译当前网页', exact: true }).click();
  await page.getByRole('button', { name: '显示原文', exact: true }).waitFor();
  assert.deepEqual(await page.locator('[data-it-translation]').allTextContents(), ['本地接口测试译文 1', '本地接口测试译文 2']);
  await optionsPage.locator('#libreApiKey').fill('instance-only-key');
  await optionsPage.locator('#test').click();
  await optionsPage.waitForFunction(() => !document.querySelector('#test').disabled && document.querySelector('#status').textContent.includes('连接成功'));
  assert.equal(received.at(-1).body.api_key, 'instance-only-key');
  await optionsPage.locator('#save').click();
  await optionsPage.waitForFunction(() => document.querySelector('#status').textContent.includes('已保存'));
  await page.getByRole('button', { name: '翻译当前网页', exact: true }).waitFor();
  assert.equal(await page.locator('[data-it-translation]').count(), 0);
  await optionsPage.locator('#clearLibre').click();
  await optionsPage.waitForFunction(() => document.querySelector('#status').textContent.includes('已清除'));
  await optionsPage.reload();
  assert.equal(await optionsPage.locator('#libreApiKey').inputValue(), '');
  assert.equal(await optionsPage.locator('#libreEndpoint').inputValue(), `${instance}/translate`);
  await optionsPage.locator('#provider').selectOption('ai');
  assert.equal(await optionsPage.locator('#apiKey').inputValue(), 'do-not-leak-ai-key');
  assert.ok(received.every(item => !item.headers.authorization && !item.headers.cookie));
  assert.doesNotMatch(JSON.stringify(received.map(item => item.body)), /do-not-leak-ai-key|PRIVATE_INPUT/);
  assert.equal(await page.locator('#note').inputValue(), 'PRIVATE_INPUT');
  await optionsPage.locator('#provider').selectOption('libretranslate');
  await mkdir(path.join(root, 'tests/artifacts'), { recursive: true });
  await optionsPage.screenshot({ path: path.join(root, 'tests/artifacts/libre-options.png'), fullPage: true });
});
