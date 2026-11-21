/**
 * B站快捷截图 · BiliShot — 后台 Service Worker
 *
 * 职责：
 *  1. 响应内容脚本（Ins 键）或扩展快捷键的截图请求，调用 tabs.captureVisibleTab 抓取当前可见区域；
 *  2. 把最终图片写入系统剪贴板（通过 offscreen 文档）和/或保存到下载目录；
 *  3. 生成文件名、维护角标反馈。
 *
 * 注意：MV3 的 Service Worker 没有 DOM / 剪贴板，所以「写剪贴板」统一交给 offscreen.html。
 */
'use strict';

const DEFAULT_SETTINGS = {
  enabled: true,
  baseKey: 'Insert',
  defaultMode: 'view',            // view | video | region
  saveAction: 'clipboard',        // clipboard | download | both
  format: 'png',                  // png | jpeg
  jpegQuality: 0.92,
  downloadSubfolder: 'B站截图',
  filenameTemplate: 'bili_{date}_{time}',
  showPreview: true,
  previewSeconds: 6,
  skipWhenTyping: true
};

const OFFSCREEN_PATH = 'offscreen.html';
let offscreenCreating = null;
let badgeTimer = null;

/* ------------------------------------------------------------------ 设置 */

async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
}

/* --------------------------------------------------------------- 角标反馈 */

async function flashBadge(text, color) {
  try {
    await chrome.action.setBadgeBackgroundColor({ color });
    await chrome.action.setBadgeText({ text });
    if (badgeTimer) clearTimeout(badgeTimer);
    badgeTimer = setTimeout(() => {
      chrome.action.setBadgeText({ text: '' }).catch(() => {});
    }, 2000);
  } catch (_) {
    /* 角标失败不影响主流程 */
  }
}

/* ----------------------------------------------------------------- 截图 */

/**
 * 抓取当前窗口可见区域。优先使用「仅 options」重载形式，失败则依次退回其他签名。
 * 返回 data:image/png;base64,... 形式的 PNG。
 */
async function captureVisibleTab() {
  const attempts = [
    () => chrome.tabs.captureVisibleTab({ format: 'png' }),
    () => chrome.tabs.captureVisibleTab(undefined, { format: 'png' }),
    async () => {
      const win = await chrome.windows.getLastFocused();
      return chrome.tabs.captureVisibleTab(win.id, { format: 'png' });
    }
  ];

  let lastError = null;
  for (const attempt of attempts) {
    try {
      const dataUrl = await attempt();
      if (dataUrl) return dataUrl;
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(describeCaptureError(lastError));
}

function describeCaptureError(err) {
  const message = String((err && err.message) || err || '未知错误');
  if (/activeTab|<all_urls>|permission|权限/i.test(message)) {
    return `${message}（截图权限不足：请确认扩展有该站点的访问权限，或改用 Ctrl+Shift+X 触发一次）`;
  }
  if (/cannot be captured|chrome:\/\//i.test(message)) {
    return '当前页面不允许截图（浏览器内置页面 / 应用商店页面）';
  }
  return message;
}

/* ------------------------------------------------------- offscreen 文档 */

async function ensureOffscreenDocument() {
  if (chrome.offscreen && typeof chrome.offscreen.hasDocument === 'function') {
    if (await chrome.offscreen.hasDocument()) return;
  } else {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT']
    }).catch(() => []);
    if (contexts && contexts.length) return;
  }

  if (!offscreenCreating) {
    offscreenCreating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_PATH,
        reasons: ['CLIPBOARD'],
        justification: '把截图写入系统剪贴板，需要 DOM 与 Clipboard API'
      })
      .catch((err) => {
        // 已存在时 createDocument 会报错，视为成功
        if (!/single offscreen|Only a single offscreen/i.test(String(err))) throw err;
      })
      .finally(() => {
        offscreenCreating = null;
      });
  }
  await offscreenCreating;
}

async function askOffscreen(payload) {
  await ensureOffscreenDocument();
  const response = await chrome.runtime.sendMessage({ ...payload, target: 'offscreen' });
  if (!response || !response.ok) {
    throw new Error((response && response.error) || '剪贴板写入失败');
  }
  return response;
}

async function copyImageToClipboard(dataUrl) {
  await askOffscreen({ type: 'COPY_IMAGE', dataUrl });
}

/* ----------------------------------------------------------------- 下载 */

function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatDateTime(date) {
  return {
    date: `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`,
    time: `${pad2(date.getHours())}-${pad2(date.getMinutes())}-${pad2(date.getSeconds())}`,
    stamp: `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`
  };
}

/** 去掉 Windows / Chrome 下载路径里的非法字符 */
function sanitizeSegment(input, maxLength) {
  let text = String(input == null ? '' : input)
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .trim();
  if (!text) text = 'B站截图';
  const limit = maxLength || 60;
  if (text.length > limit) text = text.slice(0, limit).trim();
  return text;
}

function buildFilename(settings, meta) {
  const now = new Date();
  const { date, time, stamp } = formatDateTime(now);
  const tokens = {
    date,
    time,
    stamp,
    title: sanitizeSegment(meta && meta.title, 50),
    vt: sanitizeSegment((meta && meta.videoTime) || '00-00-00', 20),
    mode: sanitizeSegment(modeLabel(meta && meta.mode), 10),
    width: (meta && meta.width) || '',
    height: (meta && meta.height) || ''
  };

  const template = settings.filenameTemplate || DEFAULT_SETTINGS.filenameTemplate;
  let base = template.replace(/\{(\w+)\}/g, (match, key) => {
    const value = tokens[key];
    return value === undefined || value === '' ? match : String(value);
  });
  base = sanitizeSegment(base, 120);
  if (!/\.(png|jpe?g)$/i.test(base)) {
    base += settings.format === 'jpeg' ? '.jpg' : '.png';
  }

  const folder = sanitizeSegment(settings.downloadSubfolder, 40);
  return folder ? `${folder}/${base}` : base;
}

