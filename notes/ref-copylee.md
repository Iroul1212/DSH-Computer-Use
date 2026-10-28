# 竞品源码分析：@copylee/dsh-computer-use@0.8.0

分析对象：`_reference\_copylee\package\`（npm 0.8.0，★23）。下文 `index.js:NNN` 均指 `_reference\_copylee\package\lib\index.js`（391KB / 9517 行，tsdown 打包产物）；`client.js:NNN`、`CuHelper.cs:NNN`、`README.md:NNN` 同理；我们自己的文件用 `src/...:NNN`。

读法说明：`lib/types/*.d.ts` 是 tsc 从源码生成的契约文档，和 bundle 实现逐条对得上（抽查 coords / access / overlay / skills / effort / routes 全部一致）。bundle 内部保留了 `//#region lib/types/xxx.js` 的分区注释，所以模块边界可导航：插件自身逻辑在 `index.js:14-2960`（access / coords / keys / target / text / Computer / helper-client / koffi-path / native-helper / overlay / prompt / skills / settings / effort / routes / screenshots）与 `index.js:8503-9517`（tools / apply）；`index.js:2950-8500` 是被内联进来的 DSH SDK。

---

## 1. 一句话定位 + 自报能力清单

**定位**：把整个 Windows 桌面当唯一工具面的重型 computer-use 插件——C# 常驻助手（UI Automation / 分层窗口 / 全局键盘钩子）+ DSH 自带 koffi 的进程内 FFI 双引擎，按应用授权（per-app，走 DSH 原生审批），外挂一套"按 App 的 Markdown 技能库"和覆盖全屏的光晕/进度卡片 UI。

自报能力（README.md:17-39 的功能表，逐行对应到代码）：

| 卖点（README.md:17-39） | 代码出处 |
|---|---|
| 截图即坐标系，DPI/缩放/多屏偏移全由插件换算 | `index.js:202-222`（`screenshotSize`/`toPhysical`）、`coords.d.ts:1-15` |
| 动作后自动截图，等画面静止（≤2.5s），画面没变就只发文字 | `index.js:1301-1307`、`index.js:765-774`、`UNCHANGED_DIFF` `index.js:686` |
| 批量动作 `computer_batch`，最后一张图 | `index.js:8702-8785` |
| 按名称点控件 `target`（含菜单/对话框里还没出现的控件，最多等 3s） | `target.d.ts:1-40`、`index.js:497-589`、`index.js:1041-1078` |
| `wait` + `until`（window:/target:，可 `gone`） | `computer.d.ts:56-62`、`index.js:1127-1132` |
| 把窗口读成文本 `ui_elements text:true`（默认末 4000 字） | `index.js:8952-9005`、`index.js:8613-8621` |
| 按应用授权 `request_access`（DSH 原生审批） | `access.d.ts:1-8`、`index.js:9360-9378` |
| 永不操作自身窗口 + 密码管理器默认黑名单 | `index.js:22`、`index.js:95-105`、`index.js:185-193` |
| 橙色光晕 + 提示条，**不出现在截图里** | `CuHelper.cs:115,298`、`CuHelper.cs:1011-1027` |
| 迷你进度卡片 / 悬浮卡片 / 最小化（hostWindow 四模式） | `overlay.d.ts:1-20`、`index.js:1836-2156` |
| Esc 暂停/继续（只认物理键），点"停止"结束本轮 | `CuHelper.cs:120-124,526-545`、`index.js:1875-1888` |
| 用户打字自动让出、切窗口先重看屏幕 | `index.js:1085-1105`、`index.js:1902-1914` |
| 三档打字方式（stream / type / paste），Unicode 直输 | `computer.d.ts:28-30`、`index.js:1240-1272` |
| 剪贴板写入不进 Win+V 历史、本轮结束还原 | `index.js:9008-9037`、`index.js:9447-9454`、`CuHelper.cs:280-282` |
| 应用技能（10 份内置 + AI 自写 + 用户可编辑） | `skills.d.ts:1-40`、`index.js:8863-8874`、`helper/skills/*.md` |
| `open_application`（开始菜单/桌面快捷方式/托盘恢复/不多开） | `index.js:8786-8862` |
| 纯文本模型退化为 `ui_elements` | `index.js:8589-8598`（`call.vision`） |
| 零原生依赖（koffi + 系统 csc） | `README.md:39`、`index.js:1364-1398`、`index.js:1602-1614` |

`computer.d.ts:37-39` 的动作面一共 **17 个**：`screenshot, left_click, right_click, middle_click, double_click, triple_click, mouse_move, left_click_drag, left_mouse_down, left_mouse_up, scroll, type, key, hold_key, wait, zoom, cursor_position`。

工具总数 **9 个**（`app_skill` 仅在 `host.skills` 存在时注册，`index.js:9084`）：`computer` / `computer_batch` / `open_application` / `windows` / `ui_elements` / `clipboard` / `switch_display` / `request_access` / `app_skill`。README.md:67-79 的工具表与代码完全一致（漏了 `list_granted_applications`，见 §11-1）。

---

## 2. 架构：进程/线程模型、依赖、为什么这么选

### 2.1 三层结构

```
DSH Host (Node)
 └─ lib/index.js           工具 / 审批钩子 / 系统提示 / overlay 生命周期 / HTTP 路由
     ├─ lib/native-worker.js   worker_thread + DSH 自带 koffi.node → user32/gdi32/gdiplus/shcore/dwmapi/ole32
     └─ cu-helper.exe         常驻子进程，stdin/stdout 每行一个 JSON
```

证据：`README.md:111-122`（作者自画的结构图）；`native-worker.js:3-18`（`worker_threads` + `koffi.load("user32.dll")` 等 7 个系统 DLL，`createRequire(import.meta.url)(workerData.koffiPath)` 加载宿主自带的 `koffi.node`）；`index.js:1427-1583`（`HelperClient`：`spawn` 子进程、stdout 按 `\n` 切行、`pending` Map + 自增 id 做请求/响应配对）；`CuHelper.cs:267-305`（一个 `switch (cmd)` 分派约 35 条命令）。

两条路径不是二选一，而是**按命令动态路由**（`index.js:1616-1680`，文件头注释把规则写死了）：

- 恒走进程内 koffi：`displays` / `cursor` / `foreground`（`ALWAYS`，`index.js:1631-1635`）
- 有卡片窗口时反而退回 C#：`screenshot`（`NO_CARD`，`1636`）——因为卡片要被排除在截图外，只有 C# 侧的 Magnification API 做得到
- 浮层/卡片都没显示时走进程内：`move/click/keys/drag/scroll/type/windows/window_at`（`NO_OVERLAY`，`1637-1646`）——因为浮层一显示就需要 C# 侧的"躲胶囊"、"点击穿透卡片"、"每个输入前等指令框"
- 其余全部走 C# 助手；worker 起不来就把 `broken=true` 永久回退（`index.js:1688-1695`）

### 2.2 PowerShell 只是启动器（不是逻辑层）

`helper/host.ps1` 全文 13 行：`[Reflection.Assembly]::Load([IO.File]::ReadAllBytes($HelperExe))` 然后把 `EntryPoint.Invoke` 跑在签名的 `powershell.exe` 里，stdin/stdout 直接给助手当 JSON 管道（`host.ps1:1-12`）。触发条件只有一种：直接 spawn `cu-helper.exe` 被代码完整性策略拒绝（Smart App Control 报 `ERROR_ACCESS_DISABLED_BY_POLICY`，libuv 报成 `UNKNOWN`）——`index.js:1407-1424`（`POLICY_CODES` / `isPolicyBlock`）、`index.js:1489-1511`（先试 exe，失败则换 `powershell.exe -File host.ps1`，全局 `hostedHelper` 变量缓存这次降级）。

### 2.3 C# 助手怎么来：用系统自带的 csc 现场编译

`index.js:1344-1439`：读 `helper/CuHelper.cs` → 取 sha256 前 12 位 → 目录 `%LOCALAPPDATA%\dsh-computer-use\helper-<hash>\cu-helper.exe` → 不存在就用 `%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe` 编译（`-optimize+ -target:exe -r:System.Windows.Forms.dll` 等，12 万 ms 超时）→ 先写 `build-<pid>-<ts>.exe` 再 `rename` 原子落位（`1392-1397`）。README.md:39 自报"约 1 秒，之后缓存"。

### 2.4 npm 依赖：列全

**运行时真正 import 的只有两个包**（`index.js:1-13`）：

```
node:module, node:crypto, @deepseek-ai/schemastery, node:timers/promises,
node:child_process, node:fs, node:fs/promises, node:os, node:path,
node:url, node:worker_threads, node:zlib, @deepseek-ai/cordis
```

`package.json`：

- **没有 `dependencies` 字段**（整份文件里不存在）
- `peerDependencies`：`@deepseek-ai/cordis >=4<5`、`@deepseek-ai/schemastery >=3.18<4`、`react >=18.2<19`，三者全 `optional: true`
- `devDependencies`（**只在构建/测试时用**）：`koffi 3.1.1`、`@deepseek-ai/dsh-agent|dsh-attachment|dsh-host-webserver|dsh-llm|dsh-session|dsh-tools` 全 `0.2.0-rc.2`、`@deepseek-ai/cordis 4.0.4`、`schemastery 3.18.4`、`react 18.3.1`、`tsdown 0.22.2`、`typescript 6.0.3`、`vitest 4.1.8`、`@types/node`、`@types/react`
- `engines.node ^22.19.0 || >=24`、`os: ["win32"]`、`dsh.engines.dsh >=0.2.0-rc.2`
- `dsh.client.inject`：`@deepseek-ai/dsh-client-connection`、`dsh-api-remotes`、`dsh-client-ui-settings`、`dsh-client-locale`，`platform: "web"`

**为什么这么选（从代码能读出的动机）**：

1. `koffi` 故意不发布、不打包，运行时从 DSH 安装目录里"借"。候选路径是写死的（`index.js:1591-1614`）：`app.asar.unpacked/dsh/node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node`，外加 `DSH_KOFFI_PATH`、`process.resourcesPath`、`%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\...`、以及宿主入口脚本往上逐级找 `node_modules/...`。注释给了理由：**那个 koffi.node 有 DeepSeek 签名，Smart App Control 肯加载；自己 npm 装的 koffi 没签名，和被拒的 cu-helper.exe 一样没用**（`index.js:1587-1590`）。副产品是不受 node-gyp / Electron ABI 影响（README.md:39）。
2. C# 那半边只放"Node/FFI 很难做对"的东西：UI Automation、分层窗口 overlay、`WDA_EXCLUDEFROMCAPTURE`、低级键盘钩子、剪贴板（含"不进 Win+V 历史"）、shell:AppsFolder 启动、托盘图标恢复、Magnification API 截屏（`CuHelper.cs:267-305`）。用系统自带的 .NET Framework `csc.exe` 编译，等于零安装成本换一个"进程内可用的私有工具库"。
3. DSH SDK（`defineTool`、`ToolRuntime`、`LlmError`、attachment 类型、`HarnessError` 等）被 **tsdown 内联进 bundle**：`index.js:5677`（`function defineTool`）、`index.js:7447`（`class ToolRuntime`）、`index.js:4115`（`class LlmError`）。所以运行时不需要解析 `@deepseek-ai/dsh-tools` 等包——代价见 §11-1。

---

## 3. 工具面 vs 我们（逐个对比）

### 3.1 它的工具/动作/参数全表

参数细节来自 `index.js:8622-8676`（共享的 `actionProperties`）+ 各工具自己的 `parameters`。

| 工具 | 动作 / 枚举 | 主要参数 | 出处 |
|---|---|---|---|
| `computer` | 17 个动作（见 §1） | `coordinate[2]`、`start_coordinate[2]`、`text`（type 的正文；key/hold_key 的 xdotool 键名；click 的修饰键亦可）、`modifiers`、`scroll_direction{up,down,left,right}`、`scroll_amount`（默认 3）、`duration`（wait/hold_key 秒）、`target`（控件可见名，可写 `"按钮:保存"`）、`until`（`window:<标题/exe>` / `target:<名>`）、`gone`、`region[4]` | `index.js:8681-8701`、`8622-8676` |
| `computer_batch` | 同上但去掉 `screenshot`，最多 **30** 步，`zoom` 只能作最后一步 | `actions[]`、`finish{ screenshot \| text \| none }` | `index.js:8702-8785`、`8740` |
| `open_application` | —（单动作） | `name`（开始菜单名 / exe 路径 / http(s) URL / `ms-settings:`）、`new_instance` | `index.js:8786-8809` |
| `windows` | `list, focus, minimize, maximize, restore, close, tidy` | `hwnd`、`name`（exe 或标题片段） | `index.js:8892-8951` |
| `ui_elements` | —（两种读法） | `hwnd`、`text:boolean`、`tail`（默认 4000，上限 20000）、`include_text`、`max`（默认 120，上限 400） | `index.js:8952-9005`、`8613-8621` |
| `clipboard` | `read, write` | `text` | `index.js:9008-9037` |
| `switch_display` | —（列 / 切） | `index`（省略=只列） | `index.js:9038-9056` |
| `request_access` | —（单动作，走审批） | `apps[]`、`reason` | `index.js:9057-9083` |
| `app_skill` | `list, read, append, write` | `app`、`content`、`summary` | `index.js:9084-9145` |

### 3.2 和我们的 4 工具对比

我们：`computer`（14 action：`screenshot, cursor, move, click, double_click, right_click, middle_click, drag, scroll, type, key, wait, resume, status`，`src/tools.js:108`）、`app_window`（`list, focus, launch, close, minimize, maximize, restore`，`src/tools.js:466`）、`ui_element`（`tree, find, invoke, set_value, focus, expand, collapse, select`，`src/tools.js:656`）、`clipboard`（`get, set`，`src/tools.js:821`）。

| 能力 | copylee | 我们 | 判读 |
|---|---|---|---|
| 截图 | `computer{action:screenshot}` + 动作后自动截图 + 画面未变只回文字 | `computer{action:screenshot}`，走 DSH 附件管线 | 平；它多了"自动截图/去重/等静止" |
| 鼠标 | 7 个点击类 + move/drag/按下抬起 + `modifiers` | `move/click/double_click/right_click/middle_click/drag` + `count`/`button`/`modifiers[]` | 平；它多 `triple_click`、`left_mouse_down/up`、按住修饰键更细 |
| 键盘 | `type`、`key`、`hold_key`（xdotool 键名 → VK，`keys.d.ts:1-16`） | `type`、`key` | 它多 `hold_key` 与三档输入方式（stream/type/paste） |
| 滚动 | `scroll` + 方向/格数 | `scroll` | 平 |
| 等待 | `wait` + `until:window/target` + `gone`（条件等待） | `wait`（定时） | **它强**：条件等待是省步数的关键 |
| 放大 | `zoom`（区域按截图坐标，重新按 limits 输出） | 无 | **它强**（读小字） |
| 光标 | `cursor_position` | `cursor` | 平 |
| 多屏 | `switch_display`（一次只对一块屏工作） | 未提供屏级切换 | **它强**（多屏场景） |
| 窗口 | `windows` 7 动作 + `tidy` 收尾 + 记录任务前布局 | `app_window` 7 动作 | 平；它多了 `tidy`/origin 追踪（`computer.d.ts:120-140`） |
| 控件 | `ui_elements` 列元素（含弹窗）或**读窗口文本**；`target` 按名字点 | `ui_element` 用 accessibility path 做 `invoke/set_value/expand/collapse/select`（`src/tools.js:625-656`） | **互补**：它的 `target` 能点"下一屏才出现"的控件；我们的 path invoke 更精确、不用点像素 |
| 应用启动 | `open_application`：开始菜单/桌面快捷方式/托盘图标恢复/拒多开 | `app_window{launch}` | **它强**（托盘恢复、防双开、URL） |
| 授权 | `request_access` + per-app 白名单 + DSH 原生审批 | 无（靠全局审批 + guard） | **它强**（见 §5） |
| 技能 | `app_skill` + 10 份内置 md + 打开即注入 | 无 | **它强**（见 §6） |
| 批量 | `computer_batch` ≤30 步、最后一张图、`finish:text` | 无（模型逐步调） | **它强**（省模型往返） |
| 推理强度 | `quickSteps`：操作期间把 reasoningEffort 降到最低（`effort.d.ts:1-30`） | 无 | **它强**（延迟） |
| 剪贴板 | `read/write`，不进 Win+V、本轮结束还原 | `get/set` | 平机制、它多了隐私细节 |
| 纯文本模型 | `vision:false` 时不出图、回文字引导用 `ui_elements`（`index.js:8593`） | 未做按路由的图片能力门控 | 它更细 |

结论：**它有我们没有的能力 = `effort(quickSteps)`、`target`、`access/审批`、按 App 技能、`computer_batch`、`wait until`、`zoom`、`ui text` 读取、`open_application`（托盘/防双开）、`switch_display`、截图去重、三档输入、剪贴板还原、`tidy` 收尾。**

---

## 4. 截图与坐标（重点：DSH 请求侧 640k 二次缩放 / DPI）

### 4.1 它怎么截

1. **C# 侧 GDI 抓整屏矩形**：`GetDC(NULL)` + `BitBlt` 到一个 24bpp `Bitmap`（`CuHelper.cs:341-356`；另见 `CuHelper.cs:460`）。
2. **优先 Magnification API**：`MagInitialize` + 隐藏的 host 窗口 + `MagSetImageScalingCallback` + `MagSetWindowFilterList`，把**自己进程里的 overlay/卡片窗口排除在截图之外**，且不闪（`CuHelper.cs:1011-1049`、`450-452`）；失败才退回 BitBlt，并在 BitBlt 前把卡片区域涂掉（`CuHelper.cs:353`、`442-460`）。`d["via"]` 会回传 `mag` 还是 `blt`（`CuHelper.cs:508`）。
3. **缩放**：`Graphics.DrawImage` 到 `outWidth×outHeight`，`HighQualityBicubic` + `HighQuality` pixel offset/compositing（`CuHelper.cs:488-495`）。
4. **编码**：JPEG，`Encoder.Quality = quality`（默认 70，`CuHelper.cs:499-505`、`index.js:2392`）。
5. **DPI**：进程启动即 `SetProcessDpiAwarenessContext(-4)`（Per-Monitor-V2），失败退 `SetProcessDPIAware()`（`CuHelper.cs:195`）；每块屏用 `GetDpiForMonitor` 记录 `dpi`，`displays` 返回的是 `rcMonitor` **物理像素** + `dpi`（`CuHelper.cs:319-338`）。进程内 koffi 路径同样先 `SetThreadDpiAwarenessContext`（`native-worker.js:73`）。

所以：**模型永远只看到一个坐标系 = 当前显示器最近一次截图的像素**（`coords.d.ts:1-6` 明写这个契约）；物理换算由 `toPhysical` 用 `display.width/shot.width` 的比例完成（`index.js:212-222`），越界直接抛错（`index.js:215`）。

### 4.2 尺寸策略

```
scale = min(1, maxLongEdge / max(w,h))
if (w*h*scale^2 > maxPixels) scale = sqrt(maxPixels/(w*h))
```

`index.js:202-210`，**保比、不放大**。默认 `maxLongEdge=1366`、`maxPixels=1.15e6`（`index.js:2390-2391`，`resolveConfig` 把 maxPixels 限制在 `[3e5, 8e6]`、maxLongEdge `[640, 3840]`，`index.js:2417-2418`）。`zoom` 用同一组 limits 作用在裁剪区域上（`index.js:815-825`）。

### 4.3 它有没有处理 DSH 请求侧 640k px / 1MiB 二次缩放？——**没有**

三条硬证据：

1. 全 bundle 搜 `640000|64e4|imagePixelBudget|imageMaxBytes` **零命中**；`maxPixels` 只出现在它自己的截图尺寸计算里（`index.js:205,734,822,2391,2418,2526,9252`）。
2. 文本信封只回显**插件自己那张图的尺寸**：

```
text: `${text}\nScreenshot ${shot.width}x${shot.height} attached; use its pixel coordinates for the next actions.`
```
（`index.js:8596`）

3. `saveImage` 直接把 JPEG 字节交给 `ctx.attachments.saveImage`，**没有**把 `originalDimensions` 或"模型实际看到的尺寸"回给模型（`index.js:9338-9346`）。`toJson(ref)` 虽然会带上 `originalDimensions`（`index.js:8582-8586`），但那是 attachment 元数据（结构性字段，模型读不到其语义），而且只有 DSH 存储侧降采样时才有值。

**风险推导**（标记：**未在本机实测，属推断**）：按我们 `notes/api-recon.md:589-596` 实测的常量——请求侧 `imagePixelBudget` 默认 **640,000** 像素、`imageMaxBytes` 默认 **1 MiB**——1080p 屏经它缩到 1366×768 = **1,049,088 px > 640,000**，还要被 DSH 再缩 0.78 倍。此时模型看到的是 1065×599 的图，它回的坐标却按 1366 空间换算 → 系统性偏移约 22%（比例误差，不是平移误差），越靠右下越偏。它的 `maxPixels` 上限甚至允许 8e6，等于把这个问题放大到 3.5 倍缩放。

### 4.4 和我们比，谁更稳

我们：`maxPixels: 600000`（`src/runtime.js:32`，配置钳制 `[65536, 16777216]` `src/runtime.js:86`），并且文本信封把三件事都写清：

```
Screenshot {w}x{h}px (image space; {cw}x{ch} physical captured at (cx,cy), scale {scale}).
Pass x/y to click/move/drag/scroll in THIS image's pixel space with (0,0) at the top-left; ...
```
（`src/runtime.js:488-489`，光标还给双坐标 `src/runtime.js:491-493`）

| 维度 | copylee | 我们 | 谁稳 |
|---|---|---|---|
| 与 DSH 请求预算对齐 | 默认 1.15MP > 640k → **必然**二次缩放 | 600k < 640k → 一次缩放到底 | **我们** |
| 模型如何得知坐标空间 | 只知"图是多少 px"（`index.js:8596`） | 明确 scale + 物理捕获矩形 + 越界拒绝（`src/runtime.js:488`） | **我们** |
| DPI | Per-Monitor-V2 + 每屏 dpi（`CuHelper.cs:195,324`） | 物理像素捕获 + scale（`src/runtime.js:486-495`） | 平 |
| 越界坐标 | 抛错（`index.js:215`） | 抛错 + 图像空间契约（`src/runtime.js:592`） | 平 |
| 小字可读性 | 可调 maxPixels 到 8e6 + `zoom`（`index.js:2418`、`index.js:1116-1122`） | 固定 600k，无 zoom | **它**（读小字场景） |

一句话：**在"坐标和模型看到的图对齐"这件事上我们更稳**（预算内 + 信封回显）；**在"小字看不清"这件事上它更稳**（可放大 + zoom）。它这套做法的代价是把"必须靠模型自己数像素"的风险留给了用户。

---

## 5. 安全模型

### 5.1 overlay 怎么画，怎么不被截图看见

- 由 C# 助手建**分层窗口**（`overlay_show` 命令，`CuHelper.cs:298`），并 `SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)`（`CuHelper.cs:115` 的 P/Invoke 声明，调用点在 overlay 模块）→ 系统级把窗口从截屏/录屏里抠掉。
- 截图还有第二道保险：Magnification API 的 `MagSetWindowFilterList` 直接按 HWND 过滤（`CuHelper.cs:1011-1027`），"不闪"；Magnification 不可用时退回"截图瞬间把卡片区域 Blank 掉"（`CuHelper.cs:353`、`442-460`）。
- 四种宿主窗口模式 `pet | card | minimize | keep`（`overlay.d.ts:5`、`index.js:2413`），卡片能拖动、半透明、点击穿透、跟随深浅色（`README.md:29-31`；实现落在 `CuHelper.cs` 的 `CardLayer` / `Windows.Card`，`CuHelper.cs:300-301`）。
- 进度卡片内容：模型回复正文（流式）、思考（末 300 字）、最近 8 步时间线（`index.js:1965-1999`）；用户在卡片里打字 → `agent.steer()` 注入一条 user 消息（`index.js:9431-9446`，注意它用 `steer` 而不是取消本轮）。

### 5.2 Esc 怎么感知

- C# 侧装**低级键盘钩子** `SetWindowsHookEx`（`CuHelper.cs:120-124`），只认**物理按键**；插件自己注入的键鼠都打了 `dwExtraInfo = Native.Marker`（`CuHelper.cs:526,536,545`），所以"自己发的 Esc 不会误触发暂停"（`README.md:29`、`CuHelper.cs:10` 的事件协议注释 `{"event":"stop","reason":"esc"}`）。
- 事件流：helper 的 stdout 事件行 → `HelperClient.handle` → listeners → `OverlayController` 构造里的分发：`stop`→`stop()`、`pause`→`paused=true`、`resume`→`paused=false`、`user_input`→记 `lastUserInput/lastUserKey`、`message`→当作用户插话（`index.js:1875-1888`）。
- 执行侧：每个动作前 `yieldToUser()`，暂停/用户打字时 200ms 一轮轮询等待，超过 `MAX_PAUSE_MS = 15e5`（25 分钟）就抛错让模型收手（`index.js:1902-1914`、`index.js:1822`）；被挡下的动作**不算执行**，而是回一条 `skipped: true` + 新截图让模型重新规划（`index.js:1085-1104`）。
- 另有"用户抢键盘/切窗口"两条让出逻辑：`pauseOnUserInput` + `userIdleMs`（默认 1500ms，`index.js:2394-2395`），以及 `foregroundChanged()` 检测到窗口在前台变了就中止并回截图（`index.js:791-796`、`index.js:1093-1105`）。

### 5.3 有没有审批/白名单/作用域权限——有，而且是它的亮点

- `AccessMode = 'per-app' | 'allow-all'`（`access.d.ts:8`），默认 `per-app`（`index.js:2383`）。
- `AccessControl`：按 **session** 存 grants（`grant/granted/isGranted/missing/forget`，`access.d.ts:30-45`，`index.js:152-193`）。判定顺序（`index.js:185-193`）：① 宿主窗口 → 拒（`HOST_EXES = ["deepseek harness.exe"]`，`index.js:22`）→ ② `DEFAULT_BLOCKED`（1password/bitwarden/keepass/lastpass/dashlane/enpass/nordpass/proton pass，`index.js:95-105`）+ 用户 `blockedApps` → 拒 → ③ `allow-all` 或已授权 → 放。
- **作用域精确到"点下的那个窗口"**：鼠标类动作先 `windowAt(point)` 再判权限（`checkPointer`，`index.js:924-927`），键盘类动作按**前台窗口**判（`checkKeyboard`，`index.js:928-930`）。这比"按 app 名放行"更严。
- 审批接进 DSH 原生审批：`ctx.on("tools/pre-execute")` 拦 `request_access`，对**未授权**的 app 返回 `{ kind: "ask", reason, displayReason: { en, "zh-CN" } }`（`index.js:9360-9378`）；`approval.effectivePolicy(session) === "never"`（完全权限/自动审查）时直接放行并把 `autoApprove` 传给工具上下文（`index.js:9311-9319`、`index.js:9354`）。
- 应用名归一化做得细：`normalizeApp` + `ALIASES` 中英别名（"记事本"→notepad、"微信"→weixin/wechat、"计算器"→calculatorapp/applicationframehost…，`index.js:24-94`），`GENERIC_HOSTS` 排除 applicationframehost/explorer/msedgewebview2/javaw/python/electron 这些"公共宿主"（`index.js:2198`），并排除"触摸键盘/贴靠助手"这类瞬态 shell 窗口（`isTransientShell`，`access.d.ts:24-28`）。

### 5.4 我们缺的安全机制（值得抄）

1. **按应用授权 + DSH 原生审批接线**（`request_access`），我们现在只有全局审批 + guard。
2. **永不向宿主自身窗口输入**的硬拒绝（我们靠 guard 拦"人"，没拦"点到自己窗口"）。
3. **密码管理器默认黑名单**。
4. **"用户接管"语义**：暂停期间动作不是失败而是 `skipped` + 回新截图（`index.js:1085-1091`），比"抛错"更省 turn。
5. **overlay/卡片不进截图**（我们有 overlay + guard，但是否被截进图里需要自查）。
6. 截图附件的**孤儿清理**（`ScreenshotCache`，见 §11-10 的风险提示）。

### 5.5 它明显不安全 / 可疑的地方

1. **per-app 在"完全权限"会话下退化成 allow-all，且是模型自己点名就授权**：`openApp` 里当 `autoApprove === true` 时，只要名字里没有 "deepseek harness"，就直接 `access.grant(session, [appName])`（`index.js:8818-8823`）。也就是说 per-app 白名单**不是用户点过名的清单**，而是"模型想操作谁就自动进名单"。README.md:59 承认"会话权限为完全权限或自动审查时，请求会被自动批准"，但这个自动 grant 代码比 README 说得更宽。
2. **没有"危险动作二次确认"的代码级闸门**：发消息、删除、购买这类只在 system prompt 里写"Ask before irreversible actions"（`index.js:2173`）——纯靠模型自律。我们 `src/runtime.js:414` 是"审批服务不可用就 `APPROVAL_UNAVAILABLE` 硬拒"，属于 fail-closed；它是 fail-open + 提示词。
3. **进程内输入路径没有 Esc 钩子**：`move/click/keys/drag/scroll/type` 在"浮层未显示且无卡片"时直接由 worker 用 koffi `SendInput` 注入（`index.js:1637-1646`、`native-worker.js:78,526-545` 对应 C# 同款），这条路径上没有人监听 Esc。若 C# 助手压根没起来（编译失败 / SAC 拒绝又兜底失败）而 koffi 可用，理论上仍能注入键鼠但**失去全部监督手段**（未实测，属推断——`ensure()` 失败会把 `broken=true` 从而全走 helper，见 `index.js:1688-1695`，所以更可能是"两路都不可用"）。
4. **helper 崩溃后 overlay/Esc 可能缺位**：`OverlayController.visible` 是缓存的（`index.js:1921-1947`：只有 `!visible` 才 `overlay_show`），而 helper 退出只清 pending 不通知 overlay（`index.js:1541-1549`）；helper 重启后 `begin()` 会走 `status()` 分支，光晕与键盘钩子不会重建（未证实，但代码路径支持这个担心）。
5. **长文本走剪贴板**：stream/paste 模式全程 `clipboard_hold` → 分段 `paste` → `clipboard_release`（`index.js:1243-1263`、`CuHelper.cs:280-282`）。期间用户原文在系统剪贴板里，任何有剪贴板读取权限的进程都能拿到（这是 Windows 的固有属性，不是它独有的错），但"AI 把长文粘进剪贴板"确实扩大了暴露面。
6. **`windows close` 可关任意窗口**（`index.js:8931-8945`），只按 `access.denial` 判一次，且 `minimize` 被特意豁免（`index.js:8935`：`denial && action !== "minimize"`）——意味着**未授权的 app 也能被最小化**（设计意图是"移开挡路的窗口"，但这是权限面上的一个洞）。
7. **C# 助手命令面很宽**：`launch`（任意 target/URL）、`window_cmd`（任意 hwnd 的 close/minimize/maximize）、`clipboard_get/set`、`apps`、`text`、`ui`（`CuHelper.cs:283-305`）。好消息是它只监听自己子进程的 stdio、不开端口，没有网络攻击面；坏消息是**一旦有人能让这个 exe 跑起来（它是从 `%LOCALAPPDATA%` 里加载的无签名程序），就得到一个无认证的"任意启动 + 任意关窗 + 读剪贴板"工具**，权限等于当前用户。这不比一个普通脚本更危险，但也不该被宣传成"安全边界"。

---

## 6. 按 App 技能（helper/skills/）：完整设计，可直接照做

这是它最值得抄的机制，也是我们完全没有的一块。下面按"文件从哪来 → 怎么解析 → 怎么被选中 → 注入到哪 → token 预算"讲透。

### 6.1 文件从哪来：两层目录

- **内置**：随 npm 包发布的 `helper/skills/*.md`（`package.json` 的 `files` 白名单里有 `helper/skills/*.md`），运行时路径由 `helperAssetPath("skills")` 算出来（`index.js:9334` → `helperAssetPath` 在 `index.js:1344-1346`，从 `lib/` 往上找 `../helper/` 或 `../../helper/`）。
- **用户层**：`~/.dsh/computer-use-skills/`（可用 `DSH_HOME` 覆盖），见 `SkillStore` 构造函数（`index.js:2240`）。
- 同名（id 相同）时**用户文件覆盖内置**；用户文件里写 `extends: builtin` 则是"在内置正文后面追加"；写 `disabled: true` 则隐藏该内置技能（`index.js:2211-2225`、`2270-2296`）。

### 6.2 文件格式：YAML-ish front matter + Markdown 正文

`skills.d.ts:38-56` 的注释就是规格，`parseSkill` 是逐行正则解析（不是真 YAML 解析器）：

```
---
app: Obsidian
match: Obsidian, obsidian.exe
summary: 新建笔记、Markdown 打字规律
---
- 新建或打开笔记：ctrl+o ...
- 长文本直接用 type 输入 ...
```

- 键只认 5 个：`app`（显示名）、`match`（**逗号/中文逗号分隔**的别名列表，`2214-2224`）、`summary`（一句话，列表页展示）、`disabled: true`、`extends: builtin`（`2222-2223`）。
- front matter 可省略，省略时 `app` 用文件名（`parseSkill(text, fallbackApp)`，`index.js:2202-2213`）。
- 回写用 `formatSkill`，固定输出 `app/match/summary` 三行 + 可选 `disabled/extends`，正文 trim（`index.js:2227-2236`）；写入是 `tmp` 文件 + `renameSync` 原子替换（`index.js:2326-2335`）。
- id 归一化：`skillId(app)` = 小写、去 `.exe`、非 `[\\/:*?"<>|空白.]` 全部替换成 `-`、截断 60 字符（`index.js:2199-2201`）。

### 6.3 怎么被选中（不是只看进程名，也不是标题）

`SkillStore.find(name, win)` 三级回退（`index.js:2302-2306`）：

1. `skill.id === skillId(name)` —— 模型给的 app 名（`open_application` 的 `name` 或 `app_skill` 的 `app`）直接命中 id；
2. `skill.match` 里任一条归一化后等于该 id —— 别名命中；
3. 有窗口对象时，`skill.match` 里任一条 `appMatches(item, win)` —— **按窗口 exe 匹配**，且这里会过滤 `GENERIC_HOSTS`（`applicationframehost / explorer / msedgewebview2 / javaw? / python\\w* / electron`，`index.js:2198`），避免"所有 UWP 应用都命中同一个技能"。

`appMatches` 走的是 `ALIASES` + `exeNames`（`index.js:113-150`），所以"记事本"、"notepad"、"notepad.exe" 都能对上。**标题完全不参与匹配**。

### 6.4 注入到哪（关键，共 3 个入口 + 1 个"没接上"的）

**入口 A（主用）：`open_application` 的工具结果尾部**——每 session 每个技能只注入一次：

```
/** Skills already handed to a session, so each is attached once. */
const told = new Map();
function skillNote(session, name, win) {
  const skill = host.skills?.find(name, win && !isHostWindow(win) ? win : void 0);
  if (!skill) return "\n(No app skill for this app yet: ...record the reusable part with app_skill append...)";
  ...
  if (seen.has(skill.id)) return "";
  seen.add(skill.id);
  return `\n\nYour skill notes for ${skill.app} (app_skill; correct them if they turn out wrong):\n${skill.content}`;
}
```
（`index.js:8863-8874`，调用点在 `openApp` 的返回值里：`index.js:8860`）

也就是说：**技能正文走 tool result，不走 system prompt**，而且 `told` 是 `Map<sessionId, Set<skillId>>`，同一会话同一 app 只送一次。

**入口 B：`app_skill` 工具按需读**——`action: "read"` 返回 `Skill for X:\n{content}`（`index.js:9123-9126`），`list` 只返回 `"app — summary (N chars)"` 一行（`index.js:9117-9120`）。

**入口 C：AI 自己写回去**——`append`/`write`，`extra.match` 会在"当前前台窗口确实属于这个 app 且不是 ApplicationFrameHost"时把 `fg.exe` 记进 `match`（`index.js:9129-9133`），所以技能会越用越准。

**入口 D（写好了但没接线）：`catalog()`**——`skills.d.ts:52` 注释说"One line per skill for the system prompt"，实现也在（`index.js:2308-2311` 生成 `"app (summary); ..."`），但**全 bundle 里没有任何调用点**（只在 `2309` 有定义）。同理，`promptText()` 里完全不提具体有哪些技能（`index.js:2157-2175`），`apply()` 只注册了 `promptText(mode)` 这一节（`index.js:9491-9513`）。→ **README.md:31 "只放一行目录进系统提示" 在当前版本没有实现**；实际效果是"模型只有打开某 app 后才知道有技能"。这是照抄时要注意的第一点：**别抄这个断链，要么把 catalog 接进 systemPrompt，要么就承认它不存在**。

### 6.5 token 预算控制（4 条）

1. 单份硬上限 `SKILL_MAX_CHARS = 4000`（`index.js:2196`），`save()` 时算"新正文 + 内置正文 + 1"超了就抛错并提示"Condense it"（`index.js:2317-2318`）。
2. `summary` 截断 80 字符（`index.js:2325`）。
3. 每 session 每技能只注入一次（入口 A 的 `told`）。
4. 正文注入位置在 **tool result**（一次性的对话内容）而不是 system prompt（每次请求都带）——这是最省的放法。

### 6.6 10 份内置技能的实际体积与内容

| 文件 | 字节 | 主题（读自 front matter 的 summary） |
|---|---|---|
| powerpoint.md | 2816 | 建页、**原生公式**、动画与切换、插图、另存为、快捷键 |
| word.md | 1792 | （同风格：录入/格式/另存为/快捷键） |
| chrome.md | 1302 | 地址栏、标签、下载 |
| obsidian.md | 1227 | 新建笔记、Markdown 打字规律 |
| excel.md | 1220 | 单元格/公式/区域选择 |
| weixin.md | 1141 | 微信窗口与发送 |
| qq.md | 979 | QQ 窗口与发送 |
| typora.md | 904 | Markdown 打字/渲染 |
| explorer.md | 802 | 资源管理器/路径栏 |
| notepad.md | 770 | 记事本基础 |

合计约 **12.9 KB**（UTF-8 字节，含 front matter）。因为只在"打开该 app 时注入一次"，实际对话成本是"用到几个 app 就付几份"。

**obsidian.md 完整内容摘要**（全文 8 条，无删节要点）：
- 新建/打开笔记用 `ctrl+o` 快速切换（输入不存在的名字会直接创建），`ctrl+n` 新建无标题笔记；
- 笔记是库里的 `.md` 纯文本，写完可读文件核对——但**不要用写文件代替打字**；
- 长文本直接 `type`（按段落流式粘贴），`$...$`、`**粗体**`、标题按原文进入，不被自动补全打乱；
- 列表会自动续行：只第一项打 `- `，后续项直接写内容，连按两次 Return 退出列表；
- 标题（`## `）前留空行，否则可能和上一段粘连；
- `ctrl+f` 当前笔记内查找，`ctrl+Home` 回开头；
- 一整行快捷键清单：`ctrl+o/n/p/e/f/shift+f/b/i/k/w/Home/End/z/,`。

