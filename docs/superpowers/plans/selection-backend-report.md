# Selection backend report

日期：2026-11-02。状态：Task 1 完成，未提交；交给根代理整合。

## 文件与接口

- 修改 `src/shared.js`：`selectionEnabled` 严格布尔字段，默认 `true`，公开配置仅增加该非敏感字段。
- 修改 `src/background.js`：按 tab/document/url/requestId 绑定的独立划词任务及音频集合；整页/字幕与划词相互独立。标签页移除/导航和全局设置保存取消两类任务；普通会话 start/cancel 只影响普通会话。
- 新增 `src/dictionary.js`：Free Dictionary API v2 英文词条、受限结构化字段与可选音频下载。没有用户文本或查词历史持久化。
- 新增 `tests/dictionary.test.mjs`、`tests/selection-background.test.mjs`，15 项测试。

接口按计划：

- `IT_SELECTION_TRANSLATE {requestId,text,mode:'translate'}` → `{ok:true,config,translations:[{id:'selection',text}]}`。
- `mode:'dictionary'` → `{ok:true,config,dictionary:{word,phonetics,meanings,sources,licenses,translationNotice?}}`。`phonetics` 项含 `text/audio/region?`；`meanings` 项含 `partOfSpeech` 和 `definitions:[{text,original?}]`。英音 region 为“英”，美音为“美”，其他口音不编造标签。
- zh-CN 目标下用已保存引擎翻译英文释义，最多 12 条/6000 字符、分每批 8 条；`original` 保留英文，`translationNotice` 标注引擎。失败时保留英文与提示，不换服务；英文目标不调用翻译器。
- `IT_SELECTION_AUDIO {requestId,audio}` 只允许当前文档和请求曾返回的 audio；`{ok:true,dataUrl}`。并行音频请求返回 `BUSY`；当前单词关闭/失效后拒绝。
- `IT_CANCEL_SELECTION {requestId}` 只取消匹配任务；过期取消不能影响新请求。
- `IT_SET_SELECTION_ENABLED {enabled:boolean}` 仅允许精确 options/popup 地址，保存开关，不改变 revision，不取消正常会话；禁用时取消词典，广播 `IT_SELECTION_CONFIG_CHANGED`。

## 网络与来源

词典固定 HTTPS endpoint，仅查询合法英文单词（含词内连字符/撇号），最大 80 字符。所有 fetch 使用 `credentials:'omit'`、`redirect:'error'`、`referrerPolicy:'no-referrer'`，没有备用服务或 Cookie/密钥转发。

JSON 上限 256 KiB、12 秒总截止，包含传输和读取；音频上限 2,000,000 bytes，MIME 为允许的 audio 类型。仅接受 HTTPS 的 `api.dictionaryapi.dev/media/pronunciations/en/`、`ssl.gstatic.com/dictionary/static/sounds/`、`upload.wikimedia.org/wikipedia/commons/` 路径和音频后缀，无账号/查询/片段。音频没有自动加载。

词条来源只保留 Wiktionary URL；音频额外保留 Commons 的精确 `curid` / `File:` 来源 URL；条目和音频的 Creative Commons 许可均保留到 `licenses`。名称/释义保留为纯文本，调用方需使用 textContent 渲染。正式分发应显示来源和许可链接，中文释义属于原英文释义的翻译。

## RED / GREEN 证据

- 最初新增 12 项测试均因词典模块/消息/字段尚不存在而失败；实现后 12/12 通过。
- 再增加正常会话停止后词典音频仍可用的回归，复现 `IT_CANCEL_SESSION` 误调用 tab 全清理失败；改为只取消普通 session 后通过。
- 超大响应需终止 transport 的回归先失败，加入请求 finally abort 后通过。
- Commons 音频来源保留回归先失败，增加受限来源解析后通过。
- 最终新测试 **15/15 通过**；`node --check src/dictionary.js`、`node --check src/background.js`、所负责文件的 `git diff --check` 通过。
- 全部单测最近一次 **83/85** 通过；两项既有精确对象断言需要加 `selectionEnabled:true`（`tests/ai.test.mjs:24`、`tests/libre-settings.test.mjs:25`），根代理负责更新后最终验证。没有忽略其他失败。

覆盖：普通会话与词典双向独立、真实字段/许可、固定地址与隐私 fetch 参数、非法输入不请求、404/坏 JSON、纯文本恶意内容、不安全来源剔除、长度/流读取/截止/中途取消、跨文档/导航/配置变化失效、迟到结果拒绝、发音懒加载/绑定/取消、英文目标零翻译、译义失败保留英文、开关信任与独立广播。

## 公开固定词的真实只读探测

未读取/发送用户网页或 PDF，也未调用真实翻译引擎。

- `fidelity`：本机 HTTP 200；1 个词性组，音标由该 API 返回 `/faɪˈdɛl.ɪ.ti/`，音频为空。API 源资料质量由来源决定；不能沿用静态图的假音频。Wiktionary 来源和 CC BY-SA 3.0 许可可解析。
- `hello`：HTTP 200；3 个词性组；返回 `hello-au.mp3` / `hello-uk.mp3`，音频来源为 Commons curid 75797336/9021983，分别含 BY-SA 4.0 / BY 3.0 US；词条为 CC BY-SA 3.0。生产 lookupDictionary 客户端实测成功，字段/来源/许可均保留。
- 真实音频 `hello-uk.mp3` 的生产 fetchPronunciation 失败。独立 Python GET 对英音和澳音都返回 **HTTP 502 Bad Gateway**，说明此次上游发音资源不可用；没有自动换来源。受控音频响应的下载和 data URL 单测通过，不能把它报告成真实原声播放已验收。
- 根代理决定另做明确标注的手动“本机朗读”（仅 localService 英语声音）作为本机备用；它不属于本模块，不冒充词典原声，不自动外发。

## 已知边界

英文查词；词条、部分音标或音频缺失属于正常可恢复状态。词典/音频网络可用性不保证；UI 应保留释义并显示局部错误/重试，普通翻译由用户主动选择。没有安装新依赖，没有改其他任务文件，没有提交。
