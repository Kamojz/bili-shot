/**
 * BiliShot — offscreen 文档脚本
 *
 * Service Worker 里没有 DOM / Clipboard API，所以把「图片写入剪贴板」这一步
 * 交给这个隐藏文档完成：先尝试标准 Clipboard API，失败再退回 execCommand('copy')。
 */
'use strict';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== 'offscreen') return false;

  (async () => {
    try {
      switch (message.type) {
        case 'COPY_IMAGE': {
          const method = await copyImage(message.dataUrl);
          sendResponse({ ok: true, method });
          break;
        }
        case 'CREATE_BLOB_URL': {
          const blob = await dataUrlToBlob(message.dataUrl);
          sendResponse({ ok: true, url: URL.createObjectURL(blob) });
          break;
        }
        case 'REVOKE_BLOB_URL': {
          if (message.url) URL.revokeObjectURL(message.url);
          sendResponse({ ok: true });
          break;
        }
        default:
          sendResponse({ ok: false, error: `未知的 offscreen 消息：${message.type}` });
      }
    } catch (err) {
      sendResponse({ ok: false, error: (err && err.message) || String(err) });
    }
  })();

  return true;
});

/* --------------------------------------------------------------- 内部实现 */

function dataUrlToBlob(dataUrl) {
  return fetch(dataUrl).then((response) => response.blob());
}

/** 统一转成 PNG Blob：Chrome 的剪贴板基本只接受 image/png */
async function toPngBlob(dataUrl) {
  const sourceBlob = await dataUrlToBlob(dataUrl);
  if (sourceBlob.type === 'image/png') return sourceBlob;

  const bitmap = await createImageBitmap(sourceBlob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  if (bitmap.close) bitmap.close();

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('PNG 编码失败'));
    }, 'image/png');
  });
}

async function copyImage(dataUrl) {
  const pngBlob = await toPngBlob(dataUrl);

  // 首选：标准异步剪贴板
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard && navigator.clipboard.write) {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
      return 'clipboard-api';
    } catch (err) {
      console.warn('[BiliShot] Clipboard API 写入失败，尝试 execCommand 兜底：', err);
    }
  }

  // 兜底：选中图片后执行 copy 命令
  await legacyCopyImage(pngBlob);
  return 'execCommand';
}

function legacyCopyImage(blob) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(blob);
    const image = new Image();

    const cleanup = () => {
      URL.revokeObjectURL(objectUrl);
      const selection = window.getSelection();
      if (selection) selection.removeAllRanges();
    };

    image.onload = () => {
      try {
        const container = document.createElement('div');
        container.contentEditable = 'true';
        container.style.cssText = 'position:fixed;left:-99999px;top:0;opacity:0;';
        container.appendChild(image);
        document.body.appendChild(container);

        const range = document.createRange();
        range.selectNodeContents(container);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);

        const ok = document.execCommand('copy');
        container.remove();
        cleanup();
        ok ? resolve() : reject(new Error('浏览器拒绝写入剪贴板（execCommand 返回 false）'));
      } catch (err) {
        cleanup();
        reject(err);
      }
    };

    image.onerror = () => {
      cleanup();
      reject(new Error('图片解码失败，无法写入剪贴板'));
    };

    image.src = objectUrl;
  });
}
