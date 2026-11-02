import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createPage, root } from './browser-helpers.mjs';

async function fixture(t, file = 'options.html', initial = {}) {
  const { browser, page } = await createPage();
  t.after(() => browser.close());
  await page.route('http://fixture.test/**', async route => {
    const name = new URL(route.request().url()).pathname.slice(1);
    try {
      await route.fulfill({ body: await readFile(path.join(root, name)), contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.png') ? 'image/png' : 'text/html; charset=utf-8' });
    } catch { await route.fulfill({ status: 404, body: 'missing' }); }
  });
  await page.addInitScript(initial => {
    window.calls = [];
    window.saved = JSON.parse(localStorage.getItem('settings') || 'null') || { provider: 'microsoft', endpoint: '', model: '', apiKey: '', targetLanguage: 'zh-CN', ...initial };
    window.chrome = {
      runtime: { sendMessage: async message => {
        window.calls.push(message);
        if (message.type === 'IT_GET_SETTINGS') return { ok: true, settings: window.saved };
        if (message.type === 'IT_GET_PUBLIC_CONFIG') return { ok: true, config: { selectionEnabled: window.saved.selectionEnabled !== false } };
        if (message.type === 'IT_SAVE_SETTINGS') {
          window.saved = { ...message.settings };
          localStorage.setItem('settings', JSON.stringify(window.saved));
          return { ok: true, config: { selectionEnabled: window.saved.selectionEnabled } };
        }
        if (message.type === 'IT_SET_SELECTION_ENABLED') {
          if (window.holdSet) await new Promise(resolve => { window.finishSet = resolve; });
          if (window.failSet) return { ok: false, error: { message: '暂时无法保存' } };
          window.saved.selectionEnabled = message.enabled;
          localStorage.setItem('settings', JSON.stringify(window.saved));
          return { ok: true, config: { selectionEnabled: message.enabled } };
        }
        return { ok: true };
      } },
      tabs: {
        query: async () => [{ id: 4, url: 'https://www.youtube.com/watch?v=fixture' }],
        sendMessage: async (_tabId, message) => {
          window.calls.push(message);
          return { ok: true, supported: true, isYouTube: true, captionActive: true, state: 'translated' };
        },
      },
    };
  }, initial);
  await page.goto(`http://fixture.test/${file}`);
  return page;
}

test('options default selection on, save a boolean only after consent, and keep it after reload', async t => {
  const page = await fixture(t);
  assert.equal(await page.locator('#selectionEnabled').count(), 1, 'the enabled preference must be a real checkbox');
  await page.waitForFunction(() => !document.querySelector('#selectionEnabled').disabled);
  assert.equal(await page.locator('#selectionEnabled').isChecked(), true);
  await page.locator('#selectionEnabled').uncheck();
  assert.deepEqual(await page.evaluate(() => calls.map(call => call.type)), ['IT_GET_SETTINGS']);
  await page.locator('#save').click();
  assert.equal(await page.evaluate(() => calls.some(call => call.type === 'IT_SAVE_SETTINGS')), false);
  await page.locator('#consent').check();
  await page.locator('#save').click();
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('已保存'));
  const sent = await page.evaluate(() => calls.find(call => call.type === 'IT_SAVE_SETTINGS'));
  assert.equal(sent.settings.selectionEnabled, false);
  assert.equal(typeof sent.settings.selectionEnabled, 'boolean');
  await page.reload();
  await page.waitForFunction(() => !document.querySelector('#selectionEnabled').disabled);
  assert.equal(await page.locator('#selectionEnabled').isChecked(), false);
  await page.locator('#selectionEnabled').check();
  await page.locator('#consent').check();
  await page.locator('#save').click();
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('已保存'));
  assert.equal(await page.evaluate(() => calls.at(-1).settings.selectionEnabled), true);
});

test('options disclose dictionary, chosen definition engine, and manual pronunciation without lookup', async t => {
  const page = await fixture(t, 'options.html', { selectionEnabled: false });
  assert.equal(await page.locator('#selectionEnabled').count(), 1, 'settings must expose the selection preference');
  await page.waitForFunction(() => !document.querySelector('#selectionEnabled').disabled);
  assert.equal(await page.locator('#selectionEnabled').isChecked(), false);
  const notice = await page.locator('#dataNotice').innerText();
  assert.match(notice, /Free Dictionary API/);
  assert.match(notice, /音标.*词性.*英文释义/);
  assert.match(notice, /发音.*点击|点击.*发音/);
  assert.match(notice, /Cookie/);
  assert.match(notice, /页面地址/);
  await page.locator('#provider').selectOption('ai');
  assert.match(await page.locator('#dataNotice').innerText(), /中文.*释义.*AI.*费用/s);
  await page.locator('#provider').selectOption('google');
  assert.match(await page.locator('#dataNotice').innerText(), /中文.*释义.*谷歌/s);
  assert.deepEqual(await page.evaluate(() => calls.map(call => call.type)), ['IT_GET_SETTINGS']);
});

test('popup selection switch persists immediately without touching active YouTube translation', async t => {
  const page = await fixture(t, 'popup.html');
  assert.equal(await page.locator('#selectionEnabled').count(), 1, 'popup must have the selection switch');
  await page.waitForFunction(() => !document.querySelector('#selectionEnabled').disabled);
  assert.equal(await page.locator('#selectionEnabled').isChecked(), true);
  await page.locator('#selectionEnabled').uncheck();
  await page.waitForFunction(() => !document.querySelector('#selectionEnabled').disabled);
  assert.deepEqual(await page.evaluate(() => calls.filter(call => call.type === 'IT_SET_SELECTION_ENABLED')), [{ type: 'IT_SET_SELECTION_ENABLED', enabled: false }]);
  assert.match(await page.locator('#pageStatus').innerText(), /双语字幕/);
  assert.equal(await page.evaluate(() => calls.some(call => /START_SESSION|CANCEL_SESSION|TRANSLATE|TOGGLE_YOUTUBE/.test(call.type))), false);
  await page.reload();
  await page.waitForFunction(() => !document.querySelector('#selectionEnabled').disabled);
  assert.equal(await page.locator('#selectionEnabled').isChecked(), false);
});

test('popup locks a pending change and restores the prior switch value if saving fails', async t => {
  const page = await fixture(t, 'popup.html', { selectionEnabled: false });
  assert.equal(await page.locator('#selectionEnabled').count(), 1, 'popup must have the selection switch');
  await page.waitForFunction(() => !document.querySelector('#selectionEnabled').disabled);
  await page.evaluate(() => { window.holdSet = true; window.failSet = true; });
  await page.locator('#selectionEnabled').check();
  assert.equal(await page.locator('#selectionEnabled').isDisabled(), true);
  await page.evaluate(() => window.finishSet());
  await page.waitForFunction(() => !document.querySelector('#selectionEnabled').disabled);
  assert.equal(await page.locator('#selectionEnabled').isChecked(), false);
  assert.match(await page.locator('#status').innerText(), /失败|未保存|重试/);
  assert.equal(await page.evaluate(() => calls.filter(call => call.type === 'IT_SET_SELECTION_ENABLED').length), 1);
});
