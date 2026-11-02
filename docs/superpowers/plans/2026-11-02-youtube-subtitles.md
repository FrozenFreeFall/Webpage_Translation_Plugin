# YouTube Subtitles Implementation Plan

> **For agentic workers:** Parallel controller and tests; root integrates existing entry points and verifies final runtime.

**Goal:** YouTube 点击熊猫或播放器“译”按钮开启双语字幕。

**Architecture:** 独立经典 content script 负责字幕观察、单请求队列、有限缓存及播放器 UI；现有 content.js 熊猫转发操作并展示状态；后台复用现有文档级翻译会话。

**Tech Stack:** Manifest V3, native DOM/MutationObserver, existing translation service worker, node:test and Playwright.

**Spec:** docs/superpowers/specs/2026-11-02-youtube-subtitles-design.md

## Global Constraints

- 默认关闭，复用现有配置，无新权限，无语音识别／字幕下载承诺。
- 仅翻译可见字幕，不抓取整个页面／评论；不持久化字幕。
- 新句、跳转、关闭、配置变化时拒绝过期回复；保留用户字幕偏好。

## Review Focus

- 自动字幕逐词更新，避免重复请求及旧句闪现。
- 同一视频进度跳转、字幕语言改变与播放器替换。
- 多页面会话隔离，以及与普通网页翻译的同标签会话冲突。
- 无字幕、CC 关闭、断网和配置缺失时可恢复。
- 字幕浮层、原生字幕和 UI 不触发观察器反馈循环。

### Task 1: Caption controller

Files: src/youtube.js; optional dedicated CSS if required.

Interface: globalThis.__IT_YOUTUBE__ with isSupported(), toggle(), stop(), getStatus(), subscribe(listener).

- [x] Coordinate initial failing browser tests with test implementer.
- [x] Implement caption observation, bounded queue/cache, player button and bilingual overlay, route/config cleanup.
- [x] Verify focused browser cases and screenshot layout.

### Task 2: Existing entry points

Files: manifest.json, src/content.js, src/popup.js, popup.html.

- [x] Route supported YouTube panda clicks to caption controller and expose status in popup.
- [x] Skip caption/player DOM during ordinary web translation; prevent conflicting sessions.
- [x] Cover PDF and ordinary-page behavior with regression tests.

### Task 3: Delivery

Files: tests/youtube.browser.mjs, tools/package.py, README.md, 测试记录.md, dist/沉浸式翻译.zip.

- [x] Review controller and integration, fix functional findings.
- [x] Run unit and browser suites; inspect bilingual screenshot; optional live-site read-only check.
- [x] Update documentation, version and package; verify local asset paths and archive.

The user's request authorizes implementation in the current project without an additional design approval step.
