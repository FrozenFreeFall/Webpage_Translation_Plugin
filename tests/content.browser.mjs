import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createPage, root } from './browser-helpers.mjs';

async function fixture(t, html, options = {}) {
  const { browser, page } = await createPage();
  t.after(() => browser.close());
  await page.route('http://fixture.test/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
  await page.addInitScript(({ delay, partial, configured, configDelay }) => {
    window.calls = []; window.listeners = []; window.active = 0; window.maxActive = 0;
    window.config = { targetLanguage: 'zh-CN', configured, revision: 1 };
    window.chrome = { runtime: {
      onMessage: { addListener(fn) { window.listeners.push(fn); } },
      async sendMessage(message) {
        window.calls.push(message);
        if (message.type === 'IT_START_SESSION' || message.type === 'IT_GET_PUBLIC_CONFIG') { await new Promise(resolve => setTimeout(resolve, configDelay)); return { ok: true, config: window.config }; }
        if (message.type !== 'IT_TRANSLATE') return { ok: true };
        window.active++; window.maxActive = Math.max(window.maxActive, window.active);
        await new Promise(resolve => setTimeout(resolve, delay)); window.active--;
        const failed = partial && !window.retried ? message.segments.slice(-1) : [];
        window.retried = true;
        return { ok: true, translations: message.segments.filter(s => !failed.includes(s)).map(s => ({ id: s.id, text: '译文 <img src=x onerror=alert(1)> ' + s.text })), failures: failed.map(s => ({ id: s.id, error: { message: '服务暂时不可用', fatal: false } })) };
      }
    } };
  }, { delay: options.delay || 0, partial: !!options.partial, configured: options.configured !== false, configDelay: options.configDelay || 0 });
  await page.goto('http://fixture.test/article');
  await page.addScriptTag({ path: path.join(root, 'src/content.js') });
  await page.waitForSelector('#it-translation-root', { timeout: 2000 });
  return page;
}
const ball = page => page.getByRole('button', { name: /翻译当前网页|显示原文|翻译中，点击取消并还原|重新尝试翻译/ });

test('LibreTranslate without an instance address explains setup and never sends page text', async t => {
  const page = await fixture(t, '<p>Current webpage paragraph</p>', { configured: false });
  await page.evaluate(() => { window.config.provider = 'libretranslate'; });
  await ball(page).click();
  await page.waitForFunction(() => globalThis.__IT_CONTENT__.state === 'error');
  assert.match(await page.locator('#it-translation-root .message').innerText(), /LibreTranslate.*地址/);
  assert.equal(await page.evaluate(() => calls.some(call => call.type === 'IT_TRANSLATE')), false);
});


test('snapshot preserves mixed blocks, lists, tables and source events; excludes private/hidden text; restore reuses cache', async t => {
  const page = await fixture(t, `<main><h1>Article heading</h1><div>Loose introduction <a href='#go'>linked words</a><p>A paragraph with <em>emphasis</em> and <code>SECRET_CODE</code> here.</p>Trailing prose.</div><ul><li>Parent list<ul><li>Nested list</li></ul></li></ul><table><tr><td>Table cell</td></tr></table><p hidden>HIDDEN</p><div style='display:none'>INVISIBLE</div><p contenteditable='true'>PRIVATE_EDITOR</p><input value='SECRET_INPUT'><pre>PRE_CODE</pre><nav>NAV_TEXT</nav><header>HEADER_TEXT</header><footer>FOOTER_TEXT</footer><p>这是一个中文段落无需翻译。</p></main>`);
  await page.evaluate(() => document.querySelector('a').addEventListener('click', event => { event.preventDefault(); window.linkClicked = true; }));
  await ball(page).click(); await page.waitForFunction(() => globalThis.__IT_CONTENT__.state === 'translated');
  const texts = await page.evaluate(() => window.calls.filter(c => c.type === 'IT_TRANSLATE').flatMap(c => c.segments.map(s => s.text)));
  assert.equal(texts.filter(s => s.includes('Nested list')).length, 1);
  assert.equal(texts.filter(s => s.includes('A paragraph')).length, 1);
  assert(texts.some(s => s.includes('Loose introduction')) && texts.some(s => s.includes('Trailing prose.')) && texts.includes('Table cell'));
  assert(!texts.join(' ').match(/SECRET|PRIVATE|HIDDEN|INVISIBLE|PRE_CODE|NAV_TEXT|HEADER_TEXT|FOOTER_TEXT|这是/));
  assert.equal(await page.locator('[data-it-translation] img').count(), 0);
  await page.locator('a').click(); assert.equal(await page.evaluate(() => window.linkClicked), true);
  await ball(page).click(); assert.equal(await page.locator('[data-it-translation]').count(), 0);
  const count = await page.evaluate(() => window.calls.filter(c => c.type === 'IT_TRANSLATE').length);
  await ball(page).click(); await page.waitForFunction(() => globalThis.__IT_CONTENT__.state === 'translated');
  assert.equal(await page.evaluate(() => window.calls.filter(c => c.type === 'IT_TRANSLATE').length), count);
});

test('cancel and route changes reject delayed responses', async t => {
  const page = await fixture(t, '<main><p>Delayed article paragraph</p></main>', { delay: 200 });
  await ball(page).click(); await page.waitForFunction(() => window.calls.some(c => c.type === 'IT_TRANSLATE'));
  await ball(page).click(); await page.waitForTimeout(300);
  assert.equal(await page.locator('[data-it-translation]').count(), 0);
  assert.equal(await page.evaluate(() => globalThis.__IT_CONTENT__.state), 'original');
  await ball(page).click(); await page.waitForFunction(() => globalThis.__IT_CONTENT__.state === 'loading');
  await page.evaluate(() => history.pushState({}, '', '/next'));
  await page.waitForTimeout(700);
  assert.equal(await page.locator('[data-it-translation]').count(), 0);
  assert.equal(await page.evaluate(() => globalThis.__IT_CONTENT__.state), 'original');
});

test('changes invalidate recorded blocks while new content stays unsent and old responses cannot reappear', async t => {
  const page = await fixture(t, '<main><p id="first">First article paragraph</p><p id="second">Second article paragraph</p></main>', { delay: 120 });
  await ball(page).click(); await page.waitForFunction(() => window.calls.some(c => c.type === 'IT_TRANSLATE'));
  await page.evaluate(() => { document.querySelector('#first').textContent = 'Changed first paragraph'; document.querySelector('main').insertAdjacentHTML('beforeend', '<p>Newly loaded paragraph</p>'); });
  await page.waitForFunction(() => globalThis.__IT_CONTENT__.state === 'translated');
  assert.equal(await page.locator('[data-it-translation]').count(), 1);
  await page.evaluate(() => document.querySelector('#second').remove()); await page.waitForTimeout(30);
  assert.equal(await page.locator('[data-it-translation]').count(), 0);
  assert.equal(await page.evaluate(() => window.calls.filter(c => c.type === 'IT_TRANSLATE').length), 1);
});

test('partial failure retries only failures; configuration broadcast restores and discards cache', async t => {
  const page = await fixture(t, '<p>First article paragraph</p><p>Second article paragraph</p>', { partial: true });
  await ball(page).click(); await page.waitForFunction(() => globalThis.__IT_CONTENT__.state === 'partial');
  await page.getByRole('button', { name: '重试失败内容' }).click();
  await page.waitForFunction(() => globalThis.__IT_CONTENT__.state === 'translated');
  assert.equal(await page.locator('[data-it-translation]').count(), 2);
  assert.equal(await page.evaluate(() => window.calls.filter(c => c.type === 'IT_TRANSLATE')[1].segments.length), 1);
  await page.evaluate(() => { window.config.revision++; window.listeners.forEach(fn => fn({ type: 'IT_CONFIG_CHANGED' }, {}, () => {})); });
  assert.equal(await page.locator('[data-it-translation]').count(), 0);
  await ball(page).click(); await page.waitForFunction(() => globalThis.__IT_CONTENT__.state === 'translated');
  assert.equal(await page.evaluate(() => window.calls.filter(c => c.type === 'IT_TRANSLATE').length), 3);
});

test('long text uses bounded batches and at most two concurrent requests', async t => {
  const page = await fixture(t, '<main>' + Array.from({ length: 22 }, (_, i) => `<p>${i} ${'English prose '.repeat(300)}</p>`).join('') + '</main>', { delay: 30 });
  await ball(page).click(); await page.waitForFunction(() => globalThis.__IT_CONTENT__.state === 'translated');
  const info = await page.evaluate(() => ({ calls: window.calls.filter(c => c.type === 'IT_TRANSLATE'), max: window.maxActive }));
  assert.equal(info.max, 2);
  for (const call of info.calls) { assert(call.segments.length <= 8); assert(call.segments.every(s => s.text.length <= 3000)); assert(call.segments.reduce((n, s) => n + s.text.length, 0) <= 6000); }
});

test('missing configuration has actionable settings and sends no text', async t => {
  const page = await fixture(t, '<p>Article paragraph</p>', { configured: false });
  await ball(page).click(); await page.waitForFunction(() => globalThis.__IT_CONTENT__.state === 'error');
  assert.equal(await page.evaluate(() => window.calls.filter(c => c.type === 'IT_TRANSLATE').length), 0);
  await page.getByRole('button', { name: '设置' }).click();
  assert(await page.evaluate(() => window.calls.some(c => c.type === 'IT_OPEN_OPTIONS')));
});


test('language filtering does not mistake Japanese or unmarked French for the target language', async t => {
  const page = await fixture(t, '<p>日本語の文章です漢字も読みます。</p><p>Bonjour tout le monde</p>');
  await page.evaluate(() => { window.config.targetLanguage = 'en'; });
  await ball(page).click(); await page.waitForFunction(() => globalThis.__IT_CONTENT__.state === 'translated');
  assert.equal(await page.evaluate(() => window.calls.filter(c => c.type === 'IT_TRANSLATE').flatMap(c => c.segments).length), 2);
  await ball(page).click();
  await page.evaluate(() => { window.config.targetLanguage = 'zh-CN'; window.config.revision++; });
  await ball(page).click(); await page.waitForFunction(() => globalThis.__IT_CONTENT__.state === 'translated');
  assert(await page.evaluate(() => window.calls.filter(c => c.type === 'IT_TRANSLATE').at(-1).segments.some(s => s.text.includes('日本語'))));
});

test('hidden ancestors and an immediate SPA route change invalidate delayed source results', async t => {
  const page = await fixture(t, '<main><p>Article paragraph for visibility</p></main>', { delay: 150 });
  await ball(page).click(); await page.waitForFunction(() => window.calls.some(c => c.type === 'IT_TRANSLATE'));
  await page.evaluate(() => document.querySelector('main').hidden = true);
  await page.waitForTimeout(250);
  assert.equal(await page.locator('[data-it-translation]').count(), 0);
  await ball(page).click();
  await page.evaluate(() => { document.querySelector('main').hidden = false; });
  await ball(page).click(); await page.waitForFunction(() => globalThis.__IT_CONTENT__.state === 'loading');
  await page.evaluate(() => history.pushState({}, '', '/immediate-next'));
  await page.waitForTimeout(250);
  assert.equal(await page.locator('[data-it-translation]').count(), 0);
});

test('restoring from BFCache resumes route detection', async t => {
  const page = await fixture(t, '<p>Article paragraph</p>');
  await page.evaluate(() => { dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })); dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); });
  await ball(page).click(); await page.waitForFunction(() => globalThis.__IT_CONTENT__.state === 'translated');
  await page.evaluate(() => history.pushState({}, '', '/cached-route'));
  await page.waitForTimeout(650);
  assert.equal(await page.evaluate(() => globalThis.__IT_CONTENT__.state), 'original');
  assert.equal(await page.locator('[data-it-translation]').count(), 0);
});

