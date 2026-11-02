import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createPage, root } from './browser-helpers.mjs';

async function fixture(t, file = 'options.html', settings = null, pageStatus = null) {
  const { browser, page } = await createPage();
  t.after(() => browser.close());
  await page.route('http://fixture.test/**', async route => {
    const name = new URL(route.request().url()).pathname.slice(1);
    try { await route.fulfill({ body: await readFile(path.join(root, name)), contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html' }); }
    catch { await route.fulfill({ status: 404, body: 'missing' }); }
  });
  await page.addInitScript(({ settings, pageStatus }) => {
    window.calls = [];
    window.saved = settings || JSON.parse(localStorage.getItem('settings') || 'null') || { provider: 'ai', endpoint: 'https://api.deepseek.com/chat/completions', model: 'deepseek-flash', apiKey: '', targetLanguage: 'zh-CN' };
    window.chrome = { runtime: { sendMessage: async message => {
      window.calls.push(message);
      if (message.type === 'IT_GET_SETTINGS') return { ok: true, settings: window.saved };
      if (window.fail) return { ok: false, error: { message: '连接失败，请检查配置' } };
      if (message.type === 'IT_SAVE_SETTINGS') { localStorage.setItem('settings', JSON.stringify(message.settings)); return { ok: true, config: {} }; }
      if (message.type === 'IT_TEST_CONNECTION') return { ok: true, text: '你好' };
      return { ok: true };
    } }, tabs: { query: async () => [{ id: 4 }], sendMessage: async (_tabId, message) => {
      if (!pageStatus) throw new Error('no receiver');
      window.calls.push(message);
      if (message.type === 'IT_TOGGLE_YOUTUBE_SUBTITLES') pageStatus = { ...pageStatus, captionActive: !pageStatus.captionActive, state: pageStatus.captionActive ? 'original' : 'waiting', message: '' };
      return { ok: true, supported: true, ...pageStatus };
    } } };
  }, { settings, pageStatus });
  await page.goto(`http://fixture.test/${file}`);
  return page;
}

test('first configuration requires consent; save survives reload and clear persists empty key', async t => {
  const page = await fixture(t);
  await page.locator('#apiKey').fill('test-secret');
  assert.equal(await page.locator('#apiKey').getAttribute('type'), 'password');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  assert.match(await page.locator('#status').innerText(), /确认/);
  assert.equal(await page.evaluate(() => calls.some(c => c.type === 'IT_SAVE_SETTINGS')), false);
  await page.getByRole('button', { name: '测试连接', exact: true }).click();
  assert.equal(await page.evaluate(() => calls.some(c => c.type === 'IT_TEST_CONNECTION')), false);
  await page.locator('#consent').check();
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('已保存'));
  await page.reload();
  assert.equal(await page.locator('#apiKey').inputValue(), 'test-secret');
  await page.getByRole('button', { name: '清除 AI 密钥', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('已清除'));
  await page.reload();
  assert.equal(await page.locator('#apiKey').inputValue(), '');
});

test('connection test sends draft without page text or saving and recovers after errors', async t => {
  const page = await fixture(t);
  await page.locator('#apiKey').fill('draft-secret');
  await page.locator('#consent').check();
  await page.locator('#model').fill('draft-model');
  await page.getByRole('button', { name: '测试连接', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('连接成功'));
  const calls = await page.evaluate(() => calls);
  assert.equal(calls.some(c => c.type === 'IT_SAVE_SETTINGS'), false);
  assert.deepEqual(calls.at(-1), { type: 'IT_TEST_CONNECTION', settings: { provider: 'ai', endpoint: 'https://api.deepseek.com/chat/completions', model: 'draft-model', apiKey: 'draft-secret', targetLanguage: 'zh-CN', libreEndpoint: '', libreApiKey: '' } });
  await page.evaluate(() => { window.fail = true; });
  await page.getByRole('button', { name: '测试连接', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('连接失败'));
  assert.equal(await page.getByRole('button', { name: '测试连接', exact: true }).isEnabled(), true);
});

test('popup explains missing content script and provides options', async t => {
  const page = await fixture(t, 'popup.html');
  await page.waitForFunction(() => document.querySelector('#pageStatus')?.textContent.includes('刷新'));
  assert.match(await page.locator('#pageStatus').innerText(), /受限|授权/);
  await page.getByRole('button', { name: '打开设置', exact: true }).click();
  assert.equal(await page.evaluate(() => calls.some(c => c.type === 'IT_OPEN_OPTIONS')), true);
});

test('popup uses YouTube caption status and controls the existing tab without sending text', async t => {
  const page = await fixture(t, 'popup.html', null, { isYouTube: true, captionActive: false, state: 'error', message: '此视频暂无可用字幕。' });
  const toggle = page.getByRole('button', { name: '开启字幕翻译', exact: true });
  await toggle.waitFor();
  assert.match(await page.locator('#pageStatus').innerText(), /暂无可用字幕/);
  await toggle.click();
  await page.getByRole('button', { name: '关闭字幕翻译', exact: true }).waitFor();
  assert.match(await page.locator('#pageStatus').innerText(), /等待 YouTube 字幕/);
  await page.getByRole('button', { name: '关闭字幕翻译', exact: true }).click();
  await toggle.waitFor();
  assert.equal(await page.evaluate(() => calls.filter(call => call.type === 'IT_TOGGLE_YOUTUBE_SUBTITLES').length), 2);
  assert.equal(await page.evaluate(() => calls.some(call => ['IT_START_SESSION', 'IT_TRANSLATE'].includes(call.type))), false);
});

test('pending connection locks controls then unlocks them on rejection', async t => {
  const page = await fixture(t);
  await page.locator('#apiKey').fill('secret');
  await page.locator('#consent').check();
  await page.evaluate(() => { chrome.runtime.sendMessage = () => new Promise((resolve, reject) => { window.rejectPending = reject; }); });
  await page.getByRole('button', { name: '测试连接', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '保存设置', exact: true }).isDisabled(), true);
  assert.equal(await page.locator('#apiKey').isDisabled(), true);
  await page.evaluate(() => rejectPending(new Error('offline')));
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('连接失败'));
  assert.equal(await page.getByRole('button', { name: '保存设置', exact: true }).isEnabled(), true);
});

test('controlled backend authentication errors remain actionable', async t => {
  const page = await fixture(t);
  await page.locator('#apiKey').fill('secret');
  await page.locator('#consent').check();
  await page.evaluate(() => { chrome.runtime.sendMessage = async () => ({ ok: false, error: { code: 'AUTH', message: '鉴权失败，请检查 API Key。' } }); });
  await page.getByRole('button', { name: '测试连接', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#test').disabled);
  assert.match(await page.locator('#status').innerText(), /鉴权失败，请检查 API Key/);
});

test('free engines save and test without AI required fields and retain draft', async t => {
  const page = await fixture(t, 'options.html', { provider: 'microsoft', endpoint: '', model: '', apiKey: '', targetLanguage: 'zh-CN' });
  assert.equal(await page.locator('#provider').inputValue(), 'microsoft');
  assert.equal(await page.locator('#aiSettings').isVisible(), false);
  await page.locator('#save').click();
  assert.equal(await page.evaluate(() => calls.some(c => c.type === 'IT_SAVE_SETTINGS')), false);
  await page.locator('#consent').check();
  await page.locator('#save').click();
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('已保存'));
  await page.locator('#test').click();
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('连接成功'));
  assert.equal(await page.locator('#endpoint').isDisabled(), true);
  await page.locator('#provider').selectOption('ai');
  await page.locator('#endpoint').fill('https://example.com/chat/completions');
  await page.locator('#model').fill('draft-model');
  await page.locator('#apiKey').fill('draft-key');
  const before = await page.evaluate(() => calls.length);
  await page.locator('#provider').selectOption('google');
  assert.equal(await page.evaluate(() => calls.length), before);
  assert.match(await page.locator('#dataNotice').innerText(), /谷歌/);
  await page.locator('#test').click();
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('连接成功'));
  assert.equal(await page.evaluate(() => calls.at(-1).settings.provider), 'google');
  assert.equal(await page.evaluate(() => calls.at(-1).settings.apiKey), 'draft-key');
  await page.locator('#provider').selectOption('ai');
  assert.equal(await page.locator('#model').inputValue(), 'draft-model');
  assert.equal(await page.locator('#apiKey').inputValue(), 'draft-key');
  assert.equal(await page.locator('#endpoint').isEnabled(), true);
});


test('clearing AI key retains saved free provider and ignores other draft changes', async t => {
  const page = await fixture(t, 'options.html', { provider: 'microsoft', endpoint: 'https://saved.example/chat/completions', model: 'saved-model', apiKey: 'saved-key', targetLanguage: 'zh-CN', libreEndpoint: 'https://saved-libre.example/translate', libreApiKey: 'saved-libre-key' });
  await page.locator('#provider').selectOption('ai');
  await page.locator('#model').fill('draft-model');
  await page.locator('#clear').click();
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('已清除'));
  const sent = await page.evaluate(() => calls.at(-1));
  assert.equal(sent.settings.provider, 'microsoft');
  assert.equal(sent.settings.model, 'saved-model');
  assert.equal(sent.settings.apiKey, '');
  assert.equal(sent.settings.libreEndpoint, 'https://saved-libre.example/translate');
  assert.equal(sent.settings.libreApiKey, 'saved-libre-key');
  assert.match(await page.locator('#status').innerText(), /免费引擎仍可用/);
});

test('legacy settings without provider reopen as AI', async t => {
  const page = await fixture(t, 'options.html', { endpoint: 'https://old.example/chat/completions', model: 'old-model', apiKey: 'old-key', targetLanguage: 'zh-CN' });
  assert.equal(await page.locator('#provider').inputValue(), 'ai');
  assert.equal(await page.locator('#apiKey').inputValue(), 'old-key');
  assert.equal(await page.locator('#aiSettings').isVisible(), true);
});

test('LibreTranslate saves and tests without a key, retains AI drafts, and survives reload', async t => {
  const page = await fixture(t);
  assert.equal(await page.locator('#provider option[value="libretranslate"]').count(), 1);
  await page.locator('#apiKey').fill('ai-draft-key');
  await page.locator('#model').fill('ai-draft-model');
  const before = await page.evaluate(() => calls.length);
  await page.locator('#provider').selectOption('libretranslate');
  assert.equal(await page.evaluate(() => calls.length), before);
  assert.equal(await page.locator('#libreSettings').isVisible(), true);
  assert.equal(await page.locator('#aiSettings').isVisible(), false);
  assert.equal(await page.locator('#endpoint').isDisabled(), true);
  assert.equal(await page.locator('#libreApiKey').getAttribute('type'), 'password');
  assert.equal(await page.locator('#libreEndpoint').inputValue(), '');
  assert.equal(await page.locator('#libreApiKey').inputValue(), '');
  await page.locator('#libreEndpoint').fill('http://localhost:5000');
  await page.locator('#consent').check();
  await page.locator('#test').click();
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('连接成功'));
  assert.equal(await page.evaluate(() => calls.some(c => c.type === 'IT_SAVE_SETTINGS')), false);
  assert.deepEqual(await page.evaluate(() => calls.at(-1)), {
    type: 'IT_TEST_CONNECTION',
    settings: { provider: 'libretranslate', endpoint: 'https://api.deepseek.com/chat/completions', model: 'ai-draft-model', apiKey: 'ai-draft-key', targetLanguage: 'zh-CN', libreEndpoint: 'http://localhost:5000', libreApiKey: '' }
  });
  assert.equal(await page.locator('#libreEndpoint').isEnabled(), true);
  assert.equal(await page.locator('#endpoint').isDisabled(), true);
  await page.locator('#save').click();
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('已保存'));
  await page.reload();
  assert.equal(await page.locator('#provider').inputValue(), 'libretranslate');
  assert.equal(await page.locator('#libreEndpoint').inputValue(), 'http://localhost:5000');
  assert.equal(await page.locator('#libreApiKey').inputValue(), '');
  await page.locator('#provider').selectOption('ai');
  assert.equal(await page.locator('#model').inputValue(), 'ai-draft-model');
  assert.equal(await page.locator('#apiKey').inputValue(), 'ai-draft-key');
  assert.equal(await page.locator('#libreSettings').isVisible(), false);
  assert.equal(await page.locator('#libreEndpoint').isDisabled(), true);
  await page.locator('#provider').selectOption('google');
  assert.equal(await page.locator('#aiSettings').isVisible(), false);
  assert.equal(await page.locator('#libreSettings').isVisible(), false);
});

