# Selection Translation Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task; independent backend work and review may be delegated. Steps use checkbox syntax for tracking.

**Goal:** 实现已选定的第 1 版随选浮卡，以及单词下方的小词典卡。

**Architecture:** 独立 selection 内容脚本管理选区、浮卡和发音。后台另设按 tab/document/request 绑定的划词会话，不复用整页／字幕会话。单词从 Free Dictionary API 获取真实字段，中文义项由当前已保存引擎翻译；音频经后台按允许来源获取，仅点击发音时请求。

**Tech Stack:** 原生 JavaScript、Chrome MV3、Shadow DOM、Node test、Playwright。

**Spec:** `docs/superpowers/specs/2026-11-02-selection-translation-requirements.md`；2026-11-02 用户确认第 1 版句段卡及补充词典卡，并要求靠近单词下方。

## Global Constraints

- 桌面 Chrome／Edge 125+，不加构建步骤与运行依赖。
- 选中只出现熊猫按钮，点击才查询；普通 HTTP/S 顶层网页，1–3000 字符。
- 词卡优先在选词下方 8px，左边靠近选词；视口不足时才向上／左右避让。
- 输入、可编辑区域、插件 UI、注入译文、播放器及跨禁区选区不采集。
- 单词提供音标、手动发音、词性、多义释义；缺失字段不编造。
- 划词任务及音频关闭／替换不会取消网页与字幕翻译；配置全局保存保持现有清理行为。
- 不持久化查词正文／历史，不外泄配置密钥，不静默切换服务。

## Review Focus

- 单词卡加载后变高仍紧邻选词、窄屏与底部不出界。
- 新词、关闭、配置变化与导航后的旧回复不得更新新卡或播放旧音频。
- 表单／Shadow DOM／跨禁区选区不得采集；浮卡内部选字不递归查询。
- 词典正文、音频、来源 URL 均当不可信数据处理，限制长度／协议／来源，不使用 HTML 渲染。
- 划词开关与取消和持续字幕／整页翻译相互独立。

## Task 1: 后台独立划词与词典通道

Files: `src/background.js`, `src/shared.js`, new `src/dictionary.js`, `tests/selection-background.test.mjs`, `tests/dictionary.test.mjs`.

Interfaces:
- `IT_SELECTION_TRANSLATE {requestId,text,mode:'dictionary'|'translate'}` → `{ok:true,config,translations? / dictionary}`.
- Translation result: `{text}`; dictionary: `{word,phonetics:[{text,audio,region?}],meanings:[{partOfSpeech,definitions:[{text,original?}]}],sources:[{name,url}],licenses:[{name,url}],translationNotice?}`.
- `IT_SELECTION_AUDIO {requestId,audio}` → `{ok:true,dataUrl}`; only audio previously returned for the same request/document may be fetched.
- `IT_CANCEL_SELECTION {requestId}` cancels only matching selection request.
- `IT_SET_SELECTION_ENABLED {enabled:boolean}` trusted popup/options only; no cancellation of normal translation sessions. Broadcast `IT_SELECTION_CONFIG_CHANGED`.
- `publicConfig.selectionEnabled` and normalized setting default true; options save can change it.

- [ ] Write failing tests: normal translation survives word queries/cancellation; stale document/cancel/race; disabled feature; fixed dictionary URL/no credentials; malformed/404/limits; URL validation; audio bounded and only after explicit message.
- [ ] Observe RED, implement minimal channel and dictionary client. Fetch dictionary HTTPS only, no cookies/redirects, bounded JSON/audio, timeout/abort; return safe structured data.
- [ ] Translate bounded English definitions with saved engine for zh-CN, preserve original and label translation. Failed definition translation retains English and clear notice, no automatic provider fallback.
- [ ] Run new tests and existing backend/provider tests; self-review and report.

## Task 2: Selection controller and usable UI

Files: new `src/selection.js`, new `tests/selection.browser.mjs`; `manifest.json`, `src/content.js` exclusion if needed.

- [ ] Write and observe failing browser tests for trigger-only-before-click, sentence card, real word card positioned beneath selected word, font-safe bounds and edge fallback.
- [ ] Add Shadow DOM lightweight branded card, accessible buttons, original preview, copy feedback, settings, close, error retry/manual ordinary translation, 2–3 senses and expand more.
- [ ] Freeze text/range when triggered; reject forbidden intersections before reading text; one UI; new selection/scroll/outside/Esc/navigation cleanup; stale replies ignored.
- [ ] Fetch/pronounce only on explicit click. Stop old audio and revoke data on close/new selection; no overlapping playback, errors recover locally.
- [ ] Browser tests for excluded fields/cross-range, internal UI selection, duplicates, delayed responses, keyboard, disabled config, cancellation, XSS-shaped plain text.
- [ ] Integrate content script and local panda image with limited web-accessible resource; skip selection host during whole-page collection.

## Task 3: Settings, release docs and final verification

Files: `options.html`, `src/options.js`, `popup.html`, `src/popup.js`, related browser tests; README/spec/test record; package whitelist and version files.

- [ ] Add simple selection toggle in settings and toolbar popup; update data-flow disclosure for dictionary word, definition translation and manual audio.
- [ ] Update spec to approved status and concrete source decision; README install/use and scope; 0.6.0 version; package includes new scripts.
- [ ] Run all unit/browser tests; inspect sentence/word screenshots; read-only public canned-word live probe if useful, never submit user page content.
- [ ] Fresh independent code review, resolve findings; build ZIP, verify all bytes/assets/version and Markdown links.

## Progress and rulings

- 2026-11-02: 用户已批准已展示的需求与布局，直接执行，不重复请求方案批准。此前 0.5.3 文件改动保留。
- Ruling: 选择 Free Dictionary API 英文数据，中文义项由已选引擎翻译并保留英文原释义；这是实现选择，不代表用户指定供应商。没有音频时明确无发音，不使用伪造词典资料。
- Ruling: 沿当前工作目录协作，切到 `codex/selection-translation` 保存 main 并保留未提交工作；无需复制当前未提交资源到新工作树。

- Task 1: 后台和词典层完成。新增15项RED→GREEN；主代理更新2处公开配置期望后，全部85项Node测试通过。
- Task 2: 浮卡完成。10项浏览器测试通过；含选中零查询、8px下方定位、取消、窄屏、输入排除、超长与HTML文本。本机朗读仅显式点击与本地英语声音。
- Task 3: 设置4项新回归+4项既有相关回归通过；真实扩展/worker/受控HTTP全链路1项通过。全套浏览器回归与独立审查进行中。
- Ruling: 实测公开词条HTTP200，而词典音频HTTP502；增加明确标注的手动本机朗读，只用localService英语voice，不自动调用外部备用服务，缺声音明确提示。
- Ruling: 模块之间按固定接口并行开发，编辑文件互不重叠；最终整合与全套回归在当前工作目录执行，原0.5.3修改保留。