test('page-script synthetic clicks cannot start paid translation or open settings', async t => {
  const page = await fixture(t, '<p>Article paragraph</p>');
  await page.evaluate(() => { document.querySelector('#it-translation-root').shadowRoot.querySelectorAll('button').forEach(button => button.click()); });
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => window.calls.length), 0);
  assert.equal(await page.evaluate(() => globalThis.__IT_CONTENT__.state), 'original');
});


test('snapshot is taken at the user click before asynchronous configuration lookup', async t => {
  const page = await fixture(t, '<main><p>Initial article paragraph</p></main>', { configDelay: 150 });
  await ball(page).click(); await page.waitForFunction(() => window.calls.some(c => c.type === 'IT_START_SESSION'));
  await page.evaluate(() => document.querySelector('main').insertAdjacentHTML('beforeend', '<p>New paragraph after click</p>'));
  await page.waitForFunction(() => globalThis.__IT_CONTENT__.state === 'translated');
  const texts = await page.evaluate(() => window.calls.filter(c => c.type === 'IT_TRANSLATE').flatMap(c => c.segments.map(s => s.text)));
  assert.deepEqual(texts, ['Initial article paragraph']);
});


test('line breaks preserve word boundaries and closed details expose only their visible summary', async t => {
  const page = await fixture(t, '<main><p>First line<br>Second line</p><details><summary>Visible summary</summary><p>HIDDEN_CLOSED</p>HIDDEN_LOOSE</details><details open><summary>Open summary</summary><p>Open details body</p></details></main>');
  await ball(page).click(); await page.waitForFunction(() => globalThis.__IT_CONTENT__.state === 'translated');
  const texts = await page.evaluate(() => window.calls.filter(c => c.type === 'IT_TRANSLATE').flatMap(c => c.segments.map(s => s.text)));
  assert(texts.includes('First line Second line'));
  assert(texts.some(text => text.includes('Visible summary')));
  assert(texts.some(text => text.includes('Open details body')));
  assert(!texts.join(' ').includes('HIDDEN_'));
});