**powerpoint.md 的精华**（这份最能说明"技能的价值"）：
- 启动页点"空白演示文稿"，`ctrl+m` 新建幻灯片，正文框里 Tab / shift+Tab 升降大纲级别；
- **原生公式**：光标进文本框 → "插入"→最右"公式"(π) → 出现"在此处键入公式" → 用 `type` 输入**线性格式**（`dy/dx=-(F_x (x,y))/(F_y (x,y))`、`\sqrt(1-x^2)`、`\sum_(i=1)^n a_i`…）→ 点"公式"选项卡"转换"组里的"专业"；
- **明确写"不要输入 LaTeX 的 `\frac{}{}`"**（边打边被套格式会乱）、"`alt+=` 在本机不起作用，走功能区"；
- 动画：要选中**文本框本身**（在文字里按 Esc 直到四周出现控制点）才按段落加动画，加好后段落左侧出现 1/2/3 序号。

这就是"按 App 技能"的真正价值：**它记录的是"这个 app 的坑"，而不是任务内容**——正是模型靠截图永远学不到的东西。

### 6.7 照做清单（我们怎么落地）

1. 新文件 `src/skills.js`：`parseSkill` / `formatSkill` / `skillId` / `SkillStore{list,get,find,catalog,save,append,remove,reset}`，直接把 §6.2-6.5 的语义搬过来（约 250-350 行，可压缩到 150 行）。
2. 资产目录 `helper/skills/*.md`（我们已有 `src/win/` 这类资产目录习惯，放 `skills/*.md` 并在 `package.json.files` 里加上）。
3. 接注入：在"打开/聚焦窗口"那个工具的结果里追加正文（我们对应 `app_window{action:launch|focus}`，`src/tools.js:466` 起），配 `Map<sessionId, Set<skillId>>` 去重。
4. 接工具：新 `app_skill{action:list|read|append|write}`，`content` 超 4000 字报错。
5. **可选但推荐**：把 `catalog()` 真正接进 system prompt（用 `systemPrompt.section({ name, order, text })`，见 `notes/api-recon.md` §6），只放一行——这正好补上它没做的那一半。