test('each clear-key action retains the saved provider and ignores all unrelated drafts', async t => {
  const page = await fixture(t, 'options.html', { provider: 'microsoft', endpoint: 'https://saved.example/chat/completions', model: 'saved-model', apiKey: 'saved-ai-key', targetLanguage: 'zh-CN', libreEndpoint: 'https://saved-libre.example/translate', libreApiKey: 'saved-libre-key' });
  assert.equal(await page.locator('#provider option[value="libretranslate"]').count(), 1);
  await page.locator('#provider').selectOption('ai');
  await page.locator('#endpoint').fill('https://draft-ai.example/chat/completions');
  await page.locator('#model').fill('draft-model');
  await page.locator('#apiKey').fill('draft-ai-key');
  await page.locator('#provider').selectOption('libretranslate');
  await page.locator('#libreEndpoint').fill('http://localhost:5001');
  await page.locator('#libreApiKey').fill('draft-libre-key');
  await page.locator('#targetLanguage').selectOption('en');
  await page.locator('#clearLibre').click();
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('已清除'));
  assert.deepEqual(await page.evaluate(() => calls.at(-1).settings), { provider: 'microsoft', endpoint: 'https://saved.example/chat/completions', model: 'saved-model', apiKey: 'saved-ai-key', targetLanguage: 'zh-CN', libreEndpoint: 'https://saved-libre.example/translate', libreApiKey: '' });
  assert.equal(await page.locator('#provider').inputValue(), 'libretranslate');
  assert.equal(await page.locator('#libreEndpoint').inputValue(), 'http://localhost:5001');
  assert.equal(await page.locator('#libreApiKey').inputValue(), '');
  assert.equal(await page.locator('#targetLanguage').inputValue(), 'en');
  await page.locator('#provider').selectOption('ai');
  assert.equal(await page.locator('#apiKey').inputValue(), 'draft-ai-key');
  assert.equal(await page.locator('#model').inputValue(), 'draft-model');
  await page.locator('#clear').click();
  await page.waitForFunction(() => document.querySelector('#apiKey').value === '' && !document.querySelector('#clear').disabled);
  assert.deepEqual(await page.evaluate(() => calls.at(-1).settings), { provider: 'microsoft', endpoint: 'https://saved.example/chat/completions', model: 'saved-model', apiKey: '', targetLanguage: 'zh-CN', libreEndpoint: 'https://saved-libre.example/translate', libreApiKey: '' });
  assert.equal(await page.locator('#endpoint').inputValue(), 'https://draft-ai.example/chat/completions');
});

