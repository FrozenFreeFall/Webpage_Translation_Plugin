import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { createPage, root, chromium, browserOptions } from './browser-helpers.mjs';

const source = path.join(root, 'src/youtube.js');
const markup = readFileSync(new URL('./fixtures/youtube.html', import.meta.url), 'utf8');
const toggle = page => page.locator('.it-youtube-host .toggle');
const translated = page => page.locator('.it-youtube-host .translation');
const bilingual = page => page.locator('.it-youtube-host .bilingual');
const captionSource = page => page.locator('.it-youtube-host .source');

async function fixture(t, options = {}) {
  const { browser, page } = await createPage();
  t.after(() => browser.close());
  await page.setViewportSize({ width: 1280, height: 900 });
  if (options.clock) {
    const now = new Date('2026-01-01T00:00:00Z');
    await page.clock.install({ time: now });
    await page.clock.pauseAt(new Date(now.getTime() + 60_000));
  }
  await page.route('https://www.youtube.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: markup }));
  await page.addInitScript(({ configured, holdTranslation, holdConfig, failFirst }) => {
    window.calls = []; window.listeners = []; window.pending = [];
    window.config = { targetLanguage: 'zh-CN', configured, revision: 1 }; window.failNext = failFirst;
    window.chrome = { runtime: {
      onMessage: { addListener(fn) { window.listeners.push(fn); } },
      async sendMessage(message) {
        window.calls.push(message);
        if (message.type === 'IT_GET_PUBLIC_CONFIG' && holdConfig) await new Promise(resolve => { window.completeConfig = resolve; });
        if (message.type === 'IT_START_SESSION' || message.type === 'IT_GET_PUBLIC_CONFIG') return { ok: true, config: window.config };
        if (message.type !== 'IT_TRANSLATE') return { ok: true };
        if (holdTranslation) await new Promise(resolve => window.pending.push(resolve));
        if (window.failNext) { window.failNext = false; return { ok: false, error: { code: 'AUTH', message: '模型鉴权失败，请检查 API Key。', fatal: true } }; }
        return { ok: true, translations: message.segments.map(({ id, text }) => ({ id, text: text === 'Learning a language opens new doors.' ? '学习一门语言会打开新的大门。' : '译文：' + text })), failures: [] };
      },
    } };
  }, { configured: options.configured !== false, holdTranslation: !!options.holdTranslation, holdConfig: !!options.holdConfig, failFirst: !!options.failFirst });
  await page.goto(options.url || 'https://www.youtube.com/watch?v=fixture-one');
  if (options.beforeScript) await options.beforeScript(page);
  // A missing module is a failed feature assertion in the initial red run.
  if (existsSync(source)) await page.addScriptTag({ path: source });
  return page;
}

async function setCue(page, text) {
  await page.evaluate(text => {
    document.querySelector('.ytp-caption-window-container').innerHTML = text ? '<div class="caption-window"><span class="ytp-caption-segment"></span></div>' : '';
    const segment = document.querySelector('.ytp-caption-segment');
    if (segment) segment.textContent = text;
  }, text);
}

async function waitForTranslation(page, text) {
  await page.waitForFunction(text => {
    const node = document.querySelector('.it-youtube-host')?.shadowRoot?.querySelector('.translation');
    return node && !node.hidden && node.textContent === text;
  }, text, { timeout: 5000 });
}

async function sends(page) {
  return page.evaluate(() => window.calls.filter(call => call.type === 'IT_TRANSLATE'));
}

async function releaseNext(page) {
  await page.evaluate(() => window.pending.shift()?.());
}

async function nativeAppearance(page, playerId = 'movie_player') {
  return page.evaluate(playerId => {
    const player = document.getElementById(playerId);
    const properties = ['color', 'backgroundColor', 'textShadow', 'opacity', 'visibility', 'display'];
    return ['.ytp-caption-window-container', '.caption-window', '.ytp-caption-segment'].map(selector => {
      const element = player.querySelector(selector);
      if (!element) return null;
      const style = getComputedStyle(element);
      return Object.fromEntries(properties.map(property => [property, style[property]]));
    });
  }, playerId);
}

async function assertUnifiedCard(page) {
  assert.equal(await bilingual(page).count(), 1, 'one card must own both the original cue and its translation');
  const layout = await bilingual(page).evaluate(card => {
    const source = card.querySelector('.source');
    const translation = card.querySelector('.translation');
    const rect = element => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    };
    const style = element => {
      const computed = getComputedStyle(element);
      return { fontSize: computed.fontSize, textAlign: computed.textAlign, background: computed.backgroundColor };
    };
    const computed = getComputedStyle(card);
    return {
      card: rect(card), source: rect(source), translation: rect(translation),
      sourceStyle: style(source), translationStyle: style(translation),
      background: computed.backgroundColor, radius: parseFloat(computed.borderRadius),
      padding: [computed.paddingTop, computed.paddingRight, computed.paddingBottom, computed.paddingLeft].map(parseFloat),
    };
  });
  const { card, source, translation, sourceStyle, translationStyle } = layout;
  assert.ok(source.height > 0 && translation.height > 0, 'both languages must render in the shared card');
  assert.ok(source.y + source.height <= translation.y + 1, 'original cue must appear above its translation');
  for (const line of [source, translation]) {
    assert.ok(line.x >= card.x && line.y >= card.y && line.x + line.width <= card.x + card.width + 1 && line.y + line.height <= card.y + card.height + 1, 'the rounded card must enclose each language');
    assert.ok(Math.abs(line.x + line.width / 2 - card.x - card.width / 2) <= 1, 'both languages must share the card center');
  }
  assert.equal(sourceStyle.fontSize, translationStyle.fontSize, 'both languages use the same font size');
  assert.equal(sourceStyle.textAlign, 'center');
  assert.equal(translationStyle.textAlign, 'center');
  assert.ok(translation.y - source.y - source.height <= parseFloat(sourceStyle.fontSize) / 2, 'the two languages have a compact vertical gap');
  assert.ok(layout.radius >= 6 && layout.padding.every(value => value > 0), 'one rounded, padded card surrounds the pair');
  const color = layout.background.match(/[\d.]+/g)?.map(Number) || [];
  assert.ok(color.length >= 3 && color.slice(0, 3).every(value => value < 70) && (color[3] ?? 1) > 0, 'the shared card supplies a dark background');
  assert.ok([sourceStyle.background, translationStyle.background].every(color => color === 'rgba(0, 0, 0, 0)' || color === 'transparent'), 'the languages must not form two independently painted boxes');
  const nativePaintHidden = await page.locator('.ytp-caption-segment').evaluate(segment => {
    let opacity = 1;
    for (let element = segment; element; element = element.parentElement) {
      const style = getComputedStyle(element);
      opacity *= Number(style.opacity);
      if (style.visibility === 'hidden' || style.display === 'none') return true;
    }
    const style = getComputedStyle(segment);
    const windowStyle = getComputedStyle(segment.closest('.caption-window'));
    return opacity === 0 || (style.color === 'rgba(0, 0, 0, 0)' && style.textShadow === 'none' && windowStyle.backgroundColor === 'rgba(0, 0, 0, 0)');
  });
  assert.equal(nativePaintHidden, true, 'the active card must not leave a duplicate native English cue visible');
  const playerBox = await page.locator('#movie_player').boundingBox();
  assert.ok(card.x >= playerBox.x && card.y >= playerBox.y && card.x + card.width <= playerBox.x + playerBox.width + 1 && card.y + card.height <= playerBox.y + playerBox.height + 1, 'the paired card stays inside the player');
}

