/**
 * BiliShot 扩展冒烟测试（无第三方依赖，自动定位扩展自己的 Service Worker）
 *
 * 用法：
 *   node tools/smoke-extension.mjs                          # 默认用 Edge
 *   BILISHOT_BROWSER=...\\chrome.exe node tools/smoke-extension.mjs
 *
 * 说明：Chrome 137+ 官方版已禁止 --load-extension，Edge 仍可，所以默认用 Edge 跑。
 *      Chrome 需要命名管道做多进程 IPC，在受限沙箱里会启动失败。
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = process.env.BILISHOT_EXT_DIR
  ? path.resolve(process.env.BILISHOT_EXT_DIR)
  : path.resolve(HERE, '..', 'extension');
const BROWSER =
  process.env.BILISHOT_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const HTTP_PORT = 8899;
const DEBUG_PORT = 9333;
const TMP = path.join(tmpdir(), `bilishot-ext-${Date.now()}`);
const EXT_DIR = path.join(TMP, 'ext');
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

/* ------------------------------------------------------------ 准备测试环境 */

function prepareExtension() {
  mkdirSync(TMP, { recursive: true });
  cpSync(SRC, EXT_DIR, { recursive: true });
  for (const junk of ['tools', '.smoke']) rmSync(path.join(EXT_DIR, junk), { recursive: true, force: true });
  mkdirSync(DL_DIR, { recursive: true });

  // 测试版：额外允许本地测试页 + 「既复制又保存」，一次跑通两条链路
  const manifestPath = path.join(EXT_DIR, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.content_scripts[0].matches.push('http://127.0.0.1/*');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  for (const file of ['background.js', 'content.js']) {
    const p = path.join(EXT_DIR, file);
    writeFileSync(p, readFileSync(p, 'utf8').replace("saveAction: 'clipboard'", "saveAction: 'both'"));
  }
}

const TEST_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>测试视频标题_哔哩哔哩_bilibili</title>
<style>
  body { margin:0; background:#101418; color:#fff; font-family:sans-serif; }
  h1 { font-size:18px; padding:14px 18px; margin:0; }
  #player { position:absolute; left:120px; top:140px; width:640px; height:360px; background:#000; }
  video { width:100%; height:100%; display:block; background:#24303a; }
</style></head>
<body>
  <h1>BiliShot 冒烟测试页</h1>
  <div id="player"><video id="v" muted playsinline></video></div>
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

/* --------------------------------------------------------------- CDP 客户端 */

class CDP {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
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
        if (message.error) reject(new Error(`${message.error.message} ${JSON.stringify(message.error.data || '')}`));
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

/* ------------------------------------------------------------------ 工具 */

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

/** 按修改时间找「这一轮新产生（含被覆盖）」的 PNG */
async function waitForPng(dir, sinceMs, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const candidates = listFiles(dir)
      .filter((f) => /\.png$/i.test(f))
      .map((f) => {
        try {
          return { file: f, stat: statSync(f) };
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean)
      .filter((item) => item.stat.size > 500 && item.stat.mtimeMs >= sinceMs);
    if (candidates.length) {
      await sleep(300);
      return candidates.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)[0].file;
    }
    await sleep(200);
  }
  return null;
}

/* ------------------------------------------------------------------ 主流程 */

let browserProcess = null;
let server = null;
let cdp = null;

try {
  prepareExtension();
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
      '--enable-logging=stderr',
      '--force-device-scale-factor=1',
      '--window-size=1280,800',
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${PROFILE}`,
      `--load-extension=${EXT_DIR}`,
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

  /* ---- 定位「我们自己」的 Service Worker（浏览器可能还带着内置扩展） ---- */
  await sleep(1500);
  const { targetInfos } = await cdp.send('Target.getTargets');
  const workerTargets = targetInfos.filter(
    (t) => t.type === 'service_worker' && /^chrome-extension:\/\/[a-p]{32}\/background\.js$/.test(t.url)
  );

  let myWorker = null;
  let extensionId = null;
  for (const target of workerTargets) {
    try {
      const session = (await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
      await cdp.send('Runtime.enable', {}, session);
      const name = await cdp.send(
        'Runtime.evaluate',
        { expression: 'chrome.runtime.getManifest().name', returnByValue: true },
        session
      );
      if (/BiliShot|B站快捷截图/.test(String(name.result.value))) {
        myWorker = target;
        extensionId = target.url.split('/')[2];
        myWorker.sessionId = session;
        break;
      }
    } catch (_) {
      /* 内置扩展可能不允许 attach，跳过 */
    }
  }
  check(!!myWorker, '扩展 Service Worker 已启动', myWorker ? extensionId : `扫描了 ${workerTargets.length} 个 SW 都不是本扩展`);

  /* ---- 打开测试页 ---- */
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${HTTP_PORT}/` }, sessionId);
  await sleep(2000);
  await cdp.send('Page.bringToFront', {}, sessionId).catch(() => {});

  const evaluate = async (expression) => {
    const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || '页面脚本异常');
    return result.result.value;
  };

  let injected = false;
  for (let i = 0; i < 25; i++) {
    injected = await evaluate(`document.documentElement.getAttribute('data-bili-shot') === 'ready'`);
    if (injected) break;
    await sleep(200);
  }
  check(injected, '内容脚本已注入页面', injected ? 'data-bili-shot=ready' : '找不到注入标记');

  // headless 下按键需要有聚焦文档
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 20, y: 690, button: 'left', buttons: 1, clickCount: 1 }, sessionId);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 20, y: 690, button: 'left', buttons: 0, clickCount: 1 }, sessionId);
  await sleep(200);

  const viewport = await evaluate('({ w: window.innerWidth, h: window.innerHeight, dpr: devicePixelRatio })');
  log(`视口： ${viewport.w} x ${viewport.h} @${viewport.dpr}x`);

  const pressInsert = async (modifiers) => {
    const base = {
      modifiers,
      key: 'Insert',
      code: 'Insert',
      windowsVirtualKeyCode: 45,
      nativeVirtualKeyCode: 45,
      location: 0
    };
    await cdp.send('Input.dispatchKeyEvent', { ...base, type: 'keyDown' }, sessionId);
    await cdp.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' }, sessionId);
  };

  const readUi = () =>
    evaluate(`(() => {
      const host = document.getElementById('__bili_shot_host__');
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

  /* ---- 用例 1：Ins -> 整页可见区域 ---- */
  let since = Date.now() - 200;
  await pressInsert(0);
  let shot = await waitForPng(DL_DIR, since);
  const ui1 = await readUi();
  check(!!shot, '按 Ins 键触发截图并产生文件', shot ? path.basename(shot) : '15 秒内没有新文件');
  if (shot) {
    const size = pngSize(shot);
    check(
      !!size && size.width === viewport.w && size.height === viewport.h,
      '整页截图尺寸 = 视口尺寸',
      size ? `${size.width}x${size.height}（期望 ${viewport.w}x${viewport.h}）` : '不是有效 PNG'
    );
  }
  check(
    !!ui1.toast && /已保存/.test(ui1.toast) && /B站截图\/bili_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.png/.test(ui1.toast),
    '文件名模板按预期生成',
    ui1.toast || '没有提示'
  );
  check(/已复制/.test(ui1.toast || ''), '图片写入系统剪贴板', ui1.toast || '没有提示');
  check(ui1.hasPreview, '预览卡片已出现', ui1.meta || '');

  if (!shot) {
    const pageErrors = cdp.events
      .filter((e) => e.method === 'Runtime.exceptionThrown')
      .slice(-3)
      .map((e) => JSON.stringify(e.params).slice(0, 300));
    if (pageErrors.length) log(`      页面报错：\n        ${pageErrors.join('\n        ')}`);
  }

  /* ---- 用例 2：后台 -> 内容脚本派发（隔离按键与截图链路） ---- */
  if (myWorker) {
    const sent = await cdp.send(
      'Runtime.evaluate',
      {
        expression: `(async () => {
          const tabs = await chrome.tabs.query({});
          const tab = tabs.find((t) => t.url && t.url.indexOf('127.0.0.1:${HTTP_PORT}') >= 0);
          if (!tab) return 'no-tab:' + tabs.length + ':' + tabs.map((t) => t.url).join('|');
          await chrome.tabs.sendMessage(tab.id, { type: 'RUN_CAPTURE', mode: 'view' });
          return 'sent';
        })()`,
        returnByValue: true,
        awaitPromise: true
      },
      myWorker.sessionId
    );
    check(sent.result.value === 'sent', '后台可向内容脚本派发截图任务', String(sent.result.value));
    since = Date.now() - 200;
    const shotViaSw = await waitForPng(DL_DIR, since);
    check(!!shotViaSw, '后台触发的截图同样落盘', shotViaSw ? path.basename(shotViaSw) : '没有新文件');
    await sleep(400);
  }

  /* ---- 用例 3：Shift+Ins -> 仅视频画面 ---- */
  since = Date.now() - 200;
  await pressInsert(8);
  shot = await waitForPng(DL_DIR, since);
  check(!!shot, 'Shift+Ins 截图产生文件', shot ? path.basename(shot) : '没有新文件');
  if (shot) {
    const size = pngSize(shot);
    const rect = await evaluate(
      `(() => { const r = document.querySelector('video').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })()`
    );
    check(
      !!size && size.width === rect.w * viewport.dpr && size.height === rect.h * viewport.dpr,
      '视频画面裁剪尺寸正确',
      size ? `${size.width}x${size.height}（期望 ${rect.w * viewport.dpr}x${rect.h * viewport.dpr}）` : '不是有效 PNG'
    );
  }

  /* ---- 用例 4：Alt+Ins -> 拖拽框选 ---- */
  await pressInsert(1);
  await sleep(800);
  let ui = await readUi();
  check(ui.hasRegion, 'Alt+Ins 打开框选遮罩');

  if (ui.hasRegion) {
    since = Date.now() - 200;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 300, y: 300, button: 'left', buttons: 1, clickCount: 1 }, sessionId);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 500, y: 500, button: 'left', buttons: 1 }, sessionId);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 700, y: 520, button: 'left', buttons: 1 }, sessionId);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 700, y: 520, button: 'left', buttons: 0, clickCount: 1 }, sessionId);
    await sleep(400);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, sessionId);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, sessionId);

    const shot3 = await waitForPng(DL_DIR, since);
    check(!!shot3, '框选截图产生文件', shot3 ? path.basename(shot3) : '没有新文件');
    if (shot3) {
      const size = pngSize(shot3);
      const expectW = 400 * viewport.dpr;
      const expectH = 220 * viewport.dpr;
      check(
        !!size && Math.abs(size.width - expectW) <= 2 && Math.abs(size.height - expectH) <= 2,
        '框选裁剪尺寸正确',
        size ? `${size.width}x${size.height}（期望约 ${expectW}x${expectH}）` : '不是有效 PNG'
      );
    }
    ui = await readUi();
    check(!ui.hasRegion, '框选遮罩已清除');
  }

  /* ---- 用例 5：设置页 / 弹窗页 ---- */
  if (extensionId) {
    for (const [page, selector, pattern] of [
      ['options.html', 'kbdBase', /Insert/],
      ['popup.html', 'kbdBase', /Insert/]
    ]) {
      const { targetId: pageTarget } = await cdp.send('Target.createTarget', {
        url: `chrome-extension://${extensionId}/${page}`
      });
      const pageSession = (await cdp.send('Target.attachToTarget', { targetId: pageTarget, flatten: true })).sessionId;
      await cdp.send('Runtime.enable', {}, pageSession);
      await sleep(1200);

      let text = '';
      for (let i = 0; i < 15; i++) {
        const result = await cdp.send(
          'Runtime.evaluate',
          {
            expression: `(() => { const el = document.getElementById('${selector}'); return el ? el.textContent : 'MISSING'; })()`,
            returnByValue: true
          },
          pageSession
        );
        text = String(result.result.value || '');
        if (pattern.test(text)) break;
        await sleep(300);
      }
      check(pattern.test(text), `${page} 渲染正常`, text);
      const pageErrors = cdp.events.filter(
        (e) => e.method === 'Runtime.exceptionThrown' && e.sessionId === pageSession
      );
      check(pageErrors.length === 0, `${page} 无 JS 异常`, pageErrors.length ? pageErrors[0].params.exceptionDetails.text : '');
    }
  }
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
  await sleep(500);

  if (failures.length && existsSync(BROWSER_LOG)) {
    const lines = readFileSync(BROWSER_LOG, 'utf8')
      .split('\n')
      .filter((l) => /CONSOLE|extension|manifest/i.test(l))
      .slice(-10);
    if (lines.length) log(`\n浏览器日志片段：\n${lines.join('\n')}`);
  }

  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch (_) {}

  log(`\n结果： ${failures.length === 0 ? '全部通过 ✓' : `${failures.length} 项失败 ✗`}`);
  process.exit(failures.length === 0 ? 0 : 1);
}