---

## 7. 客户端 UI（client.js，1339 行）

### 7.1 它用了哪些 client 扩展点（全部）

| 扩展点 | 具体用法 | 出处 |
|---|---|---|
| 包声明 `dsh.client.inject` | 声明依赖 4 个 client 包：`dsh-client-connection` / `dsh-api-remotes` / `dsh-client-ui-settings` / `dsh-client-locale`，`platform: "web"` | `package.json` 的 `dsh.client` |
| `inject`（模块级） | `["slots", "remote", "remote.settings"]`，并 `exports.apply = apply` / `exports.inject = inject` | `client.js:1319-1337` |
| `ctx.slots.inject(name, register)` | `ctx.slots.inject("settings.section", () => ctx.slots.register({...}, render))` | `client.js:1327-1332` |
| `ctx.slots.register(meta, render)` | meta = `{ name: "settings.section", id: ENTRY_ID("copylee-computer-use"), order: 61, label: () => "电脑控制" }` | `client.js:1328-1332` |
| `ctx.effect(fn, label)` | 3 处：`installAccent()`、`registerNavIcon("电脑控制")`、`settings.section` 注册，都带 dispose 语义 | `client.js:1325-1327` |
| `ctx.remote.settings.describe()` | 读本插件的 Loader entry（读出 `writable`/`namespaces`/`revision`） | `client.js:934`、`client.d.ts:29-40` |
| `ctx.remote.settings.mutate(ns, ops, expectedRevision)` | 保存：把每个字段变成 `{op:'set', path:[key], value}`，带 `expectedRevision` 做乐观锁 | `client.js:1027` |
| `ctx.remote.$on("settings/document-updated", ns)` | 外部（别的插件/配置文件）改了设置就刷新 | `client.js:999` |
| 自建 HTTP 路由（fetch） | `GET /api/dsh-computer-use/status`（运行状态、显示器、截图尺寸）、`GET /preview`（3 秒光晕预览）、`GET /screenshots` + `POST /screenshots/clean`、`GET|POST /skills` | `client.js:442,683-687,955,964,976,1069`；host 侧 `webServer.register({kind:"exact",path,handler})`：`index.js:9459-9490`；路由常量与签名在 `routes.d.ts:1-20` |

