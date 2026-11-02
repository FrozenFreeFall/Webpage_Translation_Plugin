# LibreTranslate 接入计划

用户已追加授权：在原有谷歌、微软和 AI 之外接入 LibreTranslate。

## 设计

- 新增 provider=`libretranslate`，默认微软不变；不自动切换服务。
- 新配置 `libreEndpoint` 和 `libreApiKey` 独立于 AI endpoint/model/apiKey，旧配置补空值；未选择的引擎配置不影响当前引擎使用。
- 地址允许 HTTP/HTTPS，拒绝账号密码、查询参数和片段；根地址、代理子路径自动补 `/translate`，已完整地址不重复补。HTTP 明文只建议用于本机或可信网络，公网推荐 HTTPS。
- 未填写 LibreTranslate 地址可以保存草稿，但公开 configured=false，点击网页不发送请求；可选 Key 留空即不发送 api_key。
- POST JSON `{q:[...],source:'auto',target:'zh'或'en',format:'text',api_key?:...}`；服务只收到需要翻译的文本及自身可选密钥，不收到 AI Key。
- 译文按输入顺序对应；数量不匹配拒绝错位；数量正确时有效段保留、空值或错误项单独失败。
- 整批20秒超时和取消；429/5xx最多额外重试一次，持续限流/超时/无法连接停止当前页任务；无自动第三方后备。
- 后台原有可信存储、保存 revision 变化、取消与广播逻辑继续使用。

## 任务和文件

- [x] 主代理：shared.js 配置/校验/公开状态、旧配置迁移测试、集成测试、版本0.3.0与文档。
- [x] 引擎代理：新增src/libretranslate.js，修改src/translator.js，新增tests/libretranslate.test.mjs；先红后绿验证协议、映射、密钥隔离、取消、重试。
- [x] UI代理：options.html、src/options.js、src/ui.css、tests/settings.browser.mjs；独立地址/可选Key、字段按引擎展示、保存/测试/清Key、保留AI草稿。
- [x] Node全测51项、UI13项、实际扩展集成3项、受影响内容回归3项通过；AI按钮文案收紧后追加单项通过。
- [x] 独立只读审查未发现确定实质缺陷；16文件白名单ZIP已通过CRC及源码一致性校验，采用原哈希核验脚本写回项目。

## 验证与限制

按官方 [翻译API](https://docs.libretranslate.com/api/operations/translate/) 接入，服务支持的语言取决于部署时安装的模型。[自建与托管说明](https://docs.libretranslate.com/) 区分本机免费部署与收费托管；不默认填写公共服务地址或宣称公共实例免费。

用户尚未提供实际部署地址，不安装模型或自动部署服务。使用独立本地协议测试服务器/受控响应验证插件链路，不把该验证称为真实翻译模型质量验收。

在需求仓库可写临时副本完成代码和测试，最后写回 `C:/Users/Administrator/Android/Code/沉浸式翻译`，同步前按原文件哈希检查并发修改。
