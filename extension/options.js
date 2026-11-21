/**
 * BiliShot — 设置页脚本
 * 所有修改即时保存到 chrome.storage.sync。
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

const TOKENS = [
  { key: '{date}', desc: '日期', sample: '2026-11-21' },
  { key: '{time}', desc: '时间', sample: '23-48-36' },
  { key: '{stamp}', desc: '紧凑时间戳', sample: '20261121-234836' },
  { key: '{title}', desc: '视频标题', sample: '【4K】这是视频标题' },
  { key: '{vt}', desc: '视频时间点', sample: '12-34' },
  { key: '{mode}', desc: '截图方式', sample: '视频' }
];

const $ = (id) => document.getElementById(id);

let state = { ...DEFAULTS };
let recording = false;
let savedFlashTimer = null;

document.addEventListener('DOMContentLoaded', init);

async function init() {
  state = { ...DEFAULTS, ...(await safeGet()) };
  render();
  bind();
}

async function safeGet() {
  try {
    return await chrome.storage.sync.get(DEFAULTS);
  } catch (err) {
    console.warn('[BiliShot] 读取设置失败：', err);
    return { ...DEFAULTS };
  }
}

/* ------------------------------------------------------------- 渲染与绑定 */

function render() {
  $('defaultMode').value = state.defaultMode;
  $('skipWhenTyping').checked = !!state.skipWhenTyping;
  $('enabled').checked = !!state.enabled;
  $('showPreview').checked = !!state.showPreview;
  $('previewSeconds').value = state.previewSeconds;
  $('filenameTemplate').value = state.filenameTemplate;
  $('downloadSubfolder').value = state.downloadSubfolder;

  for (const input of document.querySelectorAll('input[name="saveAction"]')) {
    input.checked = input.value === state.saveAction;
  }
  for (const input of document.querySelectorAll('input[name="format"]')) {
    input.checked = input.value === state.format;
  }

  const qualityPercent = Math.round((Number(state.jpegQuality) || 0.92) * 100);
  $('jpegQuality').value = qualityPercent;
  $('qualityValue').textContent = `${qualityPercent}%`;
  $('qualityWrap').hidden = state.format !== 'jpeg';

  renderKeyLabels();
  renderTokenList();
  updateFilenamePreview();
}

function bind() {
  $('keyRecorder').addEventListener('click', toggleRecording);

  $('defaultMode').addEventListener('change', (event) => {
    save({ defaultMode: event.target.value });
  });
  $('skipWhenTyping').addEventListener('change', (event) => {
    save({ skipWhenTyping: event.target.checked });
  });
  $('enabled').addEventListener('change', (event) => {
    save({ enabled: event.target.checked });
  });
  $('showPreview').addEventListener('change', (event) => {
    save({ showPreview: event.target.checked });
  });
  $('previewSeconds').addEventListener('input', (event) => {
    const value = Math.max(0, Math.min(60, Number(event.target.value) || 0));
    save({ previewSeconds: value });
  });

  for (const input of document.querySelectorAll('input[name="saveAction"]')) {
    input.addEventListener('change', (event) => {
      if (event.target.checked) save({ saveAction: event.target.value });
    });
  }
  for (const input of document.querySelectorAll('input[name="format"]')) {
    input.addEventListener('change', (event) => {
      if (!event.target.checked) return;
      $('qualityWrap').hidden = event.target.value !== 'jpeg';
      save({ format: event.target.value });
      updateFilenamePreview();
    });
  }

  $('jpegQuality').addEventListener('input', (event) => {
    const percent = Number(event.target.value) || 92;
    $('qualityValue').textContent = `${percent}%`;
    save({ jpegQuality: percent / 100 });
  });

  $('filenameTemplate').addEventListener('input', (event) => {
    updateFilenamePreview();
    save({ filenameTemplate: event.target.value });
  });
  $('downloadSubfolder').addEventListener('input', (event) => {
    updateFilenamePreview();
    save({ downloadSubfolder: event.target.value });
  });

  $('resetBtn').addEventListener('click', async () => {
    state = { ...DEFAULTS };
    await chrome.storage.sync.set(DEFAULTS);
    render();
    flashSaved('已恢复默认设置');
  });
}

