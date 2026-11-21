/**
 * BiliShot 油猴脚本冒烟测试（无第三方依赖）
 *
 * 用真实 Edge 加载测试页（canvas.captureStream 做视频源，模拟 B站 的 MSE 视频），
 * 注入 bili-shot.user.js（带 GM_* 桩），然后模拟按键验证：
 *   1. Insert      -> 抓到 320x180 的视频帧，复制 + 保存
 *   2. Alt+Insert  -> 框选遮罩出现，拖 320x180 CSS -> 裁剪成 160x90
 *   3. 菜单命令注册、提示文案、预览卡片
 *
 * 用法： node tools/smoke-userscript.mjs
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..');
const BROWSER =
  process.env.BILISHOT_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const USERSCRIPT = path.join(SRC, 'userscript', 'bili-shot.user.js');
const HTTP_PORT = 8898;
const DEBUG_PORT = 9332;
const TMP = path.join(tmpdir(), `bilishot-us-${Date.now()}`);
const DL_DIR = path.join(TMP, 'downloads');
const PROFILE = path.join(TMP, 'profile');
const BROWSER_LOG = path.join(TMP, 'browser.log');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...args) => console.log(...args);
const failures = [];
function check(ok, label, detail) {
  log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  --  ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

const TEST_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>测试视频标题_哔哩哔哩_bilibili</title>
<style>
  body { margin:0; background:#101418; color:#fff; font-family:sans-serif; }
  h1 { font-size:18px; padding:14px 18px; margin:0; }
  #player { position:absolute; left:120px; top:140px; width:640px; height:360px; background:#000; }
  video { width:100%; height:100%; object-fit:contain; display:block; background:#24303a; }
</style></head>
<body>
  <h1>BiliShot 油猴脚本测试页</h1>
  <div id="player"><video id="v" muted playsinline></video></div>
  <input id="comment" placeholder="评论框" style="position:absolute;left:120px;top:540px;width:300px;">
  <script>
    // 用 canvas 流做「视频源」，和 B站 的 MSE blob 视频走同一条 canvas 抓帧路径
    const source = document.createElement('canvas');
    source.width = 320;
    source.height = 180;
    const ctx = source.getContext('2d');
    let tick = 0;
    (function draw() {
      tick++;
      ctx.fillStyle = 'hsl(' + (tick * 7 % 360) + ', 80%, 45%)';
      ctx.fillRect(0, 0, 320, 180);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 40px sans-serif';
      ctx.fillText('FRAME ' + tick, 20, 100);
      requestAnimationFrame(draw);
    })();

    const video = document.getElementById('v');
    video.srcObject = source.captureStream(30);
    video.play().catch(() => {});
  </script>
</body></html>`;

function startServer() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(TEST_PAGE);
    });
    server.listen(HTTP_PORT, '127.0.0.1', () => resolve(server));
  });
}

class CDP {
  constructor(url) {
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.url = url;
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      } else if (message.method) {
        this.events.push(message);
      }
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.socket.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 20000);
    });
  }

  close() {
    try {
      this.socket.close();
    } catch (_) {}
  }
}

async function getBrowserWsUrl() {
  for (let i = 0; i < 80; i++) {
    try {
      const info = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json();
      if (info.webSocketDebuggerUrl) return info;
    } catch (_) {}
    await sleep(250);
  }
  throw new Error('浏览器调试端口没有起来');
}

function listFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(dir);
  return out;
}

function pngSize(file) {
  const buffer = readFileSync(file);
  if (buffer.length < 24 || buffer.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

async function waitForPng(dir, sinceMs, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const hit = listFiles(dir)
      .filter((f) => /\.(png|jpg|jpeg)$/i.test(f))
      .map((f) => {
        try {
          return { file: f, stat: statSync(f) };
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean)
      .filter((item) => item.stat.size > 300 && item.stat.mtimeMs >= sinceMs)
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)[0];
    if (hit) {
      await sleep(250);
      return hit.file;
    }
    await sleep(200);
  }
  return null;
}

const GM_STUB = `
  window.__gmStore = window.__gmStore || {};
  window.__gmMenus = window.__gmMenus || [];
  window.GM_getValue = function (key, fallback) {
    return Object.prototype.hasOwnProperty.call(window.__gmStore, key) ? window.__gmStore[key] : fallback;
  };
  window.GM_setValue = function (key, value) { window.__gmStore[key] = value; };
  window.GM_registerMenuCommand = function (name, handler) {
    window.__gmMenus.push({ name: name, handler: handler });
    return name;
  };
  window.GM_unregisterMenuCommand = function (name) {
    window.__gmMenus = window.__gmMenus.filter(function (item) { return item.name !== name; });
  };
`;

let browserProcess = null;
let server = null;
let cdp = null;

try {
  mkdirSync(DL_DIR, { recursive: true });
  server = await startServer();
  log(`本地测试页： http://127.0.0.1:${HTTP_PORT}/`);

  browserProcess = spawn(
    BROWSER,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,MediaRouter',
      '--autoplay-policy=no-user-gesture-required',
      '--enable-logging=stderr',
      '--force-device-scale-factor=1',
      '--window-size=1280,800',
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${PROFILE}`,
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'
    ],
    { stdio: ['ignore', 'ignore', openSync(BROWSER_LOG, 'a')] }
  );

  const versionInfo = await getBrowserWsUrl();
  log(`浏览器： ${versionInfo.Browser}`);

  cdp = new CDP(versionInfo.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: DL_DIR,
    eventsEnabled: true
  });

  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: GM_STUB }, sessionId);
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${HTTP_PORT}/` }, sessionId);
  await sleep(2200);
  await cdp.send('Page.bringToFront', {}, sessionId).catch(() => {});

  const evaluate = async (expression) => {
    const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || '页面脚本异常');
    return result.result.value;
  };

  const videoInfo = await evaluate(`(() => {
    const v = document.querySelector('video');
    return { videoWidth: v.videoWidth, videoHeight: v.videoHeight, readyState: v.readyState, paused: v.paused };
  })()`);
  check(videoInfo.videoWidth === 320 && videoInfo.videoHeight === 180, '测试视频已出帧', JSON.stringify(videoInfo));

  /* ---- 注入油猴脚本（带 GM_* 桩） ---- */
  const source = readFileSync(USERSCRIPT, 'utf8');
  await evaluate(source);
  const injected = await evaluate(`typeof window.__biliShotScriptLoaded !== 'undefined' && window.__biliShotScriptLoaded === true`);
  check(!!injected, '脚本成功注入并完成初始化');
  const menus = await evaluate(`window.__gmMenus.map((m) => m.name)`);
  check(Array.isArray(menus) && menus.length >= 5, '油猴菜单命令已注册', Array.isArray(menus) ? menus.join(' / ') : String(menus));

  // 聚焦页面（按键需要有聚焦文档）
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 20, y: 700, button: 'left', buttons: 1, clickCount: 1 }, sessionId);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 20, y: 700, button: 'left', buttons: 0, clickCount: 1 }, sessionId);
  await sleep(200);

  const pressInsert = async (modifiers) => {
    const base = { modifiers, key: 'Insert', code: 'Insert', windowsVirtualKeyCode: 45, nativeVirtualKeyCode: 45 };
    await cdp.send('Input.dispatchKeyEvent', { ...base, type: 'keyDown' }, sessionId);
    await cdp.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' }, sessionId);
  };

  const readUi = () =>
    evaluate(`(() => {
      const host = document.getElementById('__bili_shot_script_host__');
      const root = host && host.shadowRoot;
      const toast = root && root.querySelector('.bs-toast');
      const meta = root && root.querySelector('.bs-preview__meta');
      return {
        toast: toast ? toast.textContent : null,
        meta: meta ? meta.textContent : null,
        hasPreview: !!(root && root.querySelector('.bs-preview')),
        hasRegion: !!(root && root.querySelector('.bs-region'))
      };
    })()`);

  /* ---- 用例 1：Insert 抓整帧 ---- */
  let since = Date.now() - 200;
  await pressInsert(0);
  let file = await waitForPng(DL_DIR, since);
  const ui1 = await readUi();
  check(!!file, 'Ins 键触发截图并保存文件', file ? path.basename(file) : '15 秒内没有新文件');
  if (file) {
    const size = pngSize(file);
    check(
      !!size && size.width === 320 && size.height === 180,
      '抓到的是完整视频帧尺寸',
      size ? `${size.width}x${size.height}（期望 320x180）` : '不是有效 PNG'
    );
    check(/测试视频标题/.test(path.basename(file)), '文件名带视频标题', path.basename(file));
  }
  check(/已复制/.test(ui1.toast || ''), '复制到剪贴板成功', ui1.toast || '没有提示');
  check(ui1.hasPreview, '预览卡片已出现', ui1.meta || '');

  /* ---- 用例 2：Alt+Insert 框选 ---- */
  await pressInsert(1);
  await sleep(700);
  let ui = await readUi();
  check(ui.hasRegion, 'Alt+Insert 打开框选遮罩');

  if (ui.hasRegion) {
    since = Date.now() - 200;
    // 播放器区域 x:120-760, y:140-500；拖 320x180 CSS -> 期望裁剪 160x90 像素
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 200, y: 200, button: 'left', buttons: 1, clickCount: 1 }, sessionId);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 320, y: 260, button: 'left', buttons: 1 }, sessionId);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 520, y: 380, button: 'left', buttons: 1 }, sessionId);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 520, y: 380, button: 'left', buttons: 0, clickCount: 1 }, sessionId);
    await sleep(400);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, sessionId);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, sessionId);

    const cropped = await waitForPng(DL_DIR, since);
    check(!!cropped, '框选截图产生文件', cropped ? path.basename(cropped) : '没有新文件');
    if (cropped) {
      const size = pngSize(cropped);
      check(
        !!size && size.width === 160 && size.height === 90,
        '框选按视频原始像素裁剪',
        size ? `${size.width}x${size.height}（期望 160x90）` : '不是有效 PNG'
      );
    }
    ui = await readUi();
    check(!ui.hasRegion, '框选遮罩已清除');
  }

  /* ---- 用例 3：评论框里按键不触发 ---- */
  await evaluate(`document.getElementById('comment').focus()`);
  since = Date.now() - 200;
  await pressInsert(0);
  await sleep(1200);
  const typed = await waitForPng(DL_DIR, since, 2500);
  check(!typed, '输入框内按键不误触发', typed ? `却产生了 ${path.basename(typed)}` : '没有截图，符合预期');

  /* ---- 用例 4：菜单切换保存方式真的生效 ---- */
  const switched = await evaluate(`(() => {
    const menu = window.__gmMenus.find((m) => /截图后/.test(m.name));
    if (!menu) return 'no-menu';
    menu.handler();
    return window.__gmStore.saveAction;
  })()`);
  check(!!switched && switched !== 'both', '菜单可切换「截图后」行为', String(switched));

  /* ---- 用例 5：页面无 JS 异常 ---- */
  const pageErrors = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown');
  check(pageErrors.length === 0, '脚本运行无未捕获异常', pageErrors.length ? pageErrors[0].params.exceptionDetails.text : '');
} catch (err) {
  log(`\n测试异常： ${err && err.stack ? err.stack : err}`);
  failures.push('测试执行异常');
} finally {
  if (cdp) cdp.close();
  if (browserProcess) {
    try {
      browserProcess.kill();
    } catch (_) {}
  }
  if (server) server.close();
  await sleep(400);

  if (failures.length && existsSync(BROWSER_LOG)) {
    const lines = readFileSync(BROWSER_LOG, 'utf8')
      .split('\n')
      .filter((l) => /CONSOLE/i.test(l))
      .slice(-10);
    if (lines.length) log(`\n页面控制台：\n${lines.join('\n')}`);
  }

  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch (_) {}

  log(`\n结果： ${failures.length === 0 ? '全部通过 ✓' : `${failures.length} 项失败 ✗`}`);
  process.exit(failures.length === 0 ? 0 : 1);
}