test('clearing a saved LibreTranslate key retains its address and supports unauthenticated instances', async t => {
  const page = await fixture(t, 'options.html', { provider: 'libretranslate', endpoint: '', model: '', apiKey: 'saved-ai-key', targetLanguage: 'zh-CN', libreEndpoint: 'https://instance.example/translate', libreApiKey: 'saved-libre-key' });
  assert.equal(await page.locator('#provider option[value="libretranslate"]').count(), 1);
  await page.locator('#clearLibre').click();
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('已清除'));
  assert.equal(await page.locator('#libreEndpoint').inputValue(), 'https://instance.example/translate');
  assert.equal(await page.locator('#libreApiKey').inputValue(), '');
  assert.equal(await page.evaluate(() => calls.at(-1).settings.apiKey), 'saved-ai-key');
  assert.match(await page.locator('#status').innerText(), /是否.*密钥|鉴权|无需.*密钥/);
  await page.locator('#consent').check();
  await page.locator('#test').click();
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('连接成功'));
  assert.equal(await page.evaluate(() => calls.at(-1).settings.libreApiKey), '');
  assert.equal(await page.locator('#libreEndpoint').isEnabled(), true);
  assert.equal(await page.locator('#apiKey').isDisabled(), true);
});

test('an empty LibreTranslate address can be saved as a draft and testing shows the backend configuration error', async t => {
  const page = await fixture(t, 'options.html', { provider: 'microsoft', endpoint: '', model: '', apiKey: '', targetLanguage: 'zh-CN' });
  assert.equal(await page.locator('#provider option[value="libretranslate"]').count(), 1);
  await page.locator('#provider').selectOption('libretranslate');
  await page.locator('#consent').check();
  await page.locator('#save').click();
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('已保存'));
  assert.equal(await page.evaluate(() => calls.at(-1).settings.libreEndpoint), '');
  await page.evaluate(() => { chrome.runtime.sendMessage = async () => ({ ok: false, error: { code: 'CONFIG', message: '请先填写 LibreTranslate 实例地址。' } }); });
  await page.locator('#test').click();
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('实例地址'));
  assert.equal(await page.locator('#test').isEnabled(), true);
  assert.equal(await page.locator('#libreEndpoint').isEnabled(), true);
  assert.equal(await page.locator('#endpoint').isDisabled(), true);
});

