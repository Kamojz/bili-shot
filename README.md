# B站快捷截图 · BiliShot

> 在哔哩哔哩网页里按一下 <kbd>Insert</kbd> 键截图：自动复制到剪贴板 / 保存成图片，随手 <kbd>Ctrl</kbd>+<kbd>V</kbd> 就能粘到 QQ、微信、文档里。

提供两种形态，按需要选一个（也可以都装）：

| | 🐵 油猴脚本 [`userscript/bili-shot.user.js`](userscript/bili-shot.user.js) | 🧩 浏览器扩展 [`extension/`](extension/manifest.json) |
| --- | --- | --- |
| 安装成本 | ⭐ 拖进 Tampermonkey，30 秒 | 解压 + 开发者模式加载 |
| **截视频画面** | ✅ 视频原始分辨率（1080P 出 1920×1080） | ✅ |
| **截整页（含弹幕、评论、网页 UI）** | ❌ 网页脚本拿不到截屏权限 | ✅ |
| 框选 | ✅ 画面内框一块 | ✅ 整页任意位置框一块 |
| 全屏播放可用 | ✅ | ✅ |
| 复制到剪贴板 | ✅ | ✅ |
| 文件名带视频时间点 | ✅ | ✅ |
| 明确适用场景 | 截视频帧发群、做表情包/封面 | 需要连弹幕、评论、界面一起截 |

> 一句话区别：**浏览器不允许网页脚本给自己截屏**，所以油猴脚本只能把 `<video>` 那一帧画到 canvas 上——画面是完美原图，但截不到弹幕和网页 UI。要整页就用扩展。

---

## 安装

### 方式一：油猴脚本（推荐，最省事）

1. 安装 **Tampermonkey**（Edge 扩展商店、Chrome 应用商店均可）。
2. 把 [`userscript/bili-shot.user.js`](userscript/bili-shot.user.js) **拖进浏览器窗口**，油猴会弹出安装页 → 点「安装」。
   - 或者：油猴图标 →「添加新脚本」→ 清空模板 → 粘贴文件内容 → <kbd>Ctrl</kbd>+<kbd>S</kbd>。
3. 打开任意 B站 视频页（已开着的页面**刷新一次**），按 <kbd>Insert</kbd>。

### 方式二：扩展

1. 到本仓库 **Releases** 下载 `bilishot-extension-v*.zip` 并**解压**（也可以直接用仓库里的 [`extension/`](extension/manifest.json) 目录）。
2. Edge 打开 `edge://extensions`（Chrome 为 `chrome://extensions`），打开 **开发人员模式**。
3. 点 **加载解压缩的扩展**，选择解压出来的目录（含 `manifest.json` 那一层）。
4. 已开着的 B站 页面需要**刷新一次**；首次安装会自动打开设置页。

---

## 快捷键

| 按键 | 油猴版 | 扩展版 |
| --- | --- | --- |
| <kbd>Insert</kbd> | 截当前视频画面（默认：复制 + 保存） | 默认模式（可设：整页 / 仅视频 / 框选） |
| <kbd>Shift</kbd>+<kbd>Insert</kbd> | 固定整帧 | 只截视频画面 |
| <kbd>Alt</kbd>+<kbd>Insert</kbd> | 画面内拖拽框选 | 整页任意区域框选 |
| <kbd>Enter</kbd> / <kbd>Esc</kbd> | 确认 / 取消框选 | 确认 / 取消框选 |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>X</kbd> | — | 任意网站截图（可在 `edge://extensions/shortcuts` 改键） |

截图后右下角会弹预览卡片，可直接「复制 / 保存 / 关闭」。文件名形如 `测试视频标题_12-34.png`（视频标题 + 播放时间点）；扩展还支持 `{date}` `{time}` `{title}` `{vt}` 等模板，默认存到 `下载/B站截图/`。

**设置在哪改**

- 油猴版：油猴图标 → 脚本菜单（截图后行为 / PNG-JPEG / Insert 默认 / 预览开关 / 恢复默认）
- 扩展版：工具栏图标 → 设置（可换按键为 F8、F9 等，调质量、模板、目录、预览时长）

---

## 为什么扩展要申请 `<all_urls>`？

这不是偷懒。现在的 Chromium（Edge 158 / Chrome 157 实测）里，`tabs.captureVisibleTab` **只认 `<all_urls>` 或 `activeTab` 权限**，只声明 `*.bilibili.com` 会直接抛
`Either the '<all_urls>' or 'activeTab' permission is required`。

