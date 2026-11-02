import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createPage, root } from './browser-helpers.mjs';

async function fixture(t, { configured = true, holdTranslation = false, reducedMotion = false } = {}) {
  const { browser, page } = await createPage();
  t.after(() => browser.close());
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.emulateMedia({ reducedMotion: reducedMotion ? 'reduce' : 'no-preference' });
  await page.clock.install();
  await page.route('http://pet.fixture.test/**', route => route.fulfill({
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><html lang="en"><title>Pet behavior fixture</title><body><main><p>A readable article paragraph for translation.</p></main></body></html>',
  }));
  await page.addInitScript(({ configured, holdTranslation }) => {
    window.calls = [];
    window.chrome = { runtime: {
      onMessage: { addListener() {} },
      async sendMessage(message) {
        window.calls.push(message);
        if (message.type === 'IT_START_SESSION' || message.type === 'IT_GET_PUBLIC_CONFIG') {
          return { ok: true, config: { targetLanguage: 'zh-CN', configured, revision: 1 } };
        }
        if (message.type === 'IT_TRANSLATE') {
          if (holdTranslation) await new Promise(resolve => { window.finishTranslation = resolve; });
          return { ok: true, translations: message.segments.map(({ id }) => ({ id, text: '这是一段译文。' })), failures: [] };
        }
        return { ok: true };
      },
    } };
  }, { configured, holdTranslation });
  await page.goto('http://pet.fixture.test/article');
  await page.addScriptTag({ path: path.join(root, 'src/content.js') });
  await page.locator('#it-translation-root .ball').waitFor();
  await page.clock.pauseAt(await page.evaluate(() => Date.now()));
  return page;
}

const ball = page => page.locator('#it-translation-root .ball');
const pose = page => ball(page).getAttribute('data-pose');

function near(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) <= 0.75, `${message}: expected ${expected}, got ${actual}`);
}

async function eventually(check, timeout = 1800) {
  const deadline = Date.now() + timeout;
  let lastError;
  do {
    try { await check(); return; } catch (error) { lastError = error; }
    await delay(20);
  } while (Date.now() < deadline);
  throw lastError;
}

async function moveAway(page) {
  await page.mouse.move(20, 20);
}

async function clickBall(page) {
  const box = await ball(page).boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

async function restartIdle(page) {
  const box = await ball(page).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await moveAway(page);
}

async function startDrag(page, target) {
  const box = await ball(page).boundingBox();
  const grab = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 8 });
  return grab;
}

async function assertNoTranslation(page) {
  assert.equal(await page.locator('[data-it-translation]').count(), 0);
  assert.equal(await page.evaluate(() => globalThis.__IT_CONTENT__.state), 'original');
  assert.equal(await page.evaluate(() => window.calls.some(call => call.type === 'IT_START_SESSION' || call.type === 'IT_TRANSLATE')), false);
}

async function assertDocked(page, side, top) {
  assert.equal(await pose(page), 'docked');
  assert.equal(await ball(page).getAttribute('data-side'), side);
  await eventually(async () => {
    const box = await ball(page).boundingBox();
    near(box.width, 82, 'full panda width');
    near(box.height, 116, 'full panda height');
    near(box.x, side === 'left' ? 0 : page.viewportSize().width - 82, 'nearest viewport edge');
    near(box.y, top, 'drop height');
  });
  const facing = await page.locator('#it-translation-root .pet-head').evaluate(head => head.getScreenCTM().a);
  assert.ok(side === 'left' ? facing < 0 : facing > 0, `panda should face the ${side} edge`);
}

test('idle panda tucks away its body after four seconds', async t => {
  const page = await fixture(t, { reducedMotion: true });
  await restartIdle(page);
  const before = await ball(page).boundingBox();
  const headAnchor = () => page.locator('#it-translation-root .pet-head').evaluate(head => {
    const point = new DOMPoint(71, 66).matrixTransform(head.getScreenCTM());
    return { x: point.x, y: point.y };
  });
  const headBefore = await headAnchor();
  assert.equal(before.width, 82);
  assert.equal(before.height, 116);
  await page.clock.fastForward(3999);
  assert.equal(await pose(page), 'docked', 'idle deadline must not fire early');
  await page.clock.fastForward(1);
  assert.equal(await pose(page), 'hidden');
  const box = await ball(page).boundingBox();
  assert.equal(box.width, 58);
  assert.equal(box.height, 62);
  near(box.x + box.width, 1000, 'head remains at the right edge');
  const svg = await page.locator('#it-translation-root svg.pet').boundingBox();
  assert.equal(svg.width, 82, 'artwork must not shrink with its button');
  assert.equal(svg.height, 116, 'artwork must not squash with its button');
  const headAfter = await headAnchor();
  near(headAfter.x, headBefore.x, 'head anchor horizontal position while hiding');
  near(headAfter.y, headBefore.y, 'head anchor vertical position while hiding');
  await assertNoTranslation(page);
});