另外两个"非正式扩展点"，是它自己说明的 hack：

- **设置导航图标**：`settings.section` 只带 `id/order/label`，shell 只给内置 id 配图标，所以它按 **label 文本**给导航行打 `data-dsh-computer-use-settings-nav` 属性，再用 CSS `mask` 把 Lucide `mouse-pointer-2` 的 SVG 贴上去（`nav-icon.d.ts:1-12`，`registerNavIcon(label)`）。
- **强调色跨插件共享**：一个存在浏览器里的选择（orange/blue/black），写成 `<body>` 上的两个 CSS 变量 `--cl-accent` / `--cl-accent-ink`，所有 copylee 插件只写 `var(--cl-accent)`；`accent.d.ts:1-14` 明说"这个文件在每个插件里都一样，改要一起改"。`AccentPicker` 是圆形色板（`accent.d.ts:36-45`）。

### 7.2 它在 web UI 里加了什么

1. **设置 → 电脑控制**一个完整 section（`client.js:677` 起）：运行状态（helper 就绪/错误、每块屏的分辨率/缩放/实际截图尺寸）、授权方式、禁止操控的应用、overlay 各开关、卡片透明度、截图三个参数、打字方式、快速步进、进程内 helper、强调色、截图缓存统计 + 一键清理、恢复默认、自动保存（带"有数值超出范围"提示与"重试保存"）。
2. **"预览效果"按钮**：调 `/preview` 让光晕和提示条显示 3 秒（`client.js:1067-1069`、host 侧 `previewRoute` `index.js:2544`）。
3. **应用技能卡片**（`skills-card.d.ts:1-10`）：列出/读/编辑/新建/删除技能，内置的可覆盖与恢复——对应 `/skills` 路由的 `save|delete|reset`（`routes.d.ts:17`）。
4. **导航图标 + 强调色**（见 §7.1）。
5. 自定义 `Select` 组件（`select.d.ts:1-30`），注释说明"菜单外观照 dsh-free-search / dsh-proxy"——跨插件抄来的样式。

