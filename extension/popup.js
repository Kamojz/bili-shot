/**
 * BiliShot — 工具栏弹窗脚本
 */
'use strict';

const DEFAULTS = {
  enabled: true,
  baseKey: 'Insert',
  defaultMode: 'view',
  saveAction: 'clipboard',
  format: 'png',
  jpegQuality: 0.92,
  downloadSubfolder: 'B站截图',
  filenameTemplate: 'bili_{date}_{time}',
  showPreview: true,
  previewSeconds: 6,
  skipWhenTyping: true
};

const $ = (id) => document.getElementById(id);
let activeTab = null;
let isBilibili = false;

document.addEventListener('DOMContentLoaded', init);

async function init() {
  const settings = await chrome.storage.sync.get(DEFAULTS);
  $('defaultMode').value = settings.defaultMode;
  $('saveAction').value = settings.saveAction;
  $('enabled').value = String(!!settings.enabled);
  renderKeyLabels(settings.baseKey);

  bind(settings);
  await detectTab();
}

function renderKeyLabels(baseKey) {
  const label = keyLabel(baseKey);
  $('kbdBase').textContent = label;
  $('kbdShift').textContent = label;
  $('kbdAlt').textContent = label;
}

function keyLabel(code) {
  if (!code) return 'Insert';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `小键盘 ${code.slice(6)}`;
  return code;
}

function bind(settings) {
  $('defaultMode').addEventListener('change', (event) => {
    chrome.storage.sync.set({ defaultMode: event.target.value });
  });
  $('saveAction').addEventListener('change', (event) => {
    chrome.storage.sync.set({ saveAction: event.target.value });
  });
  $('enabled').addEventListener('change', (event) => {
    chrome.storage.sync.set({ enabled: event.target.value === 'true' });
  });

  $('captureBtn').addEventListener('click', async () => {
    if (!activeTab || activeTab.id == null) return;
    const button = $('captureBtn');
    button.disabled = true;
    button.textContent = '截图中…';
    try {
      if (isBilibili) {
        await chrome.tabs.sendMessage(activeTab.id, { type: 'RUN_CAPTURE', mode: 'default' });
      } else {
        // 非 B站 页面：用备用快捷键的同一条链路
        await chrome.runtime.sendMessage({ type: 'CAPTURE_TAB' }).then(async (shot) => {
          if (!shot || !shot.ok) throw new Error((shot && shot.error) || '截图失败');
          const result = await chrome.runtime.sendMessage({
            type: 'DELIVER',
            dataUrl: shot.dataUrl,
            meta: { title: activeTab.title || '页面截图', mode: 'view' }
          });
          if (!result || !result.ok) throw new Error((result && result.error) || '保存失败');
        });
      }
      window.close();
    } catch (err) {
      button.disabled = false;
      button.textContent = '立即截取当前页面';
      updateStatus('warn', /Receiving end|Could not establish/i.test(String(err))
        ? '请刷新这个页面后重试（插件刚安装/更新过）'
        : String((err && err.message) || err));
    }
  });

  $('optionsBtn').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  // 让快捷键说明里的组合跟随当前设置
  if (settings.baseKey) renderKeyLabels(settings.baseKey);
}

async function detectTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTab = tab || null;
    isBilibili = /^https?:\/\/([a-z0-9-]+\.)*bilibili\.com(\/|$)/i.test((tab && tab.url) || '');

    if (isBilibili) {
      updateStatus('ok', '当前在 B站 页面，直接按 Ins 键即可截图');
    } else {
      updateStatus('warn', '当前不在 B站 页面：Ins 键只在 bilibili.com 生效');
      $('captureBtn').textContent = '截取当前页面（通用）';
    }
  } catch (err) {
    updateStatus('warn', '无法读取当前标签页信息');
  }
}

function updateStatus(kind, text) {
  const status = $('status');
  status.className = `status ${kind || ''}`.trim();
  $('statusText').textContent = text;
}