test('one bilingual card centers both languages together in ordinary and fullscreen playback with wrapped cues', async t => {
  const page = await fixture(t);
  await toggle(page).click();
  await waitForTranslation(page, '学习一门语言会打开新的大门。');
  await assertUnifiedCard(page);
  assert.equal(await captionSource(page).innerText(), 'Learning a language opens new doors.');
  assert.equal(await translated(page).textContent(), '学习一门语言会打开新的大门。');
  await page.screenshot({ path: path.join(root, 'tests/artifacts/youtube-unified-card.png') });
  await bilingual(page).screenshot({ path: path.join(root, 'tests/artifacts/youtube-unified-card-crop.png') });
  const longCue = 'Every new language brings another way to understand the world, connect with our neighbors, and share the stories that matter to us.';
  await setCue(page, longCue);
  await waitForTranslation(page, '译文：' + longCue);
  await assertUnifiedCard(page);
  assert.ok(await captionSource(page).evaluate(node => {
    const range = document.createRange();
    range.selectNodeContents(node);
    return new Set([...range.getClientRects()].map(rect => Math.round(rect.y))).size > 1;
  }), 'a long original cue wraps within the card rather than overflowing it');
  await page.locator('.ytp-fullscreen-button').click();
  await page.waitForFunction(() => document.fullscreenElement?.id === 'movie_player');
  await assertUnifiedCard(page);
  assert.equal(await bilingual(page).evaluate(card => document.fullscreenElement.contains(card.getRootNode().host)), true);
});