### 7.3 我们值不值得补这块

**值得，但只值两小块，且要放在最后做。**

- **性价比最高：设置页的"运行状态/诊断"面板**。我们现在的失败模式（guard 触发、宿主意外死亡 fail closed、截图尺寸/缩放）全靠日志，用户报 bug 时我们要反复问。一个只读面板（`/status`）+ 一个"预览 overlay"按钮，能把排障往返砍掉一大半。工作量约 1 天（host 侧 1 个 route + client 侧 1 个 section）。
- **第二块：技能卡片**——但只有在我们抄了技能库（§9-1）之后才有意义，否则没有内容可编辑。
- **不建议**：强调色、导航图标这类纯装饰。我们已经有一套 overlay 视觉（`src/overlay/overlay.ps1`），再去改 DSH 主题变量是给自己加跨版本负担。特别注意 `nav-icon` 那个 hack 说明 **`settings.section` 的 meta 面很窄、图标要靠 CSS 猜**，这是最容易随宿主改版失效的地方。
- 风险提示：`client` 侧的 `remote.settings.describe/mutate` 契约我们还没实测过（`notes/api-recon.md` 只勘了 host 侧）。要做的话先按 `client.d.ts:12-40` 的最小接口写一个空 section 验证，再往里填。

---

## 8. 性能：它怎么压延迟

