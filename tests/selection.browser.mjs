import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { createPage, root } from './browser-helpers.mjs';

const source = path.join(root, 'src/selection.js');
const ui = page => page.locator('#it-selection-root');
const trigger = page => ui(page).getByRole('button', { name: '翻译所选文字', exact: true });
const card = page => ui(page).getByRole('dialog');
const markup = `<!doctype html><meta charset="utf-8"><title>Reading notes</title><style>
body{margin:0;background:#f6f7fc;color:#20213a;font:18px/1.8 system-ui}main{max-width:920px;padding:84px 40px;margin:auto;background:white;min-height:1400px}h1{font-size:36px;line-height:1.3}p{margin:24px 0}.below{margin-top:30px}input{display:block}
</style><main><small>READING NOTES</small><h1>Better images, clearer details</h1><p id="word">The new renderer reproduces images with higher fidelity.</p><p id="sentence">Keep the original text visible while you read the translation.</p><p class="below">A calm reading experience helps you focus on the important details.</p><p id="mixed">Readable text <span contenteditable="true">private editable words</span> ending.</p><input id="private" value="private input words"><p data-it-translation id="existing">Existing injected translation.</p><div id="movie_player"><p id="playerText">Player interface words.</p></div></main>`;

async function fixture(t, { hold = false, fail = false, configured = true, enabled = true, noAudio = false, unsafeText = false, multiAudio = false, holdAudio = false, manySources = false } = {}) {
  const { browser, page } = await createPage();
  t.after(() => browser.close());
  page.setDefaultTimeout(5000);
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.route('https://article.test/**', route => route.request().url().endsWith('.png')
    ? route.fulfill({ contentType: 'image/png', body: readFileSync(path.join(root, 'assets/icons/icon-32.png')) })
    : route.fulfill({ contentType: 'text/html; charset=utf-8', body: markup }));
  await page.addInitScript(({ hold, fail, configured, enabled, noAudio, unsafeText, multiAudio, holdAudio, manySources }) => {
    window.calls = []; window.pending = []; window.audioPending = []; window.listeners = []; window.copies = []; window.plays = 0; window.pauses = 0;
    window.config = { configured, provider: 'microsoft', targetLanguage: 'zh-CN', revision: 'r1', selectionEnabled: enabled };
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => window.copies.push(text) } });
    window.Audio = class {
      constructor(src) { this.src = src; }
      async play() { window.plays++; }
      pause() { window.pauses++; }
      removeAttribute() {}
      load() {}
    };
    window.spoken = []; window.speechCancelled = 0;
    Object.defineProperty(window, 'speechSynthesis', { value: {
      getVoices: () => [{ name: 'Online voice', lang: 'en-US', localService: false }, { name: 'Local English', lang: 'en-US', localService: true }],
      speak: utterance => window.spoken.push({ text: utterance.text, voice: utterance.voice.name }),
      cancel: () => { window.speechCancelled++; },
      addEventListener() {}, removeEventListener() {},
    } });
    window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
    window.chrome = { runtime: {
      getURL: file => 'https://article.test/' + file,
      onMessage: { addListener: fn => window.listeners.push(fn) },
      async sendMessage(message) {
        window.calls.push(message);
        if (message.type === 'IT_GET_PUBLIC_CONFIG') return { ok: true, config: window.config };
        if (message.type === 'IT_SELECTION_AUDIO') { if (holdAudio) await new Promise(resolve => window.audioPending.push(resolve)); return { ok: true, dataUrl: 'data:audio/mpeg;base64,AA==' }; }
        if (message.type !== 'IT_SELECTION_TRANSLATE') return { ok: true };
        if (hold) await new Promise(resolve => window.pending.push(resolve));
        if (fail) return { ok: false, error: { code: 'NETWORK', message: '服务暂时不可用，请重试。' } };
        if (message.mode === 'dictionary') return { ok: true, config: window.config, dictionary: {
          word: message.text.toLowerCase(), phonetics: noAudio ? [] : [{ text: '/fɪˈdel.ə.ti/', audio: 'https://api.dictionaryapi.dev/media/pronunciations/en/fidelity-uk.mp3', region: 'UK' }, ...(multiAudio ? [{ text: '/fɪˈdel.ə.ti/', audio: 'https://api.dictionaryapi.dev/media/pronunciations/en/fidelity-us.mp3', region: 'US' }] : [])],
          meanings: [{ partOfSpeech: 'noun', definitions: [
            { text: '忠实；忠诚', original: 'Faithfulness to a person or cause.' },
            { text: '保真度；还原程度', original: 'Accuracy of a reproduced image or sound.' },
            { text: '对承诺的忠实履行', original: 'Observance of a promise.' },
            { text: '细节的一致程度', original: 'Exact correspondence of details.' },
          ] }],
          sources: [{ name: 'Free Dictionary API', url: 'https://dictionaryapi.dev/' }, { name: 'Wiktionary', url: 'https://en.wiktionary.org/wiki/fidelity' }, ...(manySources ? Array.from({ length: 7 }, (_, i) => ({ name: 'Audio attribution ' + i, url: 'https://commons.wikimedia.org/wiki/File:Example' + i })) : [])],
          licenses: [{ name: 'CC BY-SA 4.0', url: 'https://creativecommons.org/licenses/by-sa/4.0/' }],
          translationNotice: '释义由微软翻译；英文原释义可展开。',
        } };
        return { ok: true, config: window.config, translations: [{ id: 'selection', text: unsafeText ? '<img src=x onerror="window.injection=true">' : '阅读译文时，保持原文可见。' }] };
      },
    } };
  }, { hold, fail, configured, enabled, noAudio, unsafeText, multiAudio, holdAudio, manySources });
  await page.goto('https://article.test/notes');
  if (existsSync(source)) await page.addScriptTag({ path: source });
  return page;
}