test('the bilingual card sits slightly lower while clearing usable controls in ordinary and fullscreen playback', async t => {
  const page = await fixture(t);
  await toggle(page).click();
  await waitForTranslation(page, '学习一门语言会打开新的大门。');
  const layouts = [];
  for (const mode of ['ordinary', 'fullscreen']) {
    if (mode === 'fullscreen') {
      await page.locator('.ytp-fullscreen-button').click();
      await page.waitForFunction(() => document.fullscreenElement?.id === 'movie_player');
    }
    for (const anchor of ['near-controls', 'raised-native-cue']) {
      await page.locator('.ytp-caption-window-container').evaluate((node, bottom) => { node.style.bottom = bottom; }, anchor === 'near-controls' ? '104px' : '240px');
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      layouts.push(await bilingual(page).evaluate((card, context) => {
        const player = document.querySelector('#movie_player').getBoundingClientRect();
        const controls = document.querySelector('.ytp-chrome-bottom').getBoundingClientRect();
        const nativeTop = document.querySelector('.ytp-caption-segment').getBoundingClientRect().top - player.top;
        const box = card.getBoundingClientRect();
        // Compare to the previous top anchor and 12px control clearance using
        // the rendered card height, so text/font metrics cannot fake the move.
        const previousTop = Math.max(8, Math.min(nativeTop, Math.min(player.height - 12, controls.top - player.top - 12) - box.height));
        const controlsUsable = ['.ytp-subtitles-button', '.ytp-fullscreen-button'].every(selector => {
          const button = document.querySelector(selector);
          const rect = button.getBoundingClientRect();
          return button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
        });
        return { ...context, top: box.top - player.top, previousTop, shift: box.top - player.top - previousTop, controlGap: controls.top - box.bottom, bottomGap: player.bottom - box.bottom, controlsUsable };
      }, { mode, anchor }));
    }
  }
  for (const layout of layouts) {
    t.diagnostic(JSON.stringify(layout));
    const expectedShift = layout.anchor === 'near-controls' ? 8 : 14;
    assert.ok(Math.abs(layout.shift - expectedShift) <= 1, `${layout.mode} ${layout.anchor}: the card should move down ${expectedShift}px from its previous position (actual ${layout.shift}px)`);
    assert.ok(layout.controlGap >= 4 && layout.bottomGap >= 4, 'the lower card must leave safe space above the controls and player edge');
    assert.equal(layout.controlsUsable, true, 'native CC and fullscreen controls must remain clickable');
  }
  await page.evaluate(() => document.exitFullscreen());
  await page.locator('.ytp-caption-window-container').evaluate(node => { node.style.bottom = '104px'; });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({ path: path.join(root, 'tests/artifacts/youtube-subtitle-lowered.png') });
});

test('the unified card keeps the current growing source as literal text and sends no cloned or unrelated content', async t => {
  const page = await fixture(t, { clock: true, holdTranslation: true });
  const prefix = 'A clear beginning';
  await setCue(page, prefix);
  await toggle(page).click();
  await page.clock.fastForward(600);
  assert.equal((await sends(page)).length, 1);
  await releaseNext(page);
  await page.clock.fastForward(50);
  assert.equal(await bilingual(page).count(), 1, 'the paired card is required before a rolling cue can update its source');
  const growing = prefix + ' opens another door';
  await setCue(page, growing);
  await page.clock.fastForward(100);
  assert.equal(await captionSource(page).textContent(), growing, 'retaining a useful prefix translation must still show the latest visible original cue');
  assert.equal(await translated(page).textContent(), '译文：A clear beginning');
  assert.equal(await page.locator('.ytp-caption-segment').textContent(), growing);
  const unsafe = '<img src=x onerror=window.captionScriptExecuted=true>';
  await setCue(page, unsafe);
  const unsafeLanguage = 'en"><img src=x onerror=window.captionScriptExecuted=true>';
  await page.locator('.caption-window').evaluate((node, language) => node.setAttribute('lang', language), unsafeLanguage);
  await page.clock.fastForward(600);
  await page.evaluate(() => window.pending.splice(0).forEach(resolve => resolve()));
  await page.clock.fastForward(100);
  await waitForTranslation(page, '译文：' + unsafe);
  assert.equal(await captionSource(page).textContent(), unsafe);
  assert.equal(await captionSource(page).getAttribute('lang'), unsafeLanguage);
  assert.equal(await page.locator('.it-youtube-host img').count(), 0);
  assert.equal(await page.evaluate(() => !!window.captionScriptExecuted), false);
  assert.deepEqual((await sends(page)).flatMap(call => call.segments.map(segment => segment.text)), [prefix, unsafe], 'the card source clone and unrelated title/comment text must never become additional translation input');
});