test('LibreTranslate pending transport failures restore only the selected engine fields', async t => {
  const page = await fixture(t);
  assert.equal(await page.locator('#provider option[value="libretranslate"]').count(), 1);
  await page.locator('#provider').selectOption('libretranslate');
  await page.locator('#libreEndpoint').fill('https://instance.example/translate');
  await page.locator('#consent').check();
  await page.evaluate(() => { chrome.runtime.sendMessage = () => new Promise((resolve, reject) => { window.rejectPending = reject; }); });
  await page.locator('#test').click();
  assert.equal(await page.locator('#libreEndpoint').isDisabled(), true);
  assert.equal(await page.locator('#libreApiKey').isDisabled(), true);
  assert.equal(await page.locator('#provider').isDisabled(), true);
  await page.evaluate(() => rejectPending(new Error('offline')));
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('连接失败'));
  assert.match(await page.locator('#status').innerText(), /LibreTranslate.*地址.*权限/);
  assert.equal(await page.locator('#libreEndpoint').isEnabled(), true);
  assert.equal(await page.locator('#libreApiKey').isEnabled(), true);
  assert.equal(await page.locator('#endpoint').isDisabled(), true);
  assert.equal(await page.locator('#save').isEnabled(), true);
  assert.equal(await page.locator('#clearLibre').isEnabled(), true);
});