而 `activeTab` 只能由「点击扩展图标 / 使用扩展快捷键」授予，无法由页面里的 <kbd>Insert</kbd> 触发——要做成裸键截图，只能声明 `<all_urls>`。
**脚本注入仍然只在 `bilibili.com`**（见 [`extension/manifest.json`](extension/manifest.json) 的 `content_scripts.matches`），行为上依旧是 B站 专用。
扩展全部本地运行，不联网、不上传任何截图。

---

## 已知限制

- 油猴版只能截 `<video>` 画面，截不到弹幕/评论/网页 UI（浏览器安全策略）。
- 极少数开着硬解 / 受保护内容的播放器会截出黑屏，关掉硬件加速或换播放模式。
- 扩展只能截**当前可见区域**，长截图不在范围内；`chrome://`、扩展商店页面不允许截。
- 直播、番剧、部分活动页播放器结构不同，油猴版可能需要补 `@match` 域名。

## 常见问题

**按 Insert 没反应？** 确认在 `bilibili.com` 页面 → 装完/更新后刷新页面 → 焦点在输入框时先点一下页面空白处 → 油猴面板里脚本是「已启用」。

**提示「没有找到视频画面」？** 画面还没出帧或播放器结构特殊，等画面出来再按。

**提示「浏览器拒绝写入剪贴板」？** 会兜底改成下载；也可以直接点预览卡片里的「保存」。

**Ins 键和别的软件冲突？** 油猴版改脚本里 `baseKey: 'Insert'`；扩展版在设置页点一下按键即可换。

---

## 开发与测试

无任何第三方依赖，Node 22+ 即可。两个测试都会真的启动浏览器（默认 Edge）、加载扩展 / 注入脚本、模拟按键，然后校验产出的图片尺寸：

```bash
node tools/smoke-extension.mjs    # 扩展：Service Worker 启动、注入、Ins/Shift+Ins/Alt+Ins 截图尺寸、剪贴板、设置页
node tools/smoke-userscript.mjs   # 油猴脚本：抓帧尺寸、框选裁剪、文件名、输入框不误触发、菜单命令
```

CI（GitHub Actions，`windows-latest` 预装 Edge）会在每次 push 时跑这两个测试，见 [`.github/workflows/smoke.yml`](.github/workflows/smoke.yml)。

打包发布产物（用 Windows 自带的 PowerShell 就行，不需要 pwsh 或额外工具）：

```powershell
tools\build-release.cmd
# 等价于： powershell -ExecutionPolicy Bypass -File tools\build-release.ps1
```

产物在 `dist/`：

- `bilishot-extension-v<版本>.zip` —— 解压后「加载解压缩的扩展」。脚本会校验 `manifest.json` 在 zip 根目录、条目用 `/` 分隔（避免 7-Zip/Linux 解压出错）
- `bili-shot.user.js` —— 拖进 Tampermonkey 安装

发布包本身也能过测试（防止打包漏文件）：

```bash
# 解压 Release zip 到某目录，然后让测试指向它
set BILISHOT_EXT_DIR=D:\path\to\extracted
node tools/smoke-extension.mjs
```

目录结构：

```
.
├── userscript/bili-shot.user.js   油猴脚本
├── extension/                     MV3 扩展（manifest + SW + 内容脚本 + offscreen + 弹窗/设置页）
│   ├── background.js              截图、裁剪调度、剪贴板/下载
│   ├── content.js                 Ins 键监听、视频/框选裁剪、Shadow DOM 界面
│   ├── offscreen.html/.js         写系统剪贴板（含 execCommand 兜底）
│   ├── popup.html/.js             工具栏弹窗
│   ├── options.html/.js           设置页
│   └── icons/                     图标
├── tools/                         冒烟测试 / 图标生成 / 打包脚本
└── .github/workflows/smoke.yml    CI
```

---

## 免责声明

- 本项目是**非官方**工具，与哔哩哔哩（bilibili）及其关联公司**没有任何关系**，未获其授权或认可；名称中的「B站」仅用于说明适用平台。
- 截图内容（视频画面、弹幕、评论等）的著作权归原权利人所有。请仅用于个人学习、评论引用等合法用途，**不得用于侵权、二次售卖或规避任何付费/版权限制**。
- 本项目只做「截图」，不下载、不破解、不绕过任何会员或 DRM 限制。
- 使用本工具产生的一切后果由使用者自行承担，作者不对任何间接损失负责。

## 许可证

[MIT](LICENSE) © 2026 BiliShot contributors