test('native cue appearance returns when a unified card stops, clears, seeks, changes configuration, or loses its player', async t => {
  for (const action of ['stop', 'clear', 'seek', 'configuration', 'replacement']) {
    const page = await fixture(t, { holdTranslation: true, beforeScript: async page => {
      await page.evaluate(() => {
        document.querySelector('.caption-window').style.cssText = 'color: rgb(243, 233, 223); background: rgba(8, 9, 10, .78); text-shadow: 1px 1px 2px rgb(3, 4, 5);';
        window.originalPlayer = document.querySelector('#movie_player').outerHTML;
        window.originalSegment = document.querySelector('.ytp-caption-segment');
      });
    } });
    const original = await nativeAppearance(page);
    const nativeMarkup = await page.locator('.ytp-caption-window-container').innerHTML();
    await toggle(page).click();
    await page.waitForFunction(() => window.pending.length === 1);
    assert.deepEqual(await nativeAppearance(page), original, `${action}: native captions stay visible until a translated pair is ready`);
    await releaseNext(page);
    await waitForTranslation(page, '学习一门语言会打开新的大门。');
    assert.equal(await bilingual(page).count(), 1, `${action}: the card must own the pair while active`);
    assert.equal(await page.locator('.ytp-caption-window-container').innerHTML(), nativeMarkup, `${action}: enabling must preserve native cue markup`);
    if (action === 'stop') await toggle(page).click();
    if (action === 'clear') await setCue(page, '');
    if (action === 'seek') await page.evaluate(() => document.querySelector('video').dispatchEvent(new Event('seeking')));
    if (action === 'configuration') await page.evaluate(() => {
      window.config.revision++;
      window.listeners.forEach(listener => listener({ type: 'IT_CONFIG_CHANGED' }, {}, () => {}));
    });
    if (action === 'replacement') await page.evaluate(() => {
      const retired = document.querySelector('#movie_player');
      retired.insertAdjacentHTML('beforebegin', window.originalPlayer);
      retired.id = 'retired_player';
      document.body.append(retired);
    });
    await page.waitForFunction(() => [...document.querySelectorAll('.it-youtube-host')].every(host => !host.shadowRoot.querySelector('.translation') || host.shadowRoot.querySelector('.translation').hidden));
    assert.equal(await bilingual(page).isVisible(), false, `${action}: neither language may remain in a stale card`);
    assert.equal(await page.evaluate(() => window.originalSegment.textContent), 'Learning a language opens new doors.', `${action}: the native source text remains intact`);
    if (action === 'clear') assert.deepEqual((await nativeAppearance(page))[0], original[0], 'clearing removes the native-container visual override');
    else {
      assert.deepEqual(await nativeAppearance(page, action === 'replacement' ? 'retired_player' : 'movie_player'), original, `${action}: the original native caption styling is restored exactly`);
    }
  }
});

test('YouTube caption toggle is player-local and sends no source text before a trusted click', async t => {
  const page = await fixture(t);
  assert.equal(await toggle(page).count(), 1, 'YouTube player must contain a subtitle translation toggle');
  assert.equal(await page.evaluate(() => window.calls.some(call => ['IT_START_SESSION', 'IT_TRANSLATE'].includes(call.type))), false);
  await page.evaluate(() => document.querySelector('.it-youtube-host').shadowRoot.querySelector('.toggle').click());
  await page.waitForTimeout(120);
  assert.equal(await page.evaluate(() => window.calls.some(call => ['IT_START_SESSION', 'IT_TRANSLATE'].includes(call.type))), false, 'synthetic clicks must not send caption text');
  await toggle(page).click();
  await page.waitForFunction(() => globalThis.__IT_YOUTUBE__?.getStatus().state === 'translated');
  assert.equal(await translated(page).innerText(), '学习一门语言会打开新的大门。');
  assert.equal(await page.locator('.ytp-caption-segment').innerText(), 'Learning a language opens new doors.');
  assert.deepEqual(await page.evaluate(() => window.calls.filter(call => call.type === 'IT_TRANSLATE').flatMap(call => call.segments.map(segment => segment.text))), ['Learning a language opens new doors.']);
  assert.equal(await page.locator('.it-youtube-host').evaluate(host => !!host.closest('#movie_player')), true);
  await page.screenshot({ path: path.join(root, 'tests/artifacts/youtube-dual-captions.png') });
});

test('changing live captions sends only the latest stable cue and never displays a stale response', async t => {
  const page = await fixture(t, { holdTranslation: true });
  await toggle(page).click();
  await page.waitForFunction(() => window.pending.length === 1);
  await page.evaluate(() => {
    window.renderedTranslations = [];
    const node = document.querySelector('.it-youtube-host').shadowRoot.querySelector('.translation');
    new MutationObserver(() => { if (!node.hidden && node.textContent) window.renderedTranslations.push(node.textContent); }).observe(node, { subtree: true, childList: true, characterData: true, attributes: true });
  });
  await setCue(page, 'An interim live caption.');
  await setCue(page, 'Only the final stable caption.');
  await page.waitForTimeout(250);
  assert.equal((await sends(page)).length, 1, 'the previous in-flight request must not produce parallel requests');
  await releaseNext(page);
  await page.waitForFunction(() => window.pending.length === 1);
  await releaseNext(page);
  await waitForTranslation(page, '译文：Only the final stable caption.');
  assert.deepEqual((await sends(page)).flatMap(call => call.segments.map(segment => segment.text)), ['Learning a language opens new doors.', 'Only the final stable caption.']);
  assert.equal(await page.evaluate(() => window.renderedTranslations.some(text => text.includes('学习一门') || text.includes('interim'))), false);
});

test('repeated cues use cache; stopping clears the overlay and ends the session', async t => {
  const page = await fixture(t);
  await toggle(page).click();
  await waitForTranslation(page, '学习一门语言会打开新的大门。');
  await setCue(page, 'The next sentence arrives.');
  await waitForTranslation(page, '译文：The next sentence arrives.');
  const count = (await sends(page)).length;
  await setCue(page, 'Learning a language opens new doors.');
  await waitForTranslation(page, '学习一门语言会打开新的大门。');
  assert.equal((await sends(page)).length, count);
  await toggle(page).click();
  assert.equal(await translated(page).isVisible(), false);
  assert.equal(await page.evaluate(() => globalThis.__IT_YOUTUBE__.getStatus().active), false);
  assert.ok(await page.evaluate(() => window.calls.some(call => call.type === 'IT_CANCEL_SESSION')));
  await setCue(page, 'This cue appears after the user stopped.');
  await page.waitForTimeout(250);
  assert.equal((await sends(page)).length, count);
});