function modeLabel(mode) {
  if (mode === 'video') return '视频';
  if (mode === 'region') return '框选';
  return '可见区域';
}

async function downloadImage(dataUrl, filename) {
  try {
    return await chrome.downloads.download({
      url: dataUrl,
      filename,
      saveAs: false,
      conflictAction: 'uniquify'
    });
  } catch (err) {
    // 超大 data URL 可能被拒绝，改用 offscreen 生成的 blob URL
    const { url } = await askOffscreen({ type: 'CREATE_BLOB_URL', dataUrl });
    try {
      return await chrome.downloads.download({
        url,
        filename,
        saveAs: false,
        conflictAction: 'uniquify'
      });
    } finally {
      setTimeout(() => {
        chrome.runtime
          .sendMessage({ target: 'offscreen', type: 'REVOKE_BLOB_URL', url })
          .catch(() => {});
      }, 60 * 1000);
    }
  }
}

/* --------------------------------------------------------------- 交付流程 */

/**
 * @param {{dataUrl: string, meta?: object, action?: string}} payload
 */
async function deliver(payload) {
  const settings = await getSettings();
  const action = payload.action || settings.saveAction;
  const result = {
    ok: true,
    action,
    copied: false,
    downloaded: false,
    filename: '',
    warnings: []
  };

  if (!payload || !payload.dataUrl) {
    return { ...result, ok: false, error: '没有收到图片数据' };
  }

  const filename = buildFilename(settings, payload.meta || {});
  result.filename = filename;

  if (action === 'clipboard' || action === 'both') {
    try {
      await copyImageToClipboard(payload.dataUrl);
      result.copied = true;
    } catch (err) {
      result.warnings.push(`复制到剪贴板失败：${(err && err.message) || err}`);
    }
  }

  if (action === 'download' || action === 'both') {
    try {
      await downloadImage(payload.dataUrl, filename);
      result.downloaded = true;
    } catch (err) {
      result.warnings.push(`保存文件失败：${(err && err.message) || err}`);
    }
  }

  // 首选方式失败时兜底：至少把图存下来
  if (!result.copied && !result.downloaded && !action.includes('download')) {
    try {
      await downloadImage(payload.dataUrl, filename);
      result.downloaded = true;
      result.warnings.push('已改为保存到下载目录');
    } catch (err) {
      result.warnings.push(`保存文件失败：${(err && err.message) || err}`);
    }
  }

  if (!result.copied && !result.downloaded) {
    result.ok = false;
    result.error = result.warnings.join('；') || '截图处理失败';
    flashBadge('!', '#e5484d');
  } else {
    flashBadge('✓', '#00a1d6');
  }

  result.message = buildResultMessage(result);
  return result;
}

function buildResultMessage(result) {
  const parts = [];
  if (result.copied) parts.push('已复制到剪贴板');
  if (result.downloaded) parts.push(`已保存 ${result.filename}`);
  return parts.join(' · ');
}

/* --------------------------------------------------------------- 消息路由 */

async function handleMessage(message) {
  const type = message && message.type;
  switch (type) {
    case 'PING':
      return { ok: true, settings: await getSettings() };

    case 'CAPTURE_TAB': {
      const dataUrl = await captureVisibleTab();
      return { ok: true, dataUrl };
    }

    case 'DELIVER':
      return deliver(message);

    case 'GET_SETTINGS':
      return { ok: true, settings: await getSettings() };

    case 'SET_SETTINGS': {
      const patch = message.settings || {};
      await chrome.storage.sync.set(patch);
      return { ok: true, settings: await getSettings() };
    }

    default:
      return { ok: false, error: `未知的消息类型：${type}` };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 发给 offscreen 文档的消息不在这里处理
  if (message && message.target === 'offscreen') return false;

  handleMessage(message)
    .then((result) => sendResponse(result))
    .catch((err) => {
      const error = (err && err.message) || String(err);
      if (message && message.type === 'CAPTURE_TAB') flashBadge('!', '#e5484d');
      sendResponse({ ok: false, error });
    });

  return true; // 保持消息通道，异步响应
});

/* ------------------------------------------------------------ 快捷键命令 */

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'capture-page') return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const isBilibili = /^https?:\/\/([a-z0-9-]+\.)*bilibili\.com(\/|$)/i.test((tab && tab.url) || '');

    if (isBilibili && tab.id != null) {
      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'RUN_CAPTURE', mode: 'default' });
        return;
      } catch (_) {
        /* 页面脚本还没就绪，走通用流程 */
      }
    }

    const dataUrl = await captureVisibleTab();
    await deliver({
      dataUrl,
      meta: { title: (tab && tab.title) || '页面截图', mode: 'view' }
    });
  } catch (err) {
    flashBadge('!', '#e5484d');
    console.warn('[BiliShot] 快捷键截图失败：', err);
  }
});

/* --------------------------------------------------------------- 生命周期 */

chrome.runtime.onInstalled.addListener(async (details) => {
  await chrome.storage.sync.get(DEFAULT_SETTINGS).then((stored) => {
    chrome.storage.sync.set({ ...DEFAULT_SETTINGS, ...stored }).catch(() => {});
  });
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('options.html?first-run=1') }).catch(() => {});
  }
});