/* --------------------------------------------------------------- 保存状态 */

async function save(patch) {
  Object.assign(state, patch);
  try {
    await chrome.storage.sync.set(patch);
    flashSaved('设置已保存');
  } catch (err) {
    flashSaved(`保存失败：${err.message || err}`, true);
  }
}

function flashSaved(text, isError) {
  const node = $('saveState');
  node.textContent = text;
  node.classList.toggle('ok', !isError);
  if (savedFlashTimer) clearTimeout(savedFlashTimer);
  savedFlashTimer = setTimeout(() => {
    node.textContent = '修改会自动保存';
    node.classList.remove('ok');
  }, 2000);
}

/* ---------------------------------------------------------------- 按键录制 */

function toggleRecording() {
  if (recording) {
    stopRecording();
    return;
  }
  recording = true;
  const button = $('keyRecorder');
  button.classList.add('recording');
  button.textContent = '请按下按键… (Esc 取消)';
  window.addEventListener('keydown', onRecordKey, true);
}

function onRecordKey(event) {
  event.preventDefault();
  event.stopPropagation();

  if (event.key === 'Escape') {
    stopRecording();
    return;
  }
  // 修饰键本身不算，等真正按下的那个键
  if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(event.key)) return;

  const code = event.code || event.key;
  stopRecording();
  save({ baseKey: code });
  renderKeyLabels();
}

function stopRecording() {
  recording = false;
  window.removeEventListener('keydown', onRecordKey, true);
  const button = $('keyRecorder');
  button.classList.remove('recording');
  renderKeyLabels();
}

function keyLabel(code) {
  if (!code) return 'Insert';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `小键盘 ${code.slice(6)}`;
  const map = {
    Space: '空格',
    Backquote: '`',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→'
  };
  return map[code] || code;
}

function renderKeyLabels() {
  const label = keyLabel(state.baseKey);
  $('keyRecorder').textContent = label;
  $('kbdBase').textContent = label;
  $('kbdShift').textContent = label;
  $('kbdAlt').textContent = label;
}

/* -------------------------------------------------------------- 文件名预览 */

function renderTokenList() {
  const list = $('tokenList');
  if (list.childElementCount) return;
  for (const token of TOKENS) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'token';
    chip.textContent = `${token.key} ${token.desc}`;
    chip.title = `插入 ${token.key}（示例：${token.sample}）`;
    chip.addEventListener('click', () => insertToken(token.key));
    list.appendChild(chip);
  }
}

function insertToken(key) {
  const input = $('filenameTemplate');
  const start = input.selectionStart == null ? input.value.length : input.selectionStart;
  const end = input.selectionEnd == null ? input.value.length : input.selectionEnd;
  input.value = input.value.slice(0, start) + key + input.value.slice(end);
  input.focus();
  input.selectionStart = input.selectionEnd = start + key.length;
  updateFilenamePreview();
  save({ filenameTemplate: input.value });
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function updateFilenamePreview() {
  const now = new Date();
  const samples = {
    date: `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`,
    time: `${pad2(now.getHours())}-${pad2(now.getMinutes())}-${pad2(now.getSeconds())}`,
    stamp: `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`,
    title: '【4K】这是视频标题',
    vt: '12-34',
    mode: '视频',
    width: '1920',
    height: '1080'
  };

  let template = $('filenameTemplate').value || DEFAULTS.filenameTemplate;
  let name = template.replace(/\{(\w+)\}/g, (match, key) =>
    samples[key] === undefined ? match : samples[key]
  );
  if (!/\.(png|jpe?g)$/i.test(name)) name += state.format === 'jpeg' ? '.jpg' : '.png';
  const folder = ($('downloadSubfolder').value || '').trim();

  $('filenamePreview').innerHTML = '';
  $('filenamePreview').append('示例：');
  const strong = document.createElement('b');
  strong.textContent = folder ? `${folder}/${name}` : name;
  $('filenamePreview').append(strong);
}