test('seeking and clearing a cue immediately hide translations and reject pending stale output', async t => {
  const page = await fixture(t, { holdTranslation: true });
  await toggle(page).click();
  await page.waitForFunction(() => window.pending.length === 1);
  await page.evaluate(() => document.querySelector('video').dispatchEvent(new Event('seeking')));
  await setCue(page, 'A sentence after seeking.');
  await releaseNext(page);
  await page.waitForTimeout(250);
  assert.equal(await translated(page).isVisible(), false, 'seeking must not leave the preceding caption translation visible');
  await page.evaluate(() => document.querySelector('video').dispatchEvent(new Event('seeked')));
  await page.waitForFunction(() => window.pending.length === 1);
  await releaseNext(page);
  await waitForTranslation(page, '译文：A sentence after seeking.');
  await setCue(page, '');
  await page.waitForFunction(() => !document.querySelector('.it-youtube-host').shadowRoot.querySelector('.translation').textContent || document.querySelector('.it-youtube-host').shadowRoot.querySelector('.translation').hidden);
  assert.equal(await translated(page).isVisible(), false);
});

test('pause preserves a matching translated cue without resending caption text', async t => {
  const page = await fixture(t);
  await toggle(page).click();
  await waitForTranslation(page, '学习一门语言会打开新的大门。');
  const count = (await sends(page)).length;
  await page.evaluate(() => document.querySelector('video').dispatchEvent(new Event('pause')));
  await page.waitForTimeout(200);
  assert.equal(await translated(page).innerText(), '学习一门语言会打开新的大门。');
  await page.evaluate(() => document.querySelector('video').dispatchEvent(new Event('play')));
  await page.waitForTimeout(200);
  assert.equal((await sends(page)).length, count);
});

test('trusted enable attempts CC once; missing cues explain availability and later manual CC off stays off', async t => {
  const page = await fixture(t, { beforeScript: async page => {
    await page.locator('.ytp-subtitles-button').click();
    await setCue(page, '');
  } });
  await toggle(page).click();
  await page.waitForFunction(() => globalThis.__IT_YOUTUBE__.getStatus().state === 'error');
  assert.match(await page.locator('.it-youtube-host .message').innerText(), /字幕|CC/);
  assert.equal(await page.locator('.ytp-subtitles-button').getAttribute('aria-pressed'), 'true', 'an explicit initial enable may attempt to turn native captions on');
  assert.equal((await sends(page)).length, 0);
  await page.screenshot({ path: path.join(root, 'tests/artifacts/youtube-missing-captions.png') });
  await setCue(page, 'Captions are now available.');
  await waitForTranslation(page, '译文：Captions are now available.');
  await page.locator('.ytp-subtitles-button').click();
  await page.waitForFunction(() => document.querySelector('.it-youtube-host').shadowRoot.querySelector('.translation').hidden);
  assert.equal(await page.locator('.ytp-subtitles-button').getAttribute('aria-pressed'), 'false');
  assert.match(await page.locator('.it-youtube-host .message').innerText(), /字幕|CC/);
  await page.waitForTimeout(400);
  assert.equal((await sends(page)).length, 1);
});

test('configuration changes cancel pending caption requests, clear output and require a new click', async t => {
  const page = await fixture(t, { holdTranslation: true });
  await toggle(page).click();
  await page.waitForFunction(() => window.pending.length === 1);
  await page.evaluate(() => {
    window.config.revision++;
    window.listeners.forEach(listener => listener({ type: 'IT_CONFIG_CHANGED' }, {}, () => {}));
  });
  await releaseNext(page);
  await page.waitForTimeout(250);
  assert.equal(await translated(page).isVisible(), false);
  assert.equal(await page.evaluate(() => globalThis.__IT_YOUTUBE__.getStatus().active), false);
  assert.equal((await sends(page)).length, 1);
  assert.ok(await page.evaluate(() => window.calls.some(call => call.type === 'IT_CANCEL_SESSION')));
  await toggle(page).click();
  await page.waitForFunction(() => window.pending.length === 1);
  await releaseNext(page);
  await waitForTranslation(page, '学习一门语言会打开新的大门。');
  assert.equal((await sends(page)).length, 2, 'a new configuration must not reuse a previous translation cache entry');
});

test('YouTube navigation cancels pending responses and never starts translation for the new video', async t => {
  const page = await fixture(t, { holdTranslation: true });
  await toggle(page).click();
  await page.waitForFunction(() => window.pending.length === 1);
  await page.evaluate(() => {
    document.dispatchEvent(new Event('yt-navigate-start'));
    history.pushState({}, '', '/watch?v=fixture-two');
    document.dispatchEvent(new Event('yt-navigate-finish'));
  });
  await setCue(page, 'The first cue of another video.');
  await releaseNext(page);
  await page.waitForTimeout(650);
  assert.equal(await translated(page).isVisible(), false);
  assert.equal(await page.evaluate(() => globalThis.__IT_YOUTUBE__.getStatus().active), false);
  assert.equal((await sends(page)).length, 1);
  assert.ok(await page.evaluate(() => window.calls.some(call => call.type === 'IT_CANCEL_SESSION')));
});