test('hover wakes the panda, holds it visible, then starts a new four-second idle period', async t => {
  const page = await fixture(t, { reducedMotion: true });
  await restartIdle(page);
  await page.clock.fastForward(4000);
  assert.equal(await pose(page), 'hidden');
  const hidden = await ball(page).boundingBox();
  await page.mouse.move(hidden.x + hidden.width / 2, hidden.y + hidden.height / 2);
  assert.equal(await pose(page), 'docked');
  assert.equal((await ball(page).boundingBox()).height, 116);
  await page.clock.fastForward(8000);
  assert.equal(await pose(page), 'docked', 'hover must keep the full panda visible');
  await moveAway(page);
  await page.clock.fastForward(3999);
  assert.equal(await pose(page), 'docked');
  await page.clock.fastForward(1);
  assert.equal(await pose(page), 'hidden');
});

test('keyboard focus wakes the panda and keeps it visible until focus leaves', async t => {
  const page = await fixture(t, { reducedMotion: true });
  await restartIdle(page);
  await page.clock.fastForward(4000);
  assert.equal(await pose(page), 'hidden');
  await page.keyboard.press('Tab');
  assert.equal(await ball(page).evaluate(button => button.matches(':focus-visible')), true);
  assert.equal(await pose(page), 'docked');
  assert.equal((await ball(page).boundingBox()).height, 116);
  await page.clock.fastForward(8000);
  assert.equal(await pose(page), 'docked');
  await page.keyboard.press('Tab');
  assert.equal(await ball(page).evaluate(button => button.matches(':focus-visible')), false);
  await page.clock.fastForward(4000);
  assert.equal(await pose(page), 'hidden');
  await assertNoTranslation(page);
});

test('loading keeps the panda visible until the translation finishes', async t => {
  const page = await fixture(t, { holdTranslation: true, reducedMotion: true });
  await clickBall(page);
  await eventually(async () => assert.equal(await page.evaluate(() => typeof window.finishTranslation), 'function'));
  assert.equal(await page.evaluate(() => globalThis.__IT_CONTENT__.state), 'loading');
  await moveAway(page);
  await page.clock.fastForward(8000);
  assert.equal(await pose(page), 'docked');
  assert.equal((await ball(page).boundingBox()).height, 116);
  await page.evaluate(() => window.finishTranslation());
  await eventually(async () => assert.equal(await page.evaluate(() => globalThis.__IT_CONTENT__.state), 'translated'));
  await restartIdle(page);
  await page.clock.fastForward(4000);
  assert.equal(await pose(page), 'hidden');
});

test('an open error panel keeps the panda visible and its message readable', async t => {
  const page = await fixture(t, { configured: false, reducedMotion: true });
  await clickBall(page);
  await eventually(async () => assert.equal(await page.evaluate(() => globalThis.__IT_CONTENT__.state), 'error'));
  await moveAway(page);
  await page.clock.fastForward(8000);
  assert.equal(await pose(page), 'docked');
  assert.equal((await ball(page).boundingBox()).height, 116);
  assert.equal(await page.locator('#it-translation-root .panel').isVisible(), true);
  assert.ok((await page.locator('#it-translation-root .message').innerText()).length > 0);
  assert.equal(await page.evaluate(() => window.calls.some(call => call.type === 'IT_TRANSLATE')), false);
});

for (const [side, target, expectedTop] of [
  ['left', { x: 180, y: 220 }, 162],
  ['right', { x: 820, y: 480 }, 422],
]) {
  test(`real dragging lifts the panda and returns it to the nearest ${side} edge without translating`, async t => {
    const page = await fixture(t);
    await startDrag(page, target);
    assert.equal(await pose(page), 'dragging');
    const dragged = await ball(page).boundingBox();
    near(dragged.x, target.x - 41, 'grab horizontal offset');
    near(dragged.y, expectedTop, 'grab vertical offset');
    await assertNoTranslation(page);
    await page.mouse.up();
    assert.equal(await pose(page), 'returning');
    assert.equal(await ball(page).getAttribute('data-side'), side);
    await page.clock.fastForward(519);
    assert.equal(await pose(page), 'returning', 'return animation should still be running');
    await page.clock.fastForward(1);
    await assertDocked(page, side, expectedTop);
    await assertNoTranslation(page);
    await clickBall(page);
    await eventually(async () => assert.equal(await page.locator('[data-it-translation]').count(), 1));
    assert.equal(await page.evaluate(() => globalThis.__IT_CONTENT__.state), 'translated', 'a fresh click after dragging must still translate');
  });
}

test('movement of six pixels is still a click, and pointer focus does not prevent later hiding', async t => {
  const page = await fixture(t, { reducedMotion: true });
  const box = await ball(page).boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 6, y);
  assert.equal(await pose(page), 'docked');
  await page.mouse.up();
  await eventually(async () => assert.equal(await page.locator('[data-it-translation]').count(), 1));
  assert.equal(await ball(page).evaluate(button => button.matches(':focus-visible')), false);
  await moveAway(page);
  await page.clock.fastForward(4000);
  assert.equal(await pose(page), 'hidden');
});

