# Panda Interaction Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Make the current panda hide its body after idle, respond to dragging as a lifted pet, and run back to the nearest vertical edge on release.

**Architecture:** Preserve the translation button and isolated shadow root. Add a separate pet pose/position state machine inside the content script; CSS/SVG provide hiding, dangling limbs and running poses. Translation state remains independent.

**Tech Stack:** Native JavaScript, Pointer Events, inline SVG/CSS, existing Playwright tests. No added dependency or permission.

**Spec:** User request in this chat: idle panda reveals only its head; dragging lifts it; release makes it run to a nearby place to hug the edge. Implementation defaults: 4 seconds idle, nearest left/right viewport edge, 520ms return, same black-and-white panda.

## Global Constraints

- Preserve trusted-click translation, cancel/restore and keyboard operation.
- Keep the full pet at 82×116; head-only button is 58×62, with stationary head artwork.
- Hover/focus reveal it. Loading, dragging, return animation and an open error panel prevent idle hiding.
- Start dragging only after movement exceeds 6px; a drag must never trigger translation.
- Clamp the pet inside the viewport; mirror artwork at the left edge and keep messages accessible.
- Reduced motion uses immediate docking and no decorative animation.
- No position persistence or additional settings are needed.

## Review Focus

- A click generated after pointerup must not translate following a drag.
- Touch cancellation, pointer capture loss and page lifecycle must not strand a lifted panda.
- Idle timers must not hide the focused control or a visible error panel.
- Left-edge docking, small windows and resizing must keep the head and controls reachable.
- Synthetic page events must not move the pet or invoke translation.

### Task 1: Idle, drag and docking behavior

**Files:** `src/content.js`, `src/content.css`, `tests/pet.browser.mjs`.

**Interfaces:** `.ball[data-pose]` = `docked`, `hidden`, `dragging`, `returning`; `.ball[data-side]` = `left`, `right`. Host custom properties control position and return transitions through both shadow styles and the fallback stylesheet. Existing translation messages and `.ball` labels remain unchanged.

- [x] Add real browser tests for idle/reveal, trusted dragging, click suppression, side selection, bounds and reduced motion; observe failure before implementation.
- [x] Add pose artwork/CSS and trusted pointer handlers; cancel idle and return timers on lifecycle changes.
- [x] Run the new pet tests, including through the complete browser suite, and resolve failures.
- [x] Review actual idle/lifted/return/docked screenshots, and independently review the event lifecycle.

### Task 2: Regression and delivery

**Files:** `README.md`, `测试记录.md`, `dist/沉浸式翻译.zip`.

- [x] Run `node --test tests/*.test.mjs` and `node --test --test-concurrency=2 tests/*.browser.mjs`; record exact results (51 + 44 pass).
- [x] Update usage instructions, produce pose previews and package the current runtime files.
- [x] Verify archive entries match the delivered source files. No git repository is present, so no commit is planned.

## Execution notes

- The first idle test failed against the old implementation. The first full pet run exposed head movement during hiding and fixed host coordinates; both were reproduced and corrected.
- Custom properties are necessary because important shadow-host declarations take precedence over outer inline declarations. Actual drag coordinates and nearest-side docking now pass browser geometry assertions.
- Independent review reproduced keyboard activation during dragging and Escape followed by pointerup activation. Two added tests failed first and pass after guarding active gestures and treating cancellation separately from a completed click.
- Browser files run with concurrency 2, using separate profiles/pages, to shorten full regression time. Individual browser tests remain sequential within each file.