test('the translated caption remains inside the player during fullscreen', async t => {
  const page = await fixture(t);
  await toggle(page).click();
  await waitForTranslation(page, '学习一门语言会打开新的大门。');
  await page.locator('.ytp-fullscreen-button').click();
  await page.waitForFunction(() => document.fullscreenElement?.id === 'movie_player');
  assert.equal(await translated(page).isVisible(), true);
  assert.equal(await page.locator('.it-youtube-host').evaluate(host => document.fullscreenElement.contains(host)), true);
  const playerBox = await page.locator('#movie_player').boundingBox();
  const captionBox = await translated(page).boundingBox();
  assert.ok(captionBox.x >= playerBox.x && captionBox.y >= playerBox.y && captionBox.x + captionBox.width <= playerBox.x + playerBox.width && captionBox.y + captionBox.height <= playerBox.y + playerBox.height, 'translated caption must stay within fullscreen player bounds');
  await page.screenshot({ path: path.join(root, 'tests/artifacts/youtube-fullscreen.png') });
});

test('unconfigured translation offers settings without sending caption text', async t => {
  const page = await fixture(t, { configured: false });
  await toggle(page).click();
  await page.waitForFunction(() => globalThis.__IT_YOUTUBE__.getStatus().state === 'error');
  assert.equal((await sends(page)).length, 0);
  await page.locator('.it-youtube-host .settings').click();
  assert.ok(await page.evaluate(() => window.calls.some(call => call.type === 'IT_OPEN_OPTIONS')));
});

test('late YouTube player controls mount safely and unsupported pages stay untouched', async t => {
  const page = await fixture(t, { beforeScript: async page => {
    await page.evaluate(() => {
      window.savedPlayer = document.querySelector('#movie_player').outerHTML;
      document.querySelector('#movie_player').remove();
    });
  } });
  assert.equal(await page.locator('.it-youtube-host').count(), 0);
  await page.evaluate(() => document.querySelector('main').insertAdjacentHTML('afterbegin', window.savedPlayer));
  await toggle(page).waitFor({ timeout: 3000 });
  assert.equal(await toggle(page).count(), 1);
  assert.equal((await sends(page)).length, 0);
  await page.evaluate(() => {
    document.dispatchEvent(new Event('yt-navigate-start'));
    history.pushState({}, '', '/results?search_query=private');
    document.dispatchEvent(new Event('yt-navigate-finish'));
  });
  await page.waitForFunction(() => !globalThis.__IT_YOUTUBE__.isSupported());
  assert.equal(await page.locator('.it-youtube-host').count(), 0);
});

test('caption cache stays bounded during a long video while recent cues remain reusable', async t => {
  const page = await fixture(t, { clock: true });
  await toggle(page).click();
  await page.clock.fastForward(600);
  assert.equal(await translated(page).innerText(), '学习一门语言会打开新的大门。');
  for (let index = 0; index < 220; index++) {
    await setCue(page, `Unique live cue number ${index}.`);
    await page.clock.fastForward(600);
  }
  assert.equal(await translated(page).innerText(), '译文：Unique live cue number 219.');
  const count = (await sends(page)).length;
  assert.equal(count, 221);
  await setCue(page, 'Unique live cue number 218.');
  await page.clock.fastForward(600);
  assert.equal(await translated(page).innerText(), '译文：Unique live cue number 218.');
  assert.equal((await sends(page)).length, count, 'a recent cue should reuse its cached translation');
  await setCue(page, 'Learning a language opens new doors.');
  await page.clock.fastForward(600);
  assert.equal((await sends(page)).length, count + 1, 'oldest cues should be evicted from a bounded cache');
});

test('caption source and translated strings render as text rather than executable markup', async t => {
  const page = await fixture(t);
  const unsafe = '<img src=x onerror=window.captionScriptExecuted=true>';
  await setCue(page, unsafe);
  await toggle(page).click();
  await waitForTranslation(page, '译文：' + unsafe);
  assert.equal(await page.locator('.it-youtube-host img').count(), 0);
  assert.equal(await page.evaluate(() => !!window.captionScriptExecuted), false);
  assert.equal(await page.locator('.ytp-caption-segment').textContent(), unsafe);
});

test('CC off invalidates pending translation before the cue debounce completes', async t => {
  const page = await fixture(t, { holdTranslation: true });
  await toggle(page).click();
  await page.waitForFunction(() => window.pending.length === 1);
  await page.locator('.ytp-subtitles-button').click();
  await releaseNext(page);
  await page.waitForTimeout(70);
  assert.equal(await translated(page).isVisible(), false, 'a caption response must be rejected as soon as native CC is disabled');
  await page.waitForTimeout(400);
  assert.equal((await sends(page)).length, 1);
});