async function select(page, selector, text) {
  await page.evaluate(({ selector, text }) => {
    const element = document.querySelector(selector);
    const range = document.createRange();
    if (text === undefined) range.selectNodeContents(element);
    else {
      const node = element.firstChild;
      const start = node.textContent.indexOf(text);
      if (start < 0) throw new Error('Missing fixture text');
      range.setStart(node, start); range.setEnd(node, start + text.length);
    }
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  }, { selector, text });
}

async function requests(page, type = 'IT_SELECTION_TRANSLATE') {
  return page.evaluate(type => window.calls.filter(call => call.type === type), type);
}

test('selected sentence shows only a small trigger until click then opens the bilingual floating card', async t => {
  const page = await fixture(t);
  await select(page, '#sentence');
  await trigger(page).waitFor({ state: 'visible', timeout: 2000 });
  assert.equal((await requests(page)).length, 0);
  await trigger(page).click();
  await card(page).getByText('阅读译文时，保持原文可见。', { exact: true }).waitFor();
  assert.equal((await requests(page))[0].text, 'Keep the original text visible while you read the translation.');
  assert.equal((await requests(page))[0].mode, 'translate');
  assert.match(await card(page).innerText(), /Keep the original text/);
  await card(page).getByRole('button', { name: '复制译文', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.copies), ['阅读译文时，保持原文可见。']);
  await card(page).getByRole('button', { name: '关闭', exact: true }).click();
  assert.equal(await card(page).isVisible(), false);
});

test('word dictionary card stays close beneath the selected word and pronunciation is explicit and stopped on close', async t => {
  const page = await fixture(t);
  await select(page, '#word', 'fidelity');
  const anchor = await page.evaluate(() => { const box = getSelection().getRangeAt(0).getBoundingClientRect(); return { x: box.x, bottom: box.bottom }; });
  await trigger(page).click();
  await card(page).getByText('忠实；忠诚', { exact: true }).waitFor();
  const box = await card(page).boundingBox();
  assert.ok(Math.abs(box.y - anchor.bottom - 8) <= 2, 'word card should start immediately beneath the word');
  assert.ok(Math.abs(box.x - anchor.x) <= 2, 'word card should align with the word when there is room');
  assert.match(await card(page).innerText(), /fɪˈdel.ə.ti/);
  assert.match(await card(page).innerText(), /n\. 名词/);
  assert.match(await card(page).innerText(), /保真度；还原程度/);
  assert.equal((await requests(page, 'IT_SELECTION_AUDIO')).length, 0);
  assert.equal(await page.evaluate(() => window.plays), 0);
  await card(page).getByRole('button', { name: /发音/ }).click();
  await page.waitForFunction(() => window.plays === 1);
  assert.equal((await requests(page, 'IT_SELECTION_AUDIO')).length, 1);
  await card(page).getByRole('button', { name: '更多释义', exact: true }).click();
  await card(page).getByText('细节的一致程度', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(root, 'tests/artifacts/selection-word-card.png') });
  await page.keyboard.press('Escape');
  assert.equal(await card(page).isVisible(), false);
  assert.ok(await page.evaluate(() => window.pauses) > 0);
});