### 8.1 五个手段（按贡献排序）

1. **常驻助手进程**：`cu-helper.exe` 一次编译、长期存活，命令走 stdio 一行 JSON（`index.js:1425-1583`）；编译有 per-hash 缓存，只有首次约 1 秒（`README.md:39`、`index.js:1364-1398`）。启动成本被摊到整个会话。
2. **热路径搬进进程内（koffi worker）**：`displays/cursor/foreground` 恒走进程内，`screenshot` 在"没有卡片窗口"时也走进程内，`move/click/keys/...` 在"浮层未显示"时走进程内（`index.js:1631-1646`）——省掉一次进程间往返 + JSON 序列化。它的注释明说动机是"少一次 IPC、启动更快"（`README.md:99`；`native-helper.d.ts:1-12` 的类注释）。
3. **一次调用干多件事**：`computer_batch`（≤30 步，只回一张图）直接消灭 N-1 次模型往返（`index.js:8702-8785`）；`wait until` 把"等对话框出现"从"N 次轮询"变成"1 次"；`target` 让"还没出现在屏幕上"的控件也能在同一个 batch 里被点到（`target.d.ts:1-6`）。
4. **等"静止"而不是等固定时长**：C# 侧 `settle` 每 8 像素采样比画面（`CuHelper.cs:341-377`），`minMs=400 / quietMs=800 / maxMs=2500`（`index.js:864-876`、`index.js:2390`、`computer.d.ts:71`）；`waitForQuiet` 用同一机制（`index.js:844-862`）。
5. **省图省 token**：动作后画面与上一张"几乎一样"（`UNCHANGED_DIFF = 5e-4`，`index.js:686`）就**不发图**，只回一句"和上一张一样"（`index.js:765-774`、`8503-8506`）；`quickSteps` 在"本轮已进入操作态"时把 `reasoningEffort` 降到模型支持的最低档，并用 `retryMalformed` 兜住"不思考导致参数 JSON 写坏"（`effort.d.ts:1-30`、`index.js:2449-2500`、`index.js:9394-9412`）。