test('document YouTube navigation start revokes consent before the URL changes', async t => {
  const page = await fixture(t, { holdTranslation: true });
  await toggle(page).click();
  await page.waitForFunction(() => window.pending.length === 1);
  await page.evaluate(() => {
    document.dispatchEvent(new Event('yt-navigate-start'));
    window.pending.shift()?.();
  });
  await page.waitForTimeout(70);
  assert.equal(await page.evaluate(() => globalThis.__IT_YOUTUBE__.getStatus().active), false);
  assert.equal(await translated(page).isVisible(), false, 'a navigation must reject an old cue before its new URL arrives');
  assert.ok(await page.evaluate(() => window.calls.some(call => call.type === 'IT_CANCEL_SESSION')));
});

test('missing CC controls report unavailable captions and recover when controls and a cue arrive', async t => {
  const page = await fixture(t, { beforeScript: async page => {
    await page.locator('.ytp-subtitles-button').evaluate(button => button.remove());
    await setCue(page, '');
  } });
  await toggle(page).click();
  await page.waitForFunction(() => globalThis.__IT_YOUTUBE__.getStatus().state === 'error');
  assert.match(await page.locator('.it-youtube-host .message').innerText(), /字幕/);
  assert.equal((await sends(page)).length, 0);
  await page.evaluate(() => {
    const button = document.createElement('button');
    button.className = 'ytp-subtitles-button';
    button.setAttribute('aria-pressed', 'true');
    button.textContent = 'CC';
    document.querySelector('.ytp-right-controls').prepend(button);
  });
  await setCue(page, 'A cue after the controls mount.');
  await waitForTranslation(page, '译文：A cue after the controls mount.');
  assert.deepEqual((await sends(page)).flatMap(call => call.segments.map(segment => segment.text)), ['A cue after the controls mount.']);
});

test('unpacked extension injects both controllers and panda sends only rendered captions through the real worker', { timeout: 60000 }, async t => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'it-youtube-extension-'));
  const context = await chromium.launchPersistentContext(profile, {
    ...browserOptions(), viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
  });
  t.after(async () => {
    await context.close();
    if (path.dirname(profile) === os.tmpdir() && path.basename(profile).startsWith('it-youtube-extension-')) await rm(profile, { recursive: true, force: true });
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = new URL(worker.url()).host;
  const requests = [];
  await context.route('https://edge.microsoft.com/translate/translatetext*', async route => {
    const body = route.request().postDataJSON();
    requests.push({ body, headers: route.request().headers() });
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body.map(() => ({ translations: [{ text: '学习一门语言会打开新的大门。', to: 'zh-Hans' }] }))) });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://www.youtube.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: markup }));
  await page.goto('https://www.youtube.com/watch?v=fixture-extension');
  const panda = page.locator('#it-translation-root .ball');
  await panda.waitFor();
  assert.equal(await panda.getAttribute('aria-label'), '开启字幕翻译');
  assert.equal(await toggle(page).count(), 1, 'manifest must inject the YouTube module before the panda controller');
  assert.equal(requests.length, 0);
  await panda.click();
  await waitForTranslation(page, '学习一门语言会打开新的大门。');
  assert.equal(await panda.getAttribute('aria-label'), '关闭字幕翻译');
  assert.deepEqual(requests.map(request => request.body), [['Learning a language opens new doors.']]);
  assert.ok(requests.every(request => !request.headers.authorization && !request.headers.cookie));
  assert.equal(await page.locator('.ytp-caption-segment').innerText(), 'Learning a language opens new doors.');
  assert.equal(await page.locator('h1').innerText(), 'A private video title that must never be translated');
  assert.equal(await page.locator('[data-it-translation]:not(.it-youtube-host)').count(), 0, 'panda must route to captions rather than taking an article snapshot');
  await page.screenshot({ path: path.join(root, 'tests/artifacts/youtube-extension-panda.png') });
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  const status = () => options.evaluate(() => chrome.tabs.query({}).then(tabs => chrome.tabs.sendMessage(tabs.find(tab => tab.url?.startsWith('https://www.youtube.com/watch')).id, { type: 'IT_PAGE_STATUS' })));
  const active = await status();
  assert.equal(active.isYouTube, true);
  assert.equal(active.captionActive, true);
  assert.equal(active.state, 'translated');
  await toggle(page).click();
  assert.equal(await panda.getAttribute('aria-label'), '开启字幕翻译');
  assert.equal((await status()).captionActive, false);
  assert.equal(await translated(page).isVisible(), false);
  assert.equal(requests.length, 1);
  assert.deepEqual(errors, []);
});

test('seeking while initial configuration loads does not strand enabled caption translation', async t => {
  const page = await fixture(t, { holdConfig: true });
  await toggle(page).click();
  await page.waitForFunction(() => typeof window.completeConfig === 'function');
  await page.evaluate(() => {
    const video = document.querySelector('video');
    video.dispatchEvent(new Event('seeking'));
    video.dispatchEvent(new Event('seeked'));
  });
  await setCue(page, 'The current cue after initial seeking.');
  await page.evaluate(() => window.completeConfig());
  await waitForTranslation(page, '译文：The current cue after initial seeking.');
  assert.deepEqual((await sends(page)).flatMap(call => call.segments.map(segment => segment.text)), ['The current cue after initial seeking.']);
});