test('forbidden, editable, injected and player selections never produce a trigger or send text', async t => {
  const page = await fixture(t);
  for (const selector of ['[contenteditable]', '#mixed', '#existing', '#playerText']) {
    await select(page, selector);
    await page.waitForTimeout(120);
    assert.equal(await trigger(page).isVisible(), false, selector);
  }
  await page.locator('#private').selectText();
  await page.waitForTimeout(100);
  assert.equal(await trigger(page).isVisible(), false);
  assert.equal((await requests(page)).length, 0);
});

test('new selection cancels only the old selection and late responses cannot replace the new card', async t => {
  const page = await fixture(t, { hold: true });
  await select(page, '#sentence'); await trigger(page).click();
  await page.waitForFunction(() => window.pending.length === 1);
  const first = (await requests(page))[0].requestId;
  await select(page, '#word', 'fidelity');
  await trigger(page).waitFor({ state: 'visible' });
  assert.equal(await card(page).isVisible(), false);
  await trigger(page).click();
  await page.waitForFunction(() => window.pending.length === 2);
  await page.evaluate(() => window.pending.shift()());
  await page.waitForTimeout(100);
  assert.doesNotMatch(await card(page).innerText(), /阅读译文时/);
  await page.evaluate(() => window.pending.shift()());
  await card(page).getByText('保真度；还原程度', { exact: true }).waitFor();
  assert.ok((await requests(page, 'IT_CANCEL_SELECTION')).some(call => call.requestId === first));
  assert.equal((await requests(page, 'IT_CANCEL_SESSION')).length, 0);
});

test('card controls and selecting card text do not recurse while outside clicks and scrolling close it', async t => {
  const page = await fixture(t);
  await select(page, '#word', 'fidelity'); await trigger(page).click();
  await card(page).getByText('忠实；忠诚', { exact: true }).waitFor();
  await card(page).getByText('fidelity', { exact: true }).selectText();
  await page.waitForTimeout(120);
  assert.equal((await requests(page)).length, 1);
  assert.equal(await trigger(page).isVisible(), false);
  assert.equal(await card(page).isVisible(), true);
  await page.mouse.click(24, 24);
  assert.equal(await card(page).isVisible(), false);
  await select(page, '#sentence'); await trigger(page).click();
  await card(page).waitFor();
  await page.mouse.wheel(0, 400);
  await card(page).waitFor({ state: 'hidden' });
});

test('bottom and narrow viewport cards stay visible, preserve nearby anchoring and allow keyboard activation', async t => {
  const page = await fixture(t);
  await page.evaluate(() => { window.pageKeys = []; for (const type of ['keydown', 'keyup']) document.addEventListener(type, event => window.pageKeys.push(event.key)); });
  await page.setViewportSize({ width: 390, height: 620 });
  await page.locator('#word').evaluate(element => { element.style.marginTop = '220px'; });
  await select(page, '#word', 'fidelity');
  await trigger(page).focus(); await page.keyboard.press('Enter');
  await card(page).getByText('忠实；忠诚', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.pageKeys), [], 'owned keyboard controls must not trigger website shortcuts');
  const box = await card(page).boundingBox();
  assert.ok(box.x >= 7 && box.y >= 7 && box.x + box.width <= 383 && box.y + box.height <= 613);
  await page.screenshot({ path: path.join(root, 'tests/artifacts/selection-word-narrow.png') });
});

test('errors are recoverable, source is preserved, and disabled selection config hides the UI without starting sessions', async t => {
  const page = await fixture(t, { fail: true });
  await select(page, '#sentence'); await trigger(page).click();
  await card(page).getByText('服务暂时不可用，请重试。', { exact: true }).waitFor();
  assert.match(await card(page).innerText(), /Keep the original/);
  await card(page).getByRole('button', { name: '重试', exact: true }).click();
  await page.waitForFunction(() => window.calls.filter(call => call.type === 'IT_SELECTION_TRANSLATE').length === 2);
  await page.evaluate(() => { window.config.selectionEnabled = false; window.listeners.forEach(fn => fn({ type: 'IT_SELECTION_CONFIG_CHANGED' })); });
  await card(page).waitFor({ state: 'hidden' });
  await select(page, '#word', 'fidelity');
  await page.waitForTimeout(160);
  assert.equal(await trigger(page).isVisible(), false);
  assert.equal((await requests(page)).length, 2);
  assert.equal((await requests(page, 'IT_START_SESSION')).length, 0);
});