### 8.2 它公开的数字

**没有任何基准测试表**。能引用到的只有三处定性/单点数字：

- "首次使用时用 csc.exe 编译（约 1 秒，之后缓存）"（`README.md:39`）
- "开始操作电脑后……每一步快约 1 秒"（`README.md:95` 的 quickSteps 行）
- "扫描窗口 + 弹窗 cost a second or more on a file dialog"（`computer.d.ts` 的 `elements()` 注释，`lib/types/computer.d.ts` 中 `where` 参数说明段）

### 8.3 和我们比

我们的实测（团队记录）：**截图 153ms、200 次 `cursor` 平均 0.42ms**（PowerShell 常驻宿主 + 无编译、无子进程）。

| 维度 | copylee | 我们 |
|---|---|---|
| 冷启动 | csc 编译约 1s + 进程 spawn | 无编译，PowerShell 常驻宿主已起 |
| 单次光标查询 | worker 内 koffi `GetCursorPos`（同量级） | 0.42ms（实测） |
| 单次截图 | C# BitBlt + 缩放 + JPEG（跨进程或 in-proc） | 153ms（实测） |
| 模型往返次数 | batch / until / target / 自动截图 = **显著更少** | 每次动作一次往返 |
| token | 画面未变不发图 + JPEG q70 + `ui text` 替代截图 | 600k px JPEG q80 |

**结论（未证实部分已标注）**：单次调用延迟我们不吃亏（0.42ms 说明宿主往返已经很便宜，它多一层进程/worker 不会更快）；**但端到端"完成一个任务"的延迟它明显更优**，因为它的优化目标是"减少模型往返次数（每次几秒）"，而不是"减少单次调用毫秒数"——这点在它自己的提示词里写得很直白："what the user waits for is mostly the number of calls you make (each costs seconds)"（`index.js:2170`）。这条认知比任何微优化都值钱，也是我们 §9-3 要抄 batch 的原因。

---

## 9. 我们该抄的 3 件事（按性价比排序）

### 9-1 按 App 技能库（性价比最高）

- **抄什么**：§6 的整套机制——`helper/skills/*.md` 内置 + `~/.dsh/computer-use-skills/` 用户层 + front matter（`app/match/summary/extends/disabled`）+ "打开应用时把正文追加到工具结果、每会话一次" + `app_skill` 工具（list/read/append/write）+ 单份 4000 字硬上限。**并且修掉它的断链**：把 `catalog()` 真正接进 system prompt（只放一行）。
- **改哪些文件**：新增 `src/skills.js`（约 150-250 行，`parseSkill/formatSkill/skillId/SkillStore`）；`src/tools.js` 里在 `app_window{action:launch|focus}` 的结果尾部追加技能正文，并新增 `app_skill` 工具；`src/index.js` 注册 `app_skill` 与 `systemPrompt.section`；新增资产目录 `skills/*.md`（10 份中文技能，可从竞品改写但要自己复核，尤其 Office 部分）。
- **工作量**：代码 1.5 天；10 份技能文档 1.5-2 天（这是主要成本，也是主要壁垒）。
- **风险**：(a) 技能会随 App 版本过期 → 必须允许"AI 发现记错就改写"并且用户在 UI 里能改；(b) 注入位置若放 system prompt 会每轮付费，所以正文只能进 tool result，system prompt 只放目录行；(c) 要防"技能里被写进任务内容/密码/个人数据"——它的 `app_skill` 描述里明确禁止（`index.js:9088`），我们应在 `save()` 里做一次简单校验（比如拒绝包含疑似密码/长数字串，至少给告警）。

### 9-2 按应用授权 + DSH 原生审批（安全性收益最大）

- **抄什么**：`AccessControl`（per-session grants + `denial()` 的一句话拒绝理由）+ `request_access` 工具 + `tools/pre-execute` 里返回 `{kind:"ask", displayReason:{en, "zh-CN"}}` 的审批接线 + `HOST_EXES` 硬拒 + 密码管理器默认黑名单 + `ALIASES` 中英别名表。**注意它的洞别抄**：不要实现"autoApprove 下模型点名就自动 grant"（`index.js:8821-8822`）。
- **改哪些文件**：`src/runtime.js`（加 `AccessControl`，在 `MUTATING_ACTIONS` 执行前按"目标窗口 exe"判定）；`src/tools.js`（新 `request_access` 工具；在 `app_window`、`computer` 的 mutating 分支前调用 denial）；`src/index.js`（注册 `tools/pre-execute` 审批钩子，按 `notes/api-recon.md` §4 的 `{kind:"ask"}` 契约）。
- **工作量**：1-1.5 天（我们已经在 §4 勘过审批 API，不需要再探）。
- **风险**：(a) `approval.effectivePolicy === "never"` 的会话会把审批直接放行，要在提示里讲清"完全权限 = 不再问"；(b) `HOST_EXES` 要按我们宿主的真实 exe 名核实（它是 `"deepseek harness.exe"`，Electron dev 模式可能是 `electron.exe`）；(c) 别名表是脏活，先抄它那 70 行（`index.js:24-94`）再迭代。

### 9-3 `computer_batch` + `wait until` + `target`（体验提升最大）

- **抄什么**：① 批量动作（一次调用 N 步、只回一张图、失败即停并汇报已完成到第几步）；② `wait until: "window:<片段>" / "target:<控件名>"`（条件等待，窗口或控件出现/消失即返回）；③ `target`（用控件可见名代替坐标，含 `normalizeName` 去 `&`/`(S)`/省略号、`parseTarget` 认 `"按钮:保存"`、`matchTarget` 三级匹配 **精确 > 前缀 > 包含**，同档优先 enabled/真实控件，仍有多个就报 ambiguous 并列出候选 —— `target.d.ts:1-40`、`index.js:497-589`）。
- **改哪些文件**：`src/tools.js`（新 `computer_batch`；`computer` 的 `wait` 加 `until`/`gone`，动作加 `target`）；`src/runtime.js`（`waitUntil` 轮询 + `locate` 重试 3 秒 + `matchTarget` 复用我们已有的 `ui_element find` 结果）。
- **工作量**：2-3 天。
- **风险**：(a) `target` 是模糊匹配，**误点风险**高于我们现有的 accessibility path `invoke`；必须保持"ambiguous 直接报错、绝不猜"，并且 `target` 解析出的点仍要走 `checkPointer`/审批；(b) batch 会把 30 个动作压进一次调用，中间出错的可观测性差 → 必须像它一样回"已完成/剩余被跳过 + 一张最新截图"（`index.js:8773`）；(c) `until` 要设硬超时（它 `duration` 默认 10s，`index.js:8657`）。

---

## 10. 我们比它强的 3 点

### 10-1 图片预算与坐标系对齐（最关键，直接影响"点得准不准"）

我们 `maxPixels: 600000`（`src/runtime.js:32`）**落在 DSH 请求侧 640,000 预算之内**，一次缩放到底；文本信封同时回显"图像空间尺寸 / 物理捕获矩形 / scale"（`src/runtime.js:488-489`）。它默认 `maxPixels: 115e4`、`maxLongEdge: 1366`（`index.js:2390-2391`），1080p 屏出来就是 1.05MP，超出请求预算 64%，必然被 DSH 再缩一次，而它的信封只回显缩放前的尺寸（`index.js:8596`）、全库也没有任何请求预算相关代码（§4.3 的 grep 证据）。→ **默认配置下我们是"一次缩放、显式告知"，它是"两次缩放、不告知"**。

