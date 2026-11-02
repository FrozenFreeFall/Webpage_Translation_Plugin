const pageStatus = document.querySelector('#pageStatus');
const open = document.querySelector('#openOptions');
open.addEventListener('click', async () => {
  open.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: 'IT_OPEN_OPTIONS' });
    if (!result?.ok) throw new Error();
  } catch { document.querySelector('#status').textContent = '设置打开失败，请从浏览器扩展管理页打开设置。'; }
  finally { open.disabled = false; }
});
try {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!Number.isInteger(tab?.id)) throw new Error();
  const response = await chrome.tabs.sendMessage(tab.id, { type: 'IT_PAGE_STATUS' });
  if (!response?.ok || !response.supported) throw new Error();
  const labels = { idle: '正在显示原文。点击网页侧边大熊猫开启翻译。', original: '正在显示原文。点击网页侧边大熊猫开启翻译。', translating: '正在翻译。点击网页大熊猫可取消并还原。', translated: '正在显示双语译文。点击网页大熊猫还原。', partial: '部分内容未翻译，可在网页中重试失败内容或还原。', error: '翻译未完成。请在网页中查看错误提示或打开设置检查连接。' };
  pageStatus.textContent = labels[response.state] || '页面已连接。请使用网页侧边大熊猫查看和操作翻译。';
  if (response.state === 'loading') pageStatus.textContent = labels.translating;
} catch { pageStatus.textContent = '此页面可能是浏览器受限页面，或尚未获得站点授权。普通网页请确认权限后刷新，再点击大熊猫。'; }
