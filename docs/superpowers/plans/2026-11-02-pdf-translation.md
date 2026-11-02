# PDF Translation Implementation Plan

> **For agentic workers:** Use focused parallel implementers for independent PDF text and reader UI modules; root integrates entry points and runs whole-feature review.

**Goal:** PDF 页面点击熊猫进入阅读器，支持双语对照与双语阅读。

**Architecture:** 本地 PDF.js 渲染与提取页面；纯函数整理可翻译段落；阅读器负责双模式及生命周期；后台复用现有翻译会话并单独校验 PDF 扩展页面来源。

**Tech Stack:** Manifest V3, JavaScript modules, vendored PDF.js, node:test, existing Playwright test harness.

**Spec:** docs/superpowers/specs/2026-11-02-pdf-translation-design.md

## Global Constraints

- 两种阅读模式，默认双语对照，沿用现有设置与视觉。
- 正文/译文不持久化，不自动翻译整本，不新增 OCR、导出或第三方页面。
- PDF 页面不能读取密钥；解析器和 worker 随扩展打包。
- 用户已核实原生 PDF 熊猫可显示，不再验证这一前提。

## Review Focus

- 非 .pdf 路径的 PDF 内容类型也能从熊猫跳转。
- 非法 URL、仿冒扩展路径、跨文档请求不可借用会话。
- 大段落按现有 3000/6000 字符和 8 段限制分批。
- 快速翻页/取消/切文件后旧请求不可覆盖新页。
- 缺少文字、密码文档、网络失败均有可操作状态。

### Task 1: PDF parsing and text model

Files: vendor/pdfjs/*, tools/vendor-pdfjs.mjs, src/pdf-model.js, tests/pdf-model.test.mjs, package.json / package-lock.json.

Interfaces: `extractPageBlocks(textContent, viewport)` returns `{id,text,x,y,width,height,fontSize,kind}`[] where kind is text/code; `makeTranslationBatches(blocks)` returns valid segment arrays. PDF.js import at vendor/pdfjs/pdf.mjs, worker pdf.worker.mjs; fonts/cmaps/wasm included.

- [x] Write and run failing extraction/batching tests.
- [x] Implement pure model and reproducible vendor script; run focused tests.

### Task 2: Reader

Files: pdf.html, src/pdf.js, src/pdf.css, tests/pdf.browser.mjs, tests/fixtures/sample.pdf.

Consumes Task 1 plus `IT_GET_PUBLIC_CONFIG`, `IT_START_SESSION`, `IT_TRANSLATE`, `IT_CANCEL_SESSION`, `IT_OPEN_OPTIONS`. Uses `pdf.html?file=<encoded URL>&page=N`. Produces real PDF loading, page canvas and outline, compare/reading modes, cancellation/retry and local file loading.

- [x] Implement reader and meaningful browser tests with deterministic PDF/provider transport.
- [x] Verify no request on open, result reuse across modes, navigation/cancel/error handling.

### Task 3: Entrypoints and backend

Files: src/pdf-entry.js, src/content.js, src/popup.js, popup.html, src/background.js, manifest.json, tests/pdf-entry.test.mjs, tests/background.test.mjs.

- [x] Write and run failing URL/session tests.
- [x] Route PDF panda clicks using `IT_OPEN_PDF_READER`; keep ordinary web behavior.
- [x] Allow exact PDF reader document for translation only; keep secrets restricted to options/popup.
- [x] Add popup fallback and verify content fixture PDF routing.

### Task 4: Delivery

Files: tools/package.py, README.md, 测试记录.md, dist/沉浸式翻译.zip.

- [x] Run unit and browser suites; inspect real reader screenshots.
- [x] Review full diff, resolve functional findings, package runtime dependencies, verify ZIP entries.

Execution follows the user's instruction to implement selected layout; no additional design approval is required.
