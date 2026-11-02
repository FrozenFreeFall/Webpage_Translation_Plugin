# 划词翻译独立审查

2026-11-02；审查工作树实现，未修改生产代码。以下行号指审查时版本；主代理正在修复，最终以修复后回归为准。

## Spec compliance

总体符合批准的独立划词会话、下方 8px 定位、英文词典字段与保存引擎释义翻译方案。后台公开配置不含密钥；词典正文与音频限长、限制来源且不携带 Cookie；正文以 textContent 渲染；取消与整页会话分离；关闭与换词使用身份/token 屏蔽旧回复。输入/可编辑/注入译文/插件 UI/播放器跨区排除在读取文本前执行。未发现 Critical 问题。

### Important / P2：网页脚本能够绕过显式点击要求

- 位置：`src/selection.js:46-48` 的 action 工厂；发音接入 `src/selection.js:215`，重试/普通翻译接入 `src/selection.js:140-141`。
- 触发：用户打开词卡后，网页脚本执行 `document.querySelector('#it-selection-root').shadowRoot.querySelector('.pronounce').click()`。open Shadow DOM 可访问，监听器未验证 `event.isTrusted`；与受保护的熊猫触发按钮不同，立即产生 `IT_SELECTION_AUDIO`。错误卡中的重试/普通翻译同样可合成点击，重复发送翻译请求（使用自定义付费引擎时可能产生额外调用）。本机朗读也使用同一工厂。
- 最小验证：使用现有浏览器 fixture，真实点击熊猫，随后在 page.evaluate 中执行上述脚本。观测音频请求从 0 变为 1；失败 fixture 中合成点击“重试”后翻译请求从 1 变为 2。均未再次发生用户点击。
- 建议：为所有有副作用的卡片按钮统一可信事件检查，覆盖 action 工厂与直接绑定的复制/设置等监听器；保留键盘产生的可信 click。加入合成事件不发网络、不朗读、不写剪贴板回归。

### Minor：来源多时丢失许可展示

- 位置：`src/selection.js:247-248`。
- 触发：后台允许最多 9 条 sources 和 8 条 licenses，UI 将两者合并后仅取前 8 条。因此 sources 为 8 条时，即使有有效 CC 许可也全部不显示；许可要求不能由来源数隐式覆盖。
- 建议：分别限额、去重并展示 sources 与 licenses，确保有效许可保留。这是静态确定的分支，未对公共 API 强行构造此类词条。

## Quality

### Important / P2：切换发音按钮使旧按钮永久停留在加载禁用状态

- 位置：`src/selection.js:191-193`，`src/selection.js:203`；相同 token 清理模式也见本机声音等待 `src/selection.js:168-182`。
- 触发：词条含两种发音；点击第一项，音频尚未返回时点击第二项。第二次 stopAudio 增加 audioSerial；第一项回复在第 193 行提前返回，未恢复 disabled/text。旧按钮保留在当前词卡内，直到关闭重查都不能重试。真实后台在第二项到来时还会返回 BUSY，但不会修复第一项。
- 最小验证：扩展现有 fixture 为两种发音，并延迟两个音频回复；先后真实点击两个按钮，再释放全部回复。观测第一项 `{text:'加载发音…',disabled:true}`，第二项 `{text:'再次发音',disabled:false}`。证明并非仍在等待网络。
- 建议：在终止当前音频尝试时显式恢复其控件（包括本机声音等待），或在 finally 中按按钮/尝试所有权恢复旧按钮，不让它修改新尝试。回归应包含同一卡片多按钮切换，以及音频加载与本机声音加载之间的切换。

## Verification scope

- 阅读需求、实施计划、selection/dictionary/background/shared 与 manifest/options/popup 接入。
- 复用现有 Playwright fixture 做上述两项有针对性的浏览器探针，未重复全套测试、未访问真实用户网页内容或发送公共服务请求。
- 85 项单测及其他浏览器/真实扩展集成测试由主代理负责；本报告不把已有测试记录视作自己重新执行的结果。
- 修复后需由主代理补回归并记录结果；本报告为修复前独立审查结论。

## 修订复核（2026-11-02）

仅复核上述三项，不扩展审查范围。通过本地只读检查确认：

- Spec compliance：action 工厂现先检查 event.isTrusted；关闭、设置、复制的直接监听器也有相同保护。发音、合成朗读、重试、普通翻译均经过工厂，原合成点击请求问题已在代码层解决。
- Quality：stopAudio 先递增 token，并恢复前一个 audioButton 的 disabled 和初始文案；词典音频及本机声音等待均登记当前按钮。因此切换时旧按钮立即恢复，迟到回复仍被 token 拦截，不会改写新按钮。原永久禁用问题已在代码层解决。
- Spec compliance：sources 最多 9 条、licenses 最多 8 条分别截取后合并，与后台各自上限一致，来源条数不再挤占许可位置。原许可隐藏问题已解决。

阅读新增回归后，双发音延迟回复与多来源许可两项覆盖了原触发条件；合成点击测试覆盖词典发音、设置、复制。其名称提到 retry，但当前测试体未实际点击重试；统一 action guard 已覆盖该路径，这不影响本次修订结论。

本次仅代码复核，未重复运行浏览器；GREEN 结果由主代理验证。在本次三项修订范围内，没有剩余 Critical / Important 问题。
