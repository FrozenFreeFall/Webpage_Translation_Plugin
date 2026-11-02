const form = document.querySelector('#settingsForm');
const status = document.querySelector('#status');
const fields = ['provider', 'endpoint', 'model', 'apiKey', 'targetLanguage', 'libreEndpoint', 'libreApiKey'];
const consent = document.querySelector('#consent');
let saved;
let loading = false;
function applyProvider() {
  const provider = document.querySelector('#provider').value;
  const ai = provider === 'ai';
  const libre = provider === 'libretranslate';
  document.querySelector('#aiSettings').hidden = !ai;
  document.querySelector('#aiSettings').disabled = loading || !ai;
  for (const name of ['endpoint', 'model', 'apiKey']) {
    const field = document.getElementById(name);
    field.disabled = loading || !ai;
    field.required = ai && name !== 'apiKey';
  }
  document.querySelector('#libreSettings').hidden = !libre;
  document.querySelector('#libreSettings').disabled = loading || !libre;
  for (const name of ['libreEndpoint', 'libreApiKey']) {
    document.getElementById(name).disabled = loading || !libre;
  }
  const service = provider === 'google' ? '谷歌' : '微软';
  document.querySelector('#providerHelp').textContent = ai
    ? '使用兼容 Chat Completions 的 AI 服务，默认提供 DeepSeek 配置。'
    : libre ? '连接自行部署或信任的 LibreTranslate 实例。服务支持的语言取决于部署时安装的模型；请按服务方要求配置可选密钥。'
    : '免 API Key，无需注册。公共网页接口可能失效或限流。' + (provider === 'google' ? '谷歌需要网络可达。' : '');
  document.querySelector('#dataDescription').textContent = ai
    ? '开启翻译后，需翻译的网页正文会发送至你配置的 AI 服务，可能产生 API 费用。'
    : libre ? '开启翻译后，需翻译的网页正文会发送至你自行配置的 LibreTranslate 实例。请选择自己部署或信任的实例。'
    : `开启翻译后，需翻译的网页正文会发送至${service}翻译服务。`;
  document.querySelector('#testDescription').textContent = '测试连接仅发送固定短文本，草稿不会保存。' + (ai ? '测试也可能产生少量 API 费用。' : '');
  document.querySelector('#consentDescription').textContent = '我已知晓正文和固定测试文本的数据流向。' + (ai ? '我已知晓可能产生 API 费用。' : '');
}
document.querySelector('#provider').addEventListener('change', applyProvider);
function message(text, error = false) {
  status.textContent = text;
  status.className = error ? 'error' : 'success';
}
function busy(value) {
  loading = value;
  for (const element of form.elements) element.disabled = value;
  form.setAttribute('aria-busy', String(value));
  applyProvider();
}
function draft() {
  return Object.fromEntries(fields.map(name => [name, document.getElementById(name).value.trim()]));
}
async function send(type, settings) {
  const result = await chrome.runtime.sendMessage({ type, ...(settings ? { settings } : {}) });
  if (!result?.ok) {
    const error = new Error(result?.error?.message || '操作未完成，请重试。');
    error.controlled = true;
    throw error;
  }
  return result;
}
async function action(type) {
  if (!consent.checked) { message('请先勾选确认数据流向。', true); return; }
  if (!form.reportValidity()) return;
  const settings = draft();
  busy(true);
  message(type === 'IT_TEST_CONNECTION' ? (settings.provider === 'ai' ? '正在测试连接，可能产生少量 API 费用…' : '正在测试连接…') : '正在保存…');
  try {
    await send(type, settings);
    if (type === 'IT_SAVE_SETTINGS') saved = { ...settings };
    message(type === 'IT_TEST_CONNECTION' ? '连接成功。固定短文本测试通过，草稿未保存。' : '设置已保存，已开启的页面翻译将还原。');
  } catch (error) { message(error.controlled ? error.message : settings.provider === 'ai' ? '连接失败或保存未完成，请检查服务地址、模型、API Key、网络与服务权限后重试。' : settings.provider === 'libretranslate' ? '连接失败或保存未完成，请检查 LibreTranslate 实例地址、可选 API Key、网络与服务权限后重试。' : '连接失败或保存未完成，请检查网络后重试。公共接口可能失效或限流；谷歌需要网络可达。', true); }
  finally { busy(false); }
}
form.addEventListener('submit', event => { event.preventDefault(); void action('IT_SAVE_SETTINGS'); });
document.querySelector('#test').addEventListener('click', () => { void action('IT_TEST_CONNECTION'); });
document.querySelector('#clear').addEventListener('click', async () => {
  if (!saved) return;
  busy(true);
  try {
    // Clear the persisted configuration, never save unrelated draft changes.
    await send('IT_SAVE_SETTINGS', { ...saved, apiKey: '' });
    saved.apiKey = '';
    document.querySelector('#apiKey').value = '';
    message(saved.provider === 'ai' ? 'AI 密钥已清除并保存，AI 翻译调用已停用。' : saved.provider === 'libretranslate' ? 'AI 密钥已清除并保存，LibreTranslate 配置已保留。' : 'AI 密钥已清除并保存，当前免费引擎仍可用。');
  } catch { message('密钥清除失败，请重试。', true); }
  finally { busy(false); }
});
document.querySelector('#clearLibre').addEventListener('click', async () => {
  if (!saved) return;
  busy(true);
  try {
    // Clear only the persisted LibreTranslate key, preserving every other saved field.
    await send('IT_SAVE_SETTINGS', { ...saved, libreApiKey: '' });
    saved.libreApiKey = '';
    document.querySelector('#libreApiKey').value = '';
    message('LibreTranslate 密钥已清除并保存。实例是否需要密钥由服务方决定；无需鉴权的实例仍可使用。');
  } catch { message('LibreTranslate 密钥清除失败，请重试。', true); }
  finally { busy(false); }
});
busy(true);
try {
  const result = await send('IT_GET_SETTINGS');
  saved = { libreEndpoint: '', libreApiKey: '', ...result.settings, provider: result.settings.provider || 'ai' };
  for (const name of fields) document.getElementById(name).value = saved[name] || '';
  consent.checked = Boolean(saved.apiKey);
  busy(false);
} catch { message('无法加载设置，请关闭此页后从插件重新打开。', true); }
