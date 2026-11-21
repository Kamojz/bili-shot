// ==UserScript==
// @name         B站快捷截图 · BiliShot（油猴版）
// @namespace    https://www.bilibili.com/
// @version      1.0.0
// @description  在 B站 按 Insert 键一键截取当前视频画面：复制到剪贴板 / 保存为图片，支持拖拽框选并自动带上视频时间点。
// @author       BiliShot
// @match        *://*.bilibili.com/*
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// ==/UserScript==

/**
 * 快捷键
 *   Insert        截取当前视频画面（默认：复制到剪贴板 + 保存文件）
 *   Shift+Insert  只截视频画面（和 Insert 相同，方便你把它设成默认时仍有直截入口）
 *   Alt+Insert    在画面里拖拽框选一块区域
 *   Esc           取消框选
 *
 * 说明：油猴脚本运行在网页里，浏览器不给网页「截屏」权限，所以只能截 <video> 里的视频帧，
 *      截不了整页（含弹幕/评论/网页界面）。需要整页截图请用同目录里的 BiliShot 扩展。
 */
(() => {
  'use strict';

  if (window.__biliShotScriptLoaded) return;
  window.__biliShotScriptLoaded = true;

  const DEFAULTS = {
    baseKey: 'Insert',
    defaultMode: 'video', // video | region
    saveAction: 'both', // clipboard | download | both
    format: 'png', // png | jpeg
    jpegQuality: 0.92,
    showPreview: true,
    previewSeconds: 6,
    skipWhenTyping: true
  };

  /* ------------------------------------------------------------- 设置存储 */

  const store = {
    get(key, fallback) {
      try {
        if (typeof GM_getValue === 'function') {
          const value = GM_getValue(key, undefined);
          return value === undefined ? fallback : value;
        }
        const raw = localStorage.getItem(`bilishot.${key}`);
        return raw == null ? fallback : JSON.parse(raw);
      } catch (_) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        if (typeof GM_setValue === 'function') GM_setValue(key, value);
        else localStorage.setItem(`bilishot.${key}`, JSON.stringify(value));
      } catch (_) {}
    }
  };

  const settings = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) settings[key] = store.get(key, DEFAULTS[key]);

  let busy = false;
  let uiHost = null;
  let uiStack = null;
  let toastEl = null;
  let toastTimer = null;
  let previewEl = null;
  let previewTimer = null;
  let regionSession = null;
  let fullscreenHooked = false;
  const menuIds = [];

  /* ------------------------------------------------------------------ 样式 */

  const STYLE = `
    :host { all: initial; }
    .bs-stack {
      position: fixed; inset: 0; z-index: 2147483600; pointer-events: none;
      font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
      font-size: 13px; line-height: 1.5; color: #fff;
    }
    .bs-toast {
      position: fixed; left: 50%; bottom: 28px; transform: translate(-50%, 8px);
      max-width: 70vw; padding: 10px 16px; border-radius: 999px;
      background: rgba(18, 20, 24, .92); border: 1px solid rgba(255,255,255,.14);
      box-shadow: 0 8px 28px rgba(0,0,0,.42); backdrop-filter: blur(6px);
      opacity: 0; transition: opacity .18s ease, transform .18s ease;
      pointer-events: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .bs-toast--in { opacity: 1; transform: translate(-50%, 0); }
    .bs-toast--success { border-color: rgba(0, 174, 236, .65); }
    .bs-toast--warn { border-color: rgba(245, 165, 36, .7); }
    .bs-toast--error { border-color: rgba(229, 72, 77, .8); background: rgba(120, 24, 28, .94); }

    .bs-preview {
      position: fixed; right: 20px; bottom: 20px; width: 244px;
      background: #16181d; border: 1px solid rgba(255,255,255,.12);
      border-radius: 12px; overflow: hidden; pointer-events: auto;
      box-shadow: 0 14px 40px rgba(0,0,0,.5); animation: bs-pop .18s ease-out;
    }
    @keyframes bs-pop { from { opacity: 0; transform: translateY(10px) scale(.98); } to { opacity: 1; transform: none; } }
    .bs-preview img { display: block; width: 100%; max-height: 148px; object-fit: contain; background: #000; cursor: zoom-in; }
    .bs-preview__meta { padding: 7px 10px 0; color: #9aa4b2; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bs-preview__note { padding: 2px 10px 0; color: #00c3ff; font-size: 11px; }
    .bs-preview__actions { display: flex; gap: 6px; padding: 8px 10px 10px; }
    .bs-btn {
      flex: 1; appearance: none; border: 1px solid rgba(255,255,255,.14);
      background: rgba(255,255,255,.06); color: #e8eaed; font: inherit; font-size: 12px;
      padding: 5px 0; border-radius: 7px; cursor: pointer; transition: background .15s, border-color .15s;
    }
    .bs-btn:hover { background: rgba(0, 174, 236, .18); border-color: rgba(0, 174, 236, .6); }
    .bs-btn--primary { background: rgba(0, 174, 236, .22); border-color: rgba(0, 174, 236, .65); }
    .bs-btn--ghost { flex: 0 0 34px; }

    .bs-region { position: fixed; cursor: crosshair; user-select: none; pointer-events: auto; }
    .bs-region__bg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: fill; pointer-events: none; -webkit-user-drag: none; }
    .bs-region__box {
      position: absolute; display: none; pointer-events: none;
      border: 2px solid #00a1d6; box-shadow: 0 0 0 100vmax rgba(0,0,0,.55);
    }
    .bs-region__size {
      position: absolute; left: 0; top: -24px; padding: 2px 7px; border-radius: 5px;
      background: #00a1d6; color: #fff; font-size: 11px; white-space: nowrap;
    }
    .bs-region__hint {
      position: fixed; top: 20px; left: 50%; transform: translateX(-50%);
      padding: 8px 16px; border-radius: 8px; background: rgba(12, 14, 18, .88);
      border: 1px solid rgba(255,255,255,.14); pointer-events: none; white-space: nowrap;
    }
    .bs-region__actions {
      position: fixed; display: flex; gap: 6px; padding: 6px;
      border-radius: 9px; background: rgba(12, 14, 18, .92);
      border: 1px solid rgba(255,255,255,.16); pointer-events: auto;
      box-shadow: 0 10px 26px rgba(0,0,0,.45);
    }
    .bs-region__actions .bs-btn { padding: 5px 12px; flex: 0 0 auto; }
  `;

  /* --------------------------------------------------------------- 初始化 */

  init();

  function init() {
    window.addEventListener('keydown', onKeyDown, true);
    registerMenus();
  }

  function registerMenus() {
    if (typeof GM_registerMenuCommand !== 'function') return;
    if (menuIds.length && typeof GM_unregisterMenuCommand === 'function') {
      for (const id of menuIds) {
        try {
          GM_unregisterMenuCommand(id);
        } catch (_) {}
      }
      menuIds.length = 0;
    }

    menuIds.push(
      GM_registerMenuCommand(`截图后：${saveActionLabel()}（点击切换）`, () => {
        settings.saveAction = nextOf(['clipboard', 'download', 'both'], settings.saveAction);
        store.set('saveAction', settings.saveAction);
        registerMenus();
        showToast(`截图后：${saveActionLabel()}`, 'success');
      })
    );
    menuIds.push(
      GM_registerMenuCommand(`图片格式：${settings.format.toUpperCase()}（点击切换）`, () => {
        settings.format = settings.format === 'png' ? 'jpeg' : 'png';
        store.set('format', settings.format);
        registerMenus();
        showToast(`图片格式：${settings.format.toUpperCase()}`, 'success');
      })
    );
    menuIds.push(
      GM_registerMenuCommand(`Insert 默认：${settings.defaultMode === 'region' ? '框选' : '整帧'}（点击切换）`, () => {
        settings.defaultMode = settings.defaultMode === 'region' ? 'video' : 'region';
        store.set('defaultMode', settings.defaultMode);
        registerMenus();
        showToast(`Insert 默认：${settings.defaultMode === 'region' ? '框选画面' : '整帧画面'}`, 'success');
      })
    );
    menuIds.push(
      GM_registerMenuCommand(`预览卡片：${settings.showPreview ? '开' : '关'}（点击切换）`, () => {
        settings.showPreview = !settings.showPreview;
        store.set('showPreview', settings.showPreview);
        registerMenus();
      })
    );
    menuIds.push(
      GM_registerMenuCommand('快捷键说明', () => {
        alert(
          'B站快捷截图（油猴版）\n\n' +
            'Insert       截取当前视频画面\n' +
            'Shift+Insert 同上（整帧）\n' +
            'Alt+Insert   拖拽框选一块区域，Enter 确认，Esc 取消\n\n' +
            '截图后：' +
            saveActionLabel() +
            '\n\n提示：油猴脚本只能截视频画面，截不了整页（含弹幕和网页界面）。\n需要整页截图请装同目录下的 BiliShot 扩展。'
        );
      })
    );
    menuIds.push(
      GM_registerMenuCommand('恢复默认设置', () => {
        Object.assign(settings, DEFAULTS);
        for (const key of Object.keys(DEFAULTS)) store.set(key, DEFAULTS[key]);
        registerMenus();
        showToast('已恢复默认设置', 'success');
      })
    );
  }

  function nextOf(list, current) {
    const index = list.indexOf(current);
    return list[(index + 1) % list.length];
  }

  function saveActionLabel() {
    if (settings.saveAction === 'clipboard') return '复制到剪贴板';
    if (settings.saveAction === 'download') return '保存为图片';
    return '复制 + 保存';
  }

  /* --------------------------------------------------------------- 按键处理 */

  function onKeyDown(event) {
    if (event.repeat || event.isComposing) return;
    if (event.ctrlKey || event.metaKey) return;
    if ((event.code || event.key) !== settings.baseKey) return;
    if (settings.skipWhenTyping && isTypingTarget(event.target)) return;

    const mode = event.altKey ? 'region' : event.shiftKey ? 'video' : settings.defaultMode;

    event.preventDefault();
    if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
    event.stopPropagation();

    capture(mode);
  }

  function isTypingTarget(target) {
    if (!target || target.nodeType !== 1) return false;
    const tag = target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (target.isContentEditable) return true;
    return !!(
      target.closest &&
      target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]')
    );
  }

  /* ------------------------------------------------------------- 截图主流程 */

  async function capture(mode) {
    if (busy) return;
    if (regionSession) {
      showToast('正在框选，先按 Esc 取消', 'warn');
      return;
    }

    busy = true;
    try {
      const video = findVideo();
      if (!video) throw new Error('没有找到视频画面：请先打开一个视频播放页');

      const frame = grabFrame(video); // 画到 canvas 上，失败会抛
      const meta = {
        title: pageTitle(),
        videoTime: videoTimestamp(video),
        width: frame.width,
        height: frame.height
      };

      let canvas = frame;
      if (mode === 'region') {
        const cropped = await pickRegion(frame, video);
        if (!cropped) return; // 用户取消
        canvas = cropped;
        meta.width = canvas.width;
        meta.height = canvas.height;
      }

      await deliver(canvas, meta);
    } catch (err) {
      showToast(String((err && err.message) || err), 'error');
      console.warn('[BiliShot] 截图失败：', err);
    } finally {
      busy = false;
    }
  }

  /** 找到页面上最可能是「当前正在看的」那个 video */
  function findVideo() {
    const videos = Array.from(document.querySelectorAll('video')).filter((v) => v.videoWidth > 0);
    if (!videos.length) return null;

    const area = (v) => {
      const rect = v.getBoundingClientRect();
      const visibleWidth = Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0));
      const visibleHeight = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
      return visibleWidth * visibleHeight;
    };

    return videos.sort((a, b) => {
      const playingDiff = Number(!b.paused && !b.ended) - Number(!a.paused && !a.ended);
      if (playingDiff) return playingDiff;
      return area(b) - area(a);
    })[0];
  }

  /** 把当前帧画到 canvas（MSE / blob 流的同源视频可以正常画） */
  function grabFrame(video) {
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) throw new Error('视频还没准备好（画面尺寸为 0），稍等一秒再试');

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: false });
    try {
      ctx.drawImage(video, 0, 0, width, height);
    } catch (err) {
      throw new Error('浏览器拒绝了这帧画面（跨域保护），换个视频或改用 BiliShot 扩展试试');
    }
    return canvas;
  }

  /** 视频实际显示区域（去掉 object-fit 产生的黑边） */
  function renderedVideoRect(video) {
    const rect = video.getBoundingClientRect();
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh || rect.width <= 0 || rect.height <= 0) return rect;

    const elementAspect = rect.width / rect.height;
    const videoAspect = vw / vh;
    let width = rect.width;
    let height = rect.height;
    let left = rect.left;
    let top = rect.top;

    if (videoAspect > elementAspect) {
      height = rect.width / videoAspect;
      top = rect.top + (rect.height - height) / 2;
    } else if (videoAspect < elementAspect) {
      width = rect.height * videoAspect;
      left = rect.left + (rect.width - width) / 2;
    }
    return { left, top, width, height };
  }

  /* --------------------------------------------------------------- 交付图片 */

  async function deliver(canvas, meta) {
    const fileName = buildFileName(meta);
    const parts = [];
    const warnings = [];

    if (settings.saveAction === 'clipboard' || settings.saveAction === 'both') {
      try {
        await copyCanvasToClipboard(canvas);
        parts.push('已复制到剪贴板');
      } catch (err) {
        warnings.push(`复制失败：${(err && err.message) || err}`);
      }
    }

    if (settings.saveAction === 'download' || settings.saveAction === 'both') {
      try {
        const blob = await canvasToBlob(canvas, settings.format, settings.jpegQuality);
        downloadBlob(blob, fileName);
        parts.push(`已保存 ${fileName}`);
      } catch (err) {
        warnings.push(`保存失败：${(err && err.message) || err}`);
      }
    }

    if (!parts.length && settings.saveAction !== 'download') {
      // 剪贴板失败时兜底存文件，别让用户白截
      try {
        const blob = await canvasToBlob(canvas, settings.format, settings.jpegQuality);
        downloadBlob(blob, fileName);
        parts.push(`已保存 ${fileName}`);
      } catch (err) {
        warnings.push(`保存失败：${(err && err.message) || err}`);
      }
    }

    const ok = parts.length > 0;
    showToast(ok ? parts.join(' · ') : warnings.join(' · ') || '截图失败', ok ? 'success' : 'error');

    if (ok && settings.showPreview) {
      showPreview(canvas, { ...meta, note: parts.join(' · '), fileName });
    }
    if (!ok) console.warn('[BiliShot] 交付失败：', warnings);
  }

  function canvasToBlob(canvas, format, quality) {
    const isJpeg = format === 'jpeg';
    let target = canvas;

    if (isJpeg) {
      // JPEG 没有透明通道，先垫一层白底
      target = document.createElement('canvas');
      target.width = canvas.width;
      target.height = canvas.height;
      const ctx = target.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, target.width, target.height);
      ctx.drawImage(canvas, 0, 0);
    }

    return new Promise((resolve, reject) => {
      target.toBlob(
        (blob) => {
          if (blob) resolve(blob);
          else reject(new Error('图片编码失败（画面可能过大）'));
        },
        isJpeg ? 'image/jpeg' : 'image/png',
        isJpeg ? Math.min(1, Math.max(0.4, Number(quality) || 0.92)) : undefined
      );
    });
  }

  async function copyCanvasToClipboard(canvas) {
    const blob = await canvasToBlob(canvas, 'png');
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard && navigator.clipboard.write) {
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        return;
      } catch (_) {
        /* 落到 execCommand 兜底 */
      }
    }
    legacyCopyImage(blob);
  }

  function legacyCopyImage(blob) {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    const container = document.createElement('div');
    container.contentEditable = 'true';
    container.style.cssText = 'position:fixed;left:-99999px;top:0;opacity:0;';

    try {
      image.src = url;
      container.appendChild(image);
      document.body.appendChild(container);

      const range = document.createRange();
      range.selectNodeContents(container);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);

      const ok = document.execCommand('copy');
      selection.removeAllRanges();
      if (!ok) throw new Error('浏览器拒绝写入剪贴板，可改用「保存」按钮');
    } finally {
      container.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
  }

  function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  /* ------------------------------------------------------------- 命名与时间 */

  function sanitize(text, maxLength) {
    const clean = String(text || '')
      .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[.\s]+|[.\s]+$/g, '')
      .trim();
    return (clean || 'B站画面').slice(0, maxLength || 60);
  }

  function buildFileName(meta) {
    const title = sanitize(meta.title, 50);
    const stamp = meta.videoTime ? `_${meta.videoTime}` : '';
    const ext = settings.format === 'jpeg' ? 'jpg' : 'png';
    return `${title}${stamp}.${ext}`;
  }

  function pageTitle() {
    const raw = document.title || '';
    const cleaned = raw
      .replace(/[_\-—|·]\s*哔哩哔哩.*$/i, '')
      .replace(/_bilibili.*$/i, '')
      .replace(/^哔哩哔哩\s*[_\-—|·]*\s*/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    return cleaned || 'B站画面';
  }

  function videoTimestamp(video) {
    if (!video || !isFinite(video.currentTime)) return '';
    const total = Math.max(0, Math.floor(video.currentTime));
    const pad = (n) => String(n).padStart(2, '0');
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    return hours > 0 ? `${pad(hours)}-${pad(minutes)}-${pad(seconds)}` : `${pad(minutes)}-${pad(seconds)}`;
  }

  /* ----------------------------------------------------------------- 框选 */

  function pickRegion(frame, video) {
    return new Promise((resolve) => {
      const stack = ensureUI();
      const rect = renderedVideoRect(video);
      const scaleX = frame.width / Math.max(1, rect.width);
      const scaleY = frame.height / Math.max(1, rect.height);

      const layer = document.createElement('div');
      layer.className = 'bs-region';
      layer.style.left = `${rect.left}px`;
      layer.style.top = `${rect.top}px`;
      layer.style.width = `${rect.width}px`;
      layer.style.height = `${rect.height}px`;

      const background = document.createElement('img');
      background.className = 'bs-region__bg';
      background.src = frame.toDataURL('image/png');
      background.alt = '';

      const box = document.createElement('div');
      box.className = 'bs-region__box';
      const sizeTag = document.createElement('div');
      sizeTag.className = 'bs-region__size';
      box.appendChild(sizeTag);

      const hint = document.createElement('div');
      hint.className = 'bs-region__hint';
      hint.textContent = '在画面上拖拽框选 · Enter 确认 · Esc 取消';

      layer.append(background, box, hint);
      stack.appendChild(layer);

      let start = null;
      let current = null;
      let dragging = false;
      let actionBar = null;

      const localPoint = (event) => ({
        x: Math.min(Math.max(event.clientX - rect.left, 0), rect.width),
        y: Math.min(Math.max(event.clientY - rect.top, 0), rect.height)
      });

      const selection = () => {
        if (!start || !current) return null;
        const left = Math.min(start.x, current.x);
        const top = Math.min(start.y, current.y);
        const right = Math.max(start.x, current.x);
        const bottom = Math.max(start.y, current.y);
        return { left, top, width: right - left, height: bottom - top };
      };

      const done = (value) => {
        cleanup();
        resolve(value);
      };

      const cleanup = () => {
        dragging = false;
        layer.remove();
        if (actionBar) actionBar.remove();
        window.removeEventListener('keydown', onKey, true);
        window.removeEventListener('pointermove', onMove, true);
        window.removeEventListener('pointerup', onUp, true);
        regionSession = null;
      };

      const paint = () => {
        const sel = selection();
        if (!sel || sel.width < 1 || sel.height < 1) {
          box.style.display = 'none';
          return;
        }
        box.style.display = 'block';
        box.style.left = `${sel.left}px`;
        box.style.top = `${sel.top}px`;
        box.style.width = `${sel.width}px`;
        box.style.height = `${sel.height}px`;
        sizeTag.textContent = `${Math.round(sel.width * scaleX)} × ${Math.round(sel.height * scaleY)}`;
        sizeTag.style.top = sel.top < 26 ? 'auto' : '-24px';
        sizeTag.style.bottom = sel.top < 26 ? '-24px' : 'auto';
      };

      const crop = (sel) => {
        const sx = Math.max(0, Math.round(sel.left * scaleX));
        const sy = Math.max(0, Math.round(sel.top * scaleY));
        const sw = Math.max(1, Math.min(frame.width - sx, Math.round(sel.width * scaleX)));
        const sh = Math.max(1, Math.min(frame.height - sy, Math.round(sel.height * scaleY)));
        const canvas = document.createElement('canvas');
        canvas.width = sw;
        canvas.height = sh;
        canvas.getContext('2d').drawImage(frame, sx, sy, sw, sh, 0, 0, sw, sh);
        return canvas;
      };

      const showActions = () => {
        if (actionBar) actionBar.remove();
        const sel = selection();
        if (!sel) return;

        actionBar = document.createElement('div');
        actionBar.className = 'bs-region__actions';

        const confirm = document.createElement('button');
        confirm.className = 'bs-btn bs-btn--primary';
        confirm.textContent = '✓ 截取 (Enter)';
        confirm.addEventListener('click', () => {
          const sel2 = selection();
          if (sel2 && sel2.width >= 4 && sel2.height >= 4) done(crop(sel2));
        });

        const reset = document.createElement('button');
        reset.className = 'bs-btn';
        reset.textContent = '重选';
        reset.addEventListener('click', () => {
          actionBar.remove();
          actionBar = null;
          start = current = null;
          box.style.display = 'none';
          hint.style.display = '';
        });

        const cancel = document.createElement('button');
        cancel.className = 'bs-btn bs-btn--ghost';
        cancel.textContent = '✕';
        cancel.title = '取消 (Esc)';
        cancel.addEventListener('click', () => done(null));

        actionBar.append(confirm, reset, cancel);
        const barLeft = clamp(rect.left + sel.left, 12, Math.max(12, window.innerWidth - 260));
        const barTop = clamp(rect.top + sel.top + sel.height + 10, 12, Math.max(12, window.innerHeight - 56));
        actionBar.style.left = `${barLeft}px`;
        actionBar.style.top = `${barTop}px`;
        stack.appendChild(actionBar);
      };

      const onDown = (event) => {
        if (event.button !== 0) return;
        if (actionBar && actionBar.contains(event.target)) return;
        dragging = true;
        start = localPoint(event);
        current = { ...start };
        hint.style.display = 'none';
        if (actionBar) {
          actionBar.remove();
          actionBar = null;
        }
        paint();
        event.preventDefault();
      };

      const onMove = (event) => {
        if (!dragging) return;
        current = localPoint(event);
        paint();
      };

      const onUp = (event) => {
        if (!dragging) return;
        dragging = false;
        current = localPoint(event);
        paint();
        const sel = selection();
        if (!sel || sel.width < 4 || sel.height < 4) {
          start = current = null;
          box.style.display = 'none';
          hint.style.display = '';
          return;
        }
        showActions();
      };

      const onKey = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          done(null);
          return;
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          event.stopPropagation();
          const sel = selection();
          if (sel && sel.width >= 4 && sel.height >= 4) done(crop(sel));
        }
      };

      layer.addEventListener('pointerdown', onDown);
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
      window.addEventListener('keydown', onKey, true);

      regionSession = { cancel: () => done(null) };
    });
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  /* ------------------------------------------------------------------- UI */

  function ensureUI() {
    if (uiHost && uiHost.isConnected && uiStack) {
      ensureHostPlacement();
      return uiStack;
    }

    uiHost = document.createElement('div');
    uiHost.id = '__bili_shot_script_host__';
    uiHost.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;overflow:visible;';

    const root = uiHost.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    uiStack = document.createElement('div');
    uiStack.className = 'bs-stack';
    root.append(style, uiStack);

    ensureHostPlacement();
    if (!fullscreenHooked) {
      fullscreenHooked = true;
      document.addEventListener('fullscreenchange', ensureHostPlacement, true);
    }
    return uiStack;
  }

  function ensureHostPlacement() {
    if (!uiHost) return;
    const target = document.fullscreenElement || document.documentElement || document.body;
    if (target && uiHost.parentNode !== target) target.appendChild(uiHost);
  }

  function showToast(text, kind) {
    const stack = ensureUI();
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
    if (!toastEl) {
      toastEl = document.createElement('div');
      stack.appendChild(toastEl);
    }
    toastEl.className = `bs-toast bs-toast--${kind || 'info'}`;
    toastEl.textContent = text;
    requestAnimationFrame(() => toastEl && toastEl.classList.add('bs-toast--in'));
    toastTimer = setTimeout(() => {
      if (!toastEl) return;
      toastEl.classList.remove('bs-toast--in');
      const node = toastEl;
      toastEl = null;
      setTimeout(() => node.remove(), 240);
    }, 2600);
  }

  function showPreview(canvas, info) {
    const stack = ensureUI();
    if (previewTimer) {
      clearTimeout(previewTimer);
      previewTimer = null;
    }
    if (previewEl) {
      previewEl.remove();
      previewEl = null;
    }

    const card = document.createElement('div');
    card.className = 'bs-preview';

    const image = document.createElement('img');
    image.alt = '截图预览';
    image.title = '点击复制到剪贴板';
    // 缩略图用较小的 JPEG，避免大图占用内存
    const thumb = document.createElement('canvas');
    const scale = Math.min(1, 480 / Math.max(canvas.width, canvas.height));
    thumb.width = Math.max(1, Math.round(canvas.width * scale));
    thumb.height = Math.max(1, Math.round(canvas.height * scale));
    thumb.getContext('2d').drawImage(canvas, 0, 0, thumb.width, thumb.height);
    image.src = thumb.toDataURL('image/jpeg', 0.8);

    const meta = document.createElement('div');
    meta.className = 'bs-preview__meta';
    meta.textContent = `${info.width} × ${info.height}${info.videoTime ? ` · 视频 ${info.videoTime}` : ''}`;

    const note = document.createElement('div');
    note.className = 'bs-preview__note';
    note.textContent = info.note || '';

    const actions = document.createElement('div');
    actions.className = 'bs-preview__actions';

    const button = (label, className, handler) => {
      const btn = document.createElement('button');
      btn.className = className;
      btn.textContent = label;
      btn.addEventListener('click', handler);
      return btn;
    };

    const copyBtn = button('复制', 'bs-btn bs-btn--primary', async () => {
      try {
        await copyCanvasToClipboard(canvas);
        showToast('已复制到剪贴板', 'success');
      } catch (err) {
        showToast(`复制失败：${(err && err.message) || err}`, 'error');
      }
    });
    const saveBtn = button('保存', 'bs-btn', async () => {
      try {
        const blob = await canvasToBlob(canvas, settings.format, settings.jpegQuality);
        downloadBlob(blob, info.fileName || buildFileName(info));
        showToast('已保存', 'success');
      } catch (err) {
        showToast(`保存失败：${(err && err.message) || err}`, 'error');
      }
    });
    const closeBtn = button('✕', 'bs-btn bs-btn--ghost', () => {
      card.remove();
      if (previewEl === card) previewEl = null;
    });

    image.addEventListener('click', () => copyBtn.click());
    actions.append(copyBtn, saveBtn, closeBtn);
    card.append(image, meta, note, actions);
    stack.appendChild(card);
    previewEl = card;

    const seconds = Number(settings.previewSeconds) || 0;
    if (seconds > 0) {
      previewTimer = setTimeout(() => {
        card.remove();
        if (previewEl === card) previewEl = null;
      }, seconds * 1000);
    }
  }
})();