test('keyboard activation of the subtitle toggle does not reach YouTube playback shortcuts', async t => {
  const page = await fixture(t);
  await page.evaluate(() => {
    window.playerKeys = [];
    for (const type of ['keydown', 'keyup']) document.querySelector('#movie_player').addEventListener(type, event => window.playerKeys.push(type + ':' + event.key));
  });
  await toggle(page).focus();
  await page.keyboard.press('Space');
  await waitForTranslation(page, '学习一门语言会打开新的大门。');
  assert.deepEqual(await page.evaluate(() => window.playerKeys), [], 'owned controls must stop keyboard events before player playback handlers');
});

test('stopping restores native CC that the extension enabled for the user', async t => {
  const page = await fixture(t, { beforeScript: page => page.locator('.ytp-subtitles-button').click() });
  assert.equal(await page.locator('.ytp-subtitles-button').getAttribute('aria-pressed'), 'false');
  await toggle(page).click();
  await waitForTranslation(page, '学习一门语言会打开新的大门。');
  assert.equal(await page.locator('.ytp-subtitles-button').getAttribute('aria-pressed'), 'true');
  await toggle(page).click();
  assert.equal(await page.locator('.ytp-subtitles-button').getAttribute('aria-pressed'), 'false', 'stop must restore initially disabled native captions');
});

test('stopping preserves a later manual native CC choice', async t => {
  const page = await fixture(t, { beforeScript: page => page.locator('.ytp-subtitles-button').click() });
  await toggle(page).click();
  await waitForTranslation(page, '学习一门语言会打开新的大门。');
  await page.locator('.ytp-subtitles-button').click();
  await page.locator('.ytp-subtitles-button').click();
  await waitForTranslation(page, '学习一门语言会打开新的大门。');
  await toggle(page).click();
  assert.equal(await page.locator('.ytp-subtitles-button').getAttribute('aria-pressed'), 'true', 'a manual native caption change supersedes extension ownership');
});

test('a fatal response for an obsolete cue ends its session and retry creates a fresh one', async t => {
  const page = await fixture(t, { holdTranslation: true, failFirst: true });
  await toggle(page).click();
  await page.waitForFunction(() => window.pending.length === 1);
  await setCue(page, 'The next cue after an authentication failure.');
  await page.waitForTimeout(350);
  await releaseNext(page);
  await page.waitForFunction(() => globalThis.__IT_YOUTUBE__.getStatus().state === 'error', undefined, { timeout: 2000 });
  assert.match(await page.locator('.it-youtube-host .message').innerText(), /API Key/);
  assert.equal((await sends(page)).length, 1, 'a fatal session must not drain the next queued caption');
  assert.equal(await translated(page).isVisible(), false);
  assert.ok(await page.evaluate(() => window.calls.some(call => call.type === 'IT_CANCEL_SESSION')));
  await page.locator('.it-youtube-host .retry').click();
  await page.waitForFunction(() => window.pending.length === 1);
  await releaseNext(page);
  await waitForTranslation(page, '译文：The next cue after an authentication failure.');
  const sessions = await page.evaluate(() => window.calls.filter(call => call.type === 'IT_START_SESSION').map(call => call.sessionId));
  assert.equal(sessions.length, 2);
  assert.notEqual(sessions[0], sessions[1]);
});

test('continuously growing automatic captions translate within a bounded delay and retain a still-visible prefix', async t => {
  const page = await fixture(t, { clock: true, holdTranslation: true });
  await setCue(page, 'A clear beginning');
  await toggle(page).click();
  for (let word = 1; word <= 16; word++) {
    await setCue(page, 'A clear beginning' + ' additional'.repeat(word));
    await page.clock.fastForward(100);
    if (word === 10) assert.ok((await sends(page)).length >= 1, 'continuous 100ms caption updates must start translation within one second');
  }
  await releaseNext(page);
  await page.clock.fastForward(50);
  assert.equal(await translated(page).isVisible(), true, 'a translated source prefix still visible in an automatic caption remains useful');
  assert.match(await translated(page).innerText(), /^译文：A clear beginning/);
  await setCue(page, 'A clear beginning' + ' additional'.repeat(17));
  await page.clock.fastForward(100);
  assert.equal(await translated(page).isVisible(), true, 'appending another word should preserve the visible prefix translation');
  await setCue(page, 'A wholly different caption replaces the preceding sentence.');
  assert.equal(await translated(page).isVisible(), false, 'replacing the source must clear a preceding prefix translation immediately');
  await page.evaluate(() => window.pending.splice(0).forEach(resolve => resolve()));
  await page.clock.fastForward(100);
  assert.equal(await translated(page).isVisible(), false, 'responses for prefixes removed from the player must be rejected');
});