test('ordinary paragraph card is a light compact layout and uses literal translation text', async t => {
  const page = await fixture(t);
  await select(page, '#sentence'); await trigger(page).click();
  await card(page).getByText('阅读译文时，保持原文可见。', { exact: true }).waitFor();
  const styles = await card(page).evaluate(element => ({ width: element.getBoundingClientRect().width, color: getComputedStyle(element).backgroundColor, radius: parseFloat(getComputedStyle(element).borderRadius) }));
  assert.ok(styles.width >= 340 && styles.width <= 380);
  assert.equal(styles.color, 'rgb(255, 255, 255)');
  assert.ok(styles.radius >= 10);
  await page.screenshot({ path: path.join(root, 'tests/artifacts/selection-sentence-card.png') });
});

test('missing dictionary audio offers explicit local speech, uses only a local English voice and stops on close', async t => {
  const page = await fixture(t, { noAudio: true });
  await select(page, '#word', 'fidelity'); await trigger(page).click();
  await card(page).getByText('忠实；忠诚', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.spoken.length), 0);
  await card(page).getByRole('button', { name: '本机朗读', exact: true }).click();
  await page.waitForFunction(() => window.spoken.length === 1);
  assert.deepEqual(await page.evaluate(() => window.spoken[0]), { text: 'fidelity', voice: 'Local English' });
  assert.equal((await requests(page, 'IT_SELECTION_AUDIO')).length, 0);
  await card(page).getByRole('button', { name: '关闭', exact: true }).click();
  assert.ok(await page.evaluate(() => window.speechCancelled) > 0);
});

test('oversized selections never leave the page and provider markup remains literal', async t => {
  const page = await fixture(t, { unsafeText: true });
  await page.locator('#sentence').evaluate(element => { element.textContent = 'long '.repeat(650); });
  await select(page, '#sentence'); await trigger(page).click();
  await card(page).getByText(/3000/).waitFor();
  assert.equal((await requests(page)).length, 0);
  await page.mouse.click(24, 24);
  await page.locator('#sentence').evaluate(element => { element.textContent = 'A safe short sentence.'; });
  await select(page, '#sentence'); await trigger(page).click();
  await card(page).getByText('<img src=x onerror="window.injection=true">', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.injection), undefined);
  assert.equal(await card(page).locator('.translated img').count(), 0);
});

test('webpage synthetic clicks cannot request pronunciation, retry translation, copy or open extension settings', async t => {
  const page = await fixture(t);
  await select(page, '#word', 'fidelity'); await trigger(page).click();
  await card(page).getByText('忠实；忠诚', { exact: true }).waitFor();
  await page.evaluate(() => {
    const shadow = document.querySelector('#it-selection-root').shadowRoot;
    for (const selector of ['.pronounce', '.settings', '.copy']) shadow.querySelector(selector).click();
  });
  await page.waitForTimeout(100);
  assert.equal((await requests(page, 'IT_SELECTION_AUDIO')).length, 0);
  assert.equal((await requests(page, 'IT_OPEN_OPTIONS')).length, 0);
  assert.equal(await page.evaluate(() => window.copies.length), 0);
});

test('switching between pending pronunciations restores the previous button and only plays the latest response', async t => {
  const page = await fixture(t, { multiAudio: true, holdAudio: true });
  await select(page, '#word', 'fidelity'); await trigger(page).click();
  const first = card(page).getByRole('button', { name: '英音 · 发音', exact: true });
  const second = card(page).getByRole('button', { name: '美音 · 发音', exact: true });
  await first.click();
  await page.waitForFunction(() => window.audioPending.length === 1);
  await second.click();
  await page.waitForFunction(() => window.audioPending.length === 2);
  await page.evaluate(() => window.audioPending.splice(0).forEach(resolve => resolve()));
  await page.waitForFunction(() => window.plays === 1);
  assert.equal(await first.isEnabled(), true, 'switching audio must not leave the old button stuck');
});

test('license attribution remains available when a word has many dictionary and audio source links', async t => {
  const page = await fixture(t, { manySources: true });
  await select(page, '#word', 'fidelity'); await trigger(page).click();
  await card(page).getByText('忠实；忠诚', { exact: true }).waitFor();
  assert.equal(await card(page).getByRole('link', { name: 'CC BY-SA 4.0', exact: true }).count(), 1);
});