test('movement beyond six pixels starts dragging and clamps release height to the viewport', async t => {
  const page = await fixture(t, { reducedMotion: true });
  const box = await ball(page).boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 6, y);
  assert.equal(await pose(page), 'docked');
  await page.mouse.move(x + 7, y);
  assert.equal(await pose(page), 'dragging');
  await page.mouse.move(180, 1, { steps: 8 });
  await page.mouse.up();
  await assertDocked(page, 'left', 8);
  await assertNoTranslation(page);
  await startDrag(page, { x: 820, y: 699 });
  await page.mouse.up();
  await assertDocked(page, 'right', 576);
  await assertNoTranslation(page);
});

test('page scripts cannot synthesize dragging or paid translation', async t => {
  const page = await fixture(t, { reducedMotion: true });
  const before = await ball(page).boundingBox();
  await page.evaluate(() => {
    const button = document.querySelector('#it-translation-root').shadowRoot.querySelector('.ball');
    const box = button.getBoundingClientRect();
    const options = { bubbles: true, composed: true, pointerId: 77, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1 };
    button.dispatchEvent(new PointerEvent('pointerdown', { ...options, clientX: box.x + 41, clientY: box.y + 58 }));
    button.dispatchEvent(new PointerEvent('pointermove', { ...options, clientX: 180, clientY: 220 }));
    button.dispatchEvent(new PointerEvent('pointerup', { ...options, buttons: 0, clientX: 180, clientY: 220 }));
    button.click();
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
  });
  assert.equal(await pose(page), 'docked');
  const after = await ball(page).boundingBox();
  near(after.x, before.x, 'synthetic drag horizontal position');
  near(after.y, before.y, 'synthetic drag vertical position');
  await assertNoTranslation(page);
});

test('resizing the viewport keeps a docked or hidden panda on its chosen edge and inside vertical bounds', async t => {
  const page = await fixture(t, { reducedMotion: true });
  await startDrag(page, { x: 820, y: 699 });
  await page.mouse.up();
  await assertDocked(page, 'right', 576);
  await moveAway(page);
  await page.setViewportSize({ width: 600, height: 300 });
  await eventually(async () => {
    const box = await ball(page).boundingBox();
    near(box.x, 518, 'docked panda tracks new right edge');
    assert.ok(box.y >= 8 && box.y <= 176, `docked top must fit new viewport, got ${box.y}`);
  });
  await page.clock.fastForward(4000);
  assert.equal(await pose(page), 'hidden');
  await page.setViewportSize({ width: 460, height: 240 });
  await eventually(async () => {
    const box = await ball(page).boundingBox();
    near(box.x + box.width, 460, 'hidden head tracks new right edge');
    assert.ok(box.y >= 8 && box.y <= 116, `hidden position must leave room to wake, got ${box.y}`);
  });
  await assertNoTranslation(page);
});

test('reduced motion immediately docks at the nearest edge after release', async t => {
  const page = await fixture(t, { reducedMotion: true });
  await startDrag(page, { x: 180, y: 320 });
  assert.equal(await pose(page), 'dragging');
  await page.mouse.up();
  await assertDocked(page, 'left', 262);
  await assertNoTranslation(page);
});

test('pagehide during a drag clears the lifted pose and permits a fresh drag after pageshow', async t => {
  const page = await fixture(t, { reducedMotion: true });
  await startDrag(page, { x: 220, y: 320 });
  assert.equal(await pose(page), 'dragging');
  await page.evaluate(() => {
    dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await page.mouse.up();
  assert.equal(await pose(page), 'docked');
  await assertNoTranslation(page);
  await startDrag(page, { x: 820, y: 320 });
  assert.equal(await pose(page), 'dragging');
  await page.mouse.up();
  await assertDocked(page, 'right', 262);
  await assertNoTranslation(page);
});

test('Enter and Space during a pointer drag cannot translate, including after release', async t => {
  const page = await fixture(t, { reducedMotion: true });
  await startDrag(page, { x: 200, y: 250 });
  assert.equal(await pose(page), 'dragging');
  await page.keyboard.press('Enter');
  await assertNoTranslation(page);
  await page.keyboard.press('Space');
  await assertNoTranslation(page);
  assert.equal(await pose(page), 'dragging');
  await page.mouse.up();
  await assertNoTranslation(page);
});

test('Escape cancels a stationary pointer click and leaves the next fresh click usable', async t => {
  const page = await fixture(t, { reducedMotion: true });
  const box = await ball(page).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await assertNoTranslation(page);
  await clickBall(page);
  await eventually(async () => assert.equal(await page.locator('[data-it-translation]').count(), 1));
  assert.equal(await page.evaluate(() => globalThis.__IT_CONTENT__.state), 'translated');
});