### 10-2 安全上的 fail-closed（`APPROVAL_UNAVAILABLE`）vs fail-open+提示词

- 我们：需要审批的部署里，审批服务不可用就硬拒（`src/runtime.js:414` 抛 `APPROVAL_UNAVAILABLE`）；Esc guard 有独立守护进程（`src/overlay/guard.mjs`），宿主意外死亡也 fail closed。
- 它：审批只覆盖 `request_access` 一个工具（`index.js:9360-9378`），**动作本身不需要审批**；"发消息/删除/购买先问用户"只写在 system prompt 里让模型自律（`index.js:2173`）；Esc 依赖 C# 键盘钩子，进程内输入路径没有这一层（§5.5-3）。→ 同样是"有人按了 Esc / 审批不可用"，我们的行为是**拒绝执行**，它是**尽量继续**。

### 10-3 零打包风险 + 源码可读

- 我们：`src/` 4 个可读文件 + 零 npm 运行时依赖，`src/index.js` 4.5KB、`src/runtime.js` 25KB、`src/tools.js` 48KB，改一行就看得到效果。
- 它：391KB 的 bundle 里 **5600+ 行是从未发布的 DSH SDK 内联进来的**（`defineTool` 在 `index.js:5677`、`ToolRuntime` 在 `index.js:7447`、`LlmError` 在 `index.js:4115`……），只把 `cordis`/`schemastery` 留作 external（`index.js:1-13`），而 `package.json` **没有 `dependencies` 字段**；npm 包里也**不含 `src/`**（`files` 白名单）。→ 宿主升级后它是"用旧 SDK 的副本跟新宿主说话"，我们是"直接调宿主现成 API"。
- 附带一条：我们的 `ui_element` 用 accessibility path 直接 `invoke`（`src/tools.js:625-656`），**不点像素**；它的 `target` 最终仍是"算出中心点然后 `SendInput` 点一下"（`index.js:1041-1078`）。对按钮被遮挡/半透明的场景我们更不易点错。

---

## 11. 它踩的坑 / 可疑处（都有出处）

1. **内联了整份 DSH SDK，且没有 `dependencies` 字段**：`index.js:5677`（`defineTool`）、`index.js:7447`（`ToolRuntime`）、`index.js:4115`（`LlmError`）等约 5600 行 SDK 被 tsdown 打进来；`package.json` 只有 peerDependencies（全 optional）与 devDependencies。→ 插件与宿主 SDK 的**版本漂移**风险全在作者身上；`index.js:4065` 还 `createRequire(import.meta.url)("../package.json")` 读自己的 version，说明打包过程对版本敏感。
2. **`catalog()` 是死代码（README 与 d.ts 注释都在吹的功能没接线）**：`skills.d.ts:52` 注释"One line per skill for the system prompt"、`index.js:2308-2311` 实现了，但**全文件无调用点**；`promptText()`（`index.js:2157-2175`）里也没有技能目录。README.md:31 说"只放一行目录进系统提示"——**当前版本不成立**。
3. **README 的工具表漏了一个工具**：`list_granted_applications` 出现在 `access.d.ts` 的注释与 README.md:79，但 `createTools` 里**没有**这个工具（`index.js:8678-9145` 只有 9 个）。→ 文档与实现不同步。
4. **helper 崩溃后 overlay / Esc 钩子可能不再重建**：`OverlayController.visible` 是缓存布尔（`index.js:1921-1947`，只有 `!visible` 才调 `overlay_show`），helper 退出只清 pending 不通知 overlay（`index.js:1541-1549`）。helper 重启后 `begin()` 会走 `status()` 分支 → 光晕与键盘钩子不会重建（**未证实**，但代码路径支持）。
5. **大量 `catch {}` 吞错**：`SkillStore.load` 对坏 md 直接 `catch {}`（`index.js:2265`）→ 用户写坏一份技能文件，技能静默消失且没有任何日志；overlay 相关调用普遍 `.catch(() => {})`（如 `index.js:1924, 1944, 1951, 1963, 8890`）与 `9323` 的清理失败日志。→ 排障时"没有错误"是常态。
6. **小内存泄漏**：`told`（每 session 的已注入技能集）永不清理（`index.js:8864-8871`）；`visionCache`（`index.js:9292`）与 `lowest`（`index.js:9380`）按 `provider\0model` 无限增长。量级小，但会话/模型多了会慢慢涨。
7. **`minimize` 绕过授权**：`denial && action !== "minimize"`（`index.js:8935`）——未授权 app 也能被最小化。设计意图可理解（移开挡路窗口），但它是权限模型里唯一一个明写的例外。
8. **剪贴板是长文本输入的中转站**：stream/paste 全程 `clipboard_hold → paste → release`（`index.js:1243-1263`）。若进程在此期间被杀，`clipboard_hold` 的"暂停历史记录 + 之后 restore"可能残留（**未证实**，需要看 `CuHelper.cs:280-282` 的 Clip 实现细节）。
9. **单次调用可占用 30 分钟**：`computer`/`computer_batch`/`open_application` 的 `timeoutMs` 都是 `18e5`（30 分钟，`index.js:8686, 8733, 8801`），batch 最多 30 步（`index.js:8740`）；而暂停保护上限是 25 分钟（`MAX_PAUSE_MS`，`index.js:1822`）→ 两者不匹配，用户在长 batch 中暂停超过 25 分钟会拿到一条"暂停太久"的错误而不是继续。
10. **最该警惕的一处：截图缓存清理器会删文件**。`ScreenshotCache.clean()` 扫描 DSH 的会话状态、按 zstd 帧解出附件 id（`screenshots.d.ts:1-50`、`index.js:2699-2930`，含 `decodeFrames`/`collect`/`walk`），删掉"没人引用"的截图；启动 2 分钟后跑一次、之后每 12 小时一次（`index.js:9320-9333`）。而 README.md:105 自己承认"删掉仍被会话引用的截图会让该会话无法继续"。→ **一个解析器 bug 就可能造成用户会话损坏**（未证实实现有 bug，但这是全插件破坏性最强的代码路径，且它解析的是 DSH 的**内部存储格式**，跨版本极易失效）。
11. **平台/环境假设很硬**：仅 `win32`（`index.js:9278-9281`）、需 .NET Framework 4 的 `csc.exe`（`index.js:1351-1358`，缺了直接抛错）、需 DSH 安装目录下的 `koffi.node` 且路径写死为 `app.asar.unpacked/dsh/node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node`（`index.js:1591-1592`）、SAC 环境下靠 `powershell.exe` 加载（`index.js:1489-1511`）。DSH 一改打包布局，进程内路径就整体失效（会静默回退 C#，`index.js:1688-1695`）。
12. **进程内路径自称 "Spike"**：`native-worker.js:6` 的注释原文是"Spike: part of the helper's command set done in-process through koffi"，但它**默认开启**（`DEFAULTS.nativeHelper: true`，`index.js:2398`）。→ 一个实验性实现被当成默认路径发布，这是它最典型的"打包产物领先于工程质量"的迹象。

---

### 附：本次阅读的边界

- `lib/index.js` 未通读：按 `//#region` 分区 + 关键符号定位，读了插件自身逻辑的绝大部分（access / coords / keys / target / text / Computer / helper-client / koffi-path / native-helper / overlay / prompt / skills / settings / effort / routes / tools / apply），以及 SDK 内联部分的边界与关键类。**SDK 内联区（`index.js:2950-8500`）只看了类名与用途，未逐行审。**
- `CuHelper.cs` 读的是命令分派表 + 截图/DPI/缩放/JPEG/Magnification/SendInput 标记/采样比对的片段（约 40 处定位），未通读 2838 行。
- 以下结论标注为**未证实**：§4.3 的"二次缩放必然发生"（依赖我们 `api-recon.md:589-596` 的实测常量，未在本机跑过该插件）、§5.5-3/4、§11-4/8，以及 §8.3 的端到端延迟对比。

