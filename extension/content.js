/**
 * B站快捷截图 · BiliShot — 内容脚本（只在 bilibili.com 注入）
 *
 * 快捷键：
 *   Insert        默认模式（设置里可选：整页可见区域 / 仅视频画面 / 框选区域）
 *   Shift+Insert  仅视频画面
 *   Alt+Insert    框选区域
 *   Esc           取消框选
 *
 * 流程：截取可见区域 → 按模式裁剪 → 交给后台写入剪贴板 / 保存文件。
 * 所有界面都放在 Shadow DOM 里，避免和 B站 的样式互相污染。
 */
'use strict';

(() => {
  if (window.__biliShotLoaded) return;
  window.__biliShotLoaded = true;

  const DEFAULT_SETTINGS = {
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

  const STYLE = `
    :host { all: initial; }
    .bs-stack {
      position: fixed; inset: 0; z-index: 2147483600;
      pointer-events: none;
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
      box-shadow: 0 14px 40px rgba(0,0,0,.5);
      animation: bs-pop .18s ease-out;
    }
    @keyframes bs-pop { from { opacity: 0; transform: translateY(10px) scale(.98); } to { opacity: 1; transform: none; } }
    .bs-preview img {
      display: block; width: 100%; max-height: 148px; object-fit: contain;
      background: #000; cursor: zoom-in;
    }
    .bs-preview__meta {
      padding: 7px 10px 0; color: #9aa4b2; font-size: 11px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
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

    .bs-region { position: fixed; inset: 0; cursor: crosshair; user-select: none; pointer-events: auto; }
    .bs-region__bg {
      position: absolute; inset: 0; width: 100%; height: 100%;
      object-fit: fill; pointer-events: none; -webkit-user-drag: none;
    }
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

  let settings = { ...DEFAULT_SETTINGS };
  let busy = false;
  let uiHost = null;
  let uiStack = null;
  let toastEl = null;
  let toastTimer = null;
  let previewEl = null;
  let previewTimer = null;
  let activeRegionPicker = null;
  let fullscreenHooked = false;

  /* ------------------------------------------------------------ 初始化 */

  init();

  async function init() {
    await loadSettings();
    chrome.storage.onChanged.addListener(onStorageChanged);
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
    window.addEventListener('keydown', onKeyDown, true);
    // 可观测标记：便于排查「脚本有没有注入成功」
    try {
      document.documentElement.setAttribute('data-bili-shot', 'ready');
    } catch (_) {}
  }

  async function loadSettings() {
    try {
      const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
      settings = { ...DEFAULT_SETTINGS, ...stored };
    } catch (_) {
      settings = { ...DEFAULT_SETTINGS };
    }
  }

  function onStorageChanged(changes, area) {
    if (area !== 'sync') return;
    for (const key of Object.keys(changes)) {
      settings[key] = changes[key].newValue;
    }
  }

  function onRuntimeMessage(message, sender, sendResponse) {
    if (message && message.type === 'RUN_CAPTURE') {
      sendResponse({ ok: true });
      if (message.mode && message.mode !== 'default') runCapture(message.mode);
      else runCapture(settings.defaultMode);
      return false;
    }
    return false;
  }

  /* ------------------------------------------------------------ 按键处理 */

  function onKeyDown(event) {
    if (!settings.enabled) return;
    if (event.repeat || event.isComposing) return;
    if (event.ctrlKey || event.metaKey) return; // 不抢 Ctrl+Insert / Cmd 组合
    if (keyOf(event) !== settings.baseKey) return;
    if (settings.skipWhenTyping && isTypingTarget(event.target)) return;

    const mode = event.shiftKey ? 'video' : event.altKey ? 'region' : settings.defaultMode;

    event.preventDefault();
    if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
    event.stopPropagation();

    runCapture(mode);
  }

  function keyOf(event) {
    return event.code || event.key || '';
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

  /* ------------------------------------------------------------ 截图主流程 */

  async function runCapture(mode) {
    if (busy) return;
    if (!['view', 'video', 'region'].includes(mode)) mode = settings.defaultMode;

    busy = true;
    try {
      clearTransientUI(); // 别把自己的提示框拍进画面
      await settle();

      const shot = await sendMessage({ type: 'CAPTURE_TAB' });
      if (!shot || !shot.ok) throw new Error((shot && shot.error) || '截图失败');

      const image = await loadImage(shot.dataUrl);
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth || image.naturalWidth;
      const scale = image.naturalWidth / (viewportWidth || 1);

      let rect = null;
      if (mode === 'video') {
        rect = getVideoRect();
        if (!rect) {
          showToast('没有检测到视频画面，已改为整页截图', 'warn');
          mode = 'view';
        }
      } else if (mode === 'region') {
        rect = await pickRegion(image);
        if (!rect) return; // 用户取消
      }

      const encoded = await encodeImage(image, rect, scale);
      const meta = {
        title: pageTitle(),
        videoTime: videoTimestamp(),
        mode,
        width: encoded.width,
        height: encoded.height,
        pageUrl: location.href
      };

      const result = await sendMessage({ type: 'DELIVER', dataUrl: encoded.dataUrl, meta });
      if (!result || !result.ok) throw new Error((result && result.error) || '保存失败');

      showToast(result.message || '截图完成', 'success');
      if (settings.showPreview) {
        showPreview(encoded.dataUrl, {
          width: encoded.width,
          height: encoded.height,
          note: result.message,
          meta
        });
      }
    } catch (err) {
      const message = String((err && err.message) || err);
      const friendly = /Extension context invalidated|Receiving end does not exist/i.test(message)
        ? '扩展已更新，请刷新本页面后重试'
        : message;
      showToast(friendly, 'error');
      console.warn('[BiliShot] 截图失败：', err);
    } finally {
      busy = false;
    }
  }

  /** 等待两帧 + 一点时间，确保我们自己的 UI 已经从画面上消失 */
  function settle() {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        setTimeout(resolve, 80);
      };
      const timer = setTimeout(finish, 400);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          clearTimeout(timer);
          finish();
        });
      });
    });
  }

  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => (image.decode ? image.decode().catch(() => {}).then(() => resolve(image)) : resolve(image));
      image.onerror = () => reject(new Error('截图数据解码失败'));
      image.src = dataUrl;
    });
  }

  /** 把（可选的）选区从整张截图里裁出来，按设置编码 */
  async function encodeImage(image, rect, scale) {
    const isJpeg = settings.format === 'jpeg';
    const mime = isJpeg ? 'image/jpeg' : 'image/png';
    const quality = isJpeg ? clamp(Number(settings.jpegQuality) || 0.92, 0.4, 1) : undefined;

    if (!rect && !isJpeg) {
      // 整页 PNG：直接用原始数据，零损失、更快
      return { dataUrl: image.src, width: image.naturalWidth, height: image.naturalHeight };
    }

    const viewport = {
      left: 0,
      top: 0,
      width: window.innerWidth || document.documentElement.clientWidth || image.naturalWidth,
      height: window.innerHeight || document.documentElement.clientHeight || image.naturalHeight
    };
    const source = rect || viewport;

    const sx = clamp(Math.round(source.left * scale), 0, image.naturalWidth - 1);
    const sy = clamp(Math.round(source.top * scale), 0, image.naturalHeight - 1);
    const sw = clamp(Math.round(source.width * scale), 1, image.naturalWidth - sx);
    const sh = clamp(Math.round(source.height * scale), 1, image.naturalHeight - sy);

    const canvas = document.createElement('canvas');
    canvas.width = sw;
    canvas.height = sh;
    const ctx = canvas.getContext('2d');
    if (isJpeg) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, sw, sh);
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);

    return { dataUrl: canvas.toDataURL(mime, quality), width: sw, height: sh };
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  /* ------------------------------------------------------------ 视频区域 */

  function getVideoRect() {
    const videos = Array.from(document.querySelectorAll('video'));
    let best = null;
    for (const video of videos) {
      const rect = video.getBoundingClientRect();
      if (rect.width < 40 || rect.height < 40) continue;
      const visibleWidth = Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0);
      const visibleHeight = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
      if (visibleWidth < 40 || visibleHeight < 40) continue;
      const area = visibleWidth * visibleHeight;
      if (!best || area > best.area) {
        best = {
          area,
          left: Math.max(rect.left, 0),
          top: Math.max(rect.top, 0),
          width: visibleWidth,
          height: visibleHeight
        };
      }
    }
    return best ? { left: best.left, top: best.top, width: best.width, height: best.height } : null;
  }

  function activeVideo() {
    const videos = Array.from(document.querySelectorAll('video')).filter((v) => !v.paused && v.currentTime > 0);
    if (videos.length) return videos[0];
    return document.querySelector('video');
  }

  function videoTimestamp() {
    const video = activeVideo();
    if (!video || !isFinite(video.currentTime)) return '';
    const total = Math.max(0, Math.floor(video.currentTime));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return hours > 0 ? `${pad(hours)}-${pad(minutes)}-${pad(seconds)}` : `${pad(minutes)}-${pad(seconds)}`;
  }

  function pageTitle() {
    const raw = document.title || '';
    const cleaned = raw
      .replace(/[_\-—|·]\s*哔哩哔哩.*$/i, '')
      .replace(/_bilibili.*$/i, '')
      .replace(/^哔哩哔哩\s*[_\-—|·]*\s*/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    return cleaned || 'B站截图';
  }

  /* ------------------------------------------------------------ 框选区域 */

  function pickRegion(image) {
    // 同一时间只允许一个框选会话
    if (activeRegionPicker) return Promise.resolve(null);
    return new Promise((resolve) => {
      const stack = ensureUI();
      const layer = document.createElement('div');
      layer.className = 'bs-region';

      const background = document.createElement('img');
      background.className = 'bs-region__bg';
      background.src = image.src;
      background.alt = '';

      const box = document.createElement('div');
      box.className = 'bs-region__box';
      const sizeTag = document.createElement('div');
      sizeTag.className = 'bs-region__size';
      box.appendChild(sizeTag);

      const hint = document.createElement('div');
      hint.className = 'bs-region__hint';
      hint.textContent = '拖动鼠标框选区域 · Enter 确认 · Esc 取消';

      layer.append(background, box, hint);
      stack.appendChild(layer);

      let start = null;
      let current = null;
      let dragging = false;
      let actionBar = null;

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
        activeRegionPicker = null;
      };

      const selectionRect = () => {
        if (!start || !current) return null;
        const left = Math.max(0, Math.min(start.x, current.x));
        const top = Math.max(0, Math.min(start.y, current.y));
        const right = Math.min(window.innerWidth, Math.max(start.x, current.x));
        const bottom = Math.min(window.innerHeight, Math.max(start.y, current.y));
        return { left, top, width: right - left, height: bottom - top };
      };

      const paint = () => {
        const rect = selectionRect();
        if (!rect || rect.width < 1 || rect.height < 1) {
          box.style.display = 'none';
          return;
        }
        box.style.display = 'block';
        box.style.left = `${rect.left}px`;
        box.style.top = `${rect.top}px`;
        box.style.width = `${rect.width}px`;
        box.style.height = `${rect.height}px`;
        sizeTag.textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)}`;
        if (rect.top < 26) {
          sizeTag.style.top = 'auto';
          sizeTag.style.bottom = '-24px';
        } else {
          sizeTag.style.top = '-24px';
          sizeTag.style.bottom = 'auto';
        }
      };

      const showActions = () => {
        if (actionBar) actionBar.remove();
        const rect = selectionRect();
        if (!rect) return;

        actionBar = document.createElement('div');
        actionBar.className = 'bs-region__actions';

        const confirmBtn = document.createElement('button');
        confirmBtn.className = 'bs-btn bs-btn--primary';
        confirmBtn.textContent = '✓ 截取 (Enter)';
        confirmBtn.addEventListener('click', () => {
          const finalRect = selectionRect();
          if (finalRect && finalRect.width >= 4 && finalRect.height >= 4) done(finalRect);
        });

        const resetBtn = document.createElement('button');
        resetBtn.className = 'bs-btn';
        resetBtn.textContent = '重选';
        resetBtn.addEventListener('click', () => {
          if (actionBar) actionBar.remove();
          actionBar = null;
          start = current = null;
          box.style.display = 'none';
          hint.style.display = '';
        });

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'bs-btn bs-btn--ghost';
        cancelBtn.textContent = '✕';
        cancelBtn.title = '取消 (Esc)';
        cancelBtn.addEventListener('click', () => done(null));

        actionBar.append(confirmBtn, resetBtn, cancelBtn);

        const barWidth = 250;
        const barLeft = clamp(rect.left, 12, Math.max(12, window.innerWidth - barWidth - 12));
        const barTop = clamp(rect.top + rect.height + 10, 12, Math.max(12, window.innerHeight - 56));
        actionBar.style.left = `${barLeft}px`;
        actionBar.style.top = `${barTop}px`;
        stack.appendChild(actionBar);
      };

      const onDown = (event) => {
        if (event.button !== 0) return;
        if (actionBar && actionBar.contains(event.target)) return;
        dragging = true;
        start = { x: event.clientX, y: event.clientY };
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
        current = { x: event.clientX, y: event.clientY };
        paint();
      };

      const onUp = (event) => {
        if (!dragging) return;
        dragging = false;
        current = { x: event.clientX, y: event.clientY };
        paint();
        const rect = selectionRect();
        if (!rect || rect.width < 4 || rect.height < 4) {
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
          const rect = selectionRect();
          if (rect && rect.width >= 4 && rect.height >= 4) done(rect);
        }
      };

      layer.addEventListener('pointerdown', onDown);
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
      window.addEventListener('keydown', onKey, true);

      activeRegionPicker = { cancel: () => done(null) };
    });
  }

  /* -------------------------------------------------------------- UI 基础 */

  function ensureUI() {
    if (uiHost && uiHost.isConnected && uiStack) {
      ensureHostPlacement();
      return uiStack;
    }

    uiHost = document.createElement('div');
    uiHost.id = '__bili_shot_host__';
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

  /** 全屏时只有全屏元素的子树会被渲染，所以界面要挂到全屏元素里 */
  function ensureHostPlacement() {
    if (!uiHost) return;
    const target = document.fullscreenElement || document.documentElement || document.body;
    if (target && uiHost.parentNode !== target) target.appendChild(uiHost);
  }

  function clearTransientUI() {
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
    if (previewTimer) {
      clearTimeout(previewTimer);
      previewTimer = null;
    }
    if (toastEl) {
      toastEl.remove();
      toastEl = null;
    }
    if (previewEl) {
      previewEl.remove();
      previewEl = null;
    }
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
    // 触发进入动画
    requestAnimationFrame(() => toastEl && toastEl.classList.add('bs-toast--in'));
    toastTimer = setTimeout(() => {
      if (!toastEl) return;
      toastEl.classList.remove('bs-toast--in');
      const node = toastEl;
      toastEl = null;
      setTimeout(() => node.remove(), 220);
    }, 2600);
  }

  function showPreview(dataUrl, info) {
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
    image.src = dataUrl;
    image.alt = '截图预览';
    image.title = '点击复制到剪贴板';

    const meta = document.createElement('div');
    meta.className = 'bs-preview__meta';
    meta.textContent = `${info.width} × ${info.height}${info.meta && info.meta.videoTime ? ` · 视频 ${info.meta.videoTime}` : ''}`;

    const note = document.createElement('div');
    note.className = 'bs-preview__note';
    note.textContent = info.note || '';

    const actions = document.createElement('div');
    actions.className = 'bs-preview__actions';

    const makeBtn = (label, className, handler) => {
      const button = document.createElement('button');
      button.className = className;
      button.textContent = label;
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          await handler();
        } catch (err) {
          showToast(String((err && err.message) || err), 'error');
        } finally {
          button.disabled = false;
        }
      });
      return button;
    };

    const copyBtn = makeBtn('复制', 'bs-btn bs-btn--primary', async () => {
      const response = await sendMessage({
        type: 'DELIVER',
        dataUrl,
        meta: info.meta,
        action: 'clipboard'
      });
      if (!response || !response.ok) throw new Error((response && response.error) || '复制失败');
      showToast('已复制到剪贴板', 'success');
    });

    const saveBtn = makeBtn('保存', 'bs-btn', async () => {
      const response = await sendMessage({
        type: 'DELIVER',
        dataUrl,
        meta: info.meta,
        action: 'download'
      });
      if (!response || !response.ok) throw new Error((response && response.error) || '保存失败');
      showToast(response.message || '已保存', 'success');
    });

    const closeBtn = makeBtn('✕', 'bs-btn bs-btn--ghost', async () => {
      if (previewTimer) clearTimeout(previewTimer);
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

  /* ------------------------------------------------------------ 消息通道 */

  function sendMessage(payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(payload, (response) => {
          const error = chrome.runtime.lastError;
          if (error) resolve({ ok: false, error: error.message });
          else resolve(response);
        });
      } catch (err) {
        resolve({ ok: false, error: String((err && err.message) || err) });
      }
    });
  }
})();
