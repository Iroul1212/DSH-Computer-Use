# 竞品分析：`dsh-computer-use-win@0.5.3`（作者 Yu-tao-Li，★276）

> 阅读对象：`_reference\dsh-computer-use-win\package\`（30 文件，只读）。全部为可读源码，**没有** minify/不可读产物。
> 为了回答「MCP 的 image content 能不能进 DSH 附件管线」这一条，额外读了宿主安装目录里的
> `@deepseek-ai/dsh-mcp-client@0.1.5-rc.3`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-llm-deepseek`
> （`C:\Users\lizhen\AppData\Local\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\`，只读未改）。
> 下文中 `mcp-client:` = 该包的 `lib/index.js`，`dsh-tools:` = `dsh-tools/lib/index.js`，`llm-deepseek:` = `dsh-llm-deepseek/lib/index.js`。

## 1. 一句话定位 + 能力清单

**一句话**：它不是原生 DSH 插件，而是「一个独立可用的 MCP stdio server（自己再拉起一个常驻 PowerShell + UIA 后端）」+「一层 159 行的 cordis 适配器把它挂到 `dsh-mcp-client` 上」；卖点是 **25 个细粒度工具** + **浏览器 CDP 后台通道** + **一整套 Windows 桌面级安全网（overlay / Esc / 角标急停 / 点穿透校验 / 窗口身份校验）**。

代码体量分布（读这 30 个文件之前先有这个地图）：

| 层 | 文件 | 行数/大小 | 说明 |
|---|---|---|---|
| MCP server | `mcp\server.mjs` | 71 KB | 工具定义 + 25 个 handler + 后端调度 + 浏览器分流 |
| 后端（核心资产） | `scripts\windows-uia.ps1` | **3491 行 / 186 KB** | UIA 树、截图三级降级、OCR、输入、安全断言 |
| 原生辅助 | `scripts\windows-takeover.cs` | 41 KB | overlay 指示窗 + 低级键盘钩子 Esc |
| 浏览器通道 | `mcp\browser.mjs` 等 3 个 | 121+37+10 KB | CDP 直连 Chromium，独立 profile |
| DSH 适配器 | `mcp\dsh-plugin.mjs` | 159 行 | 只做 bridgeConfig + settings 热更新 |
| DSH 客户端 UI | `mcp\client.js` | 650 行 | 设置页 / 指示器 |
| 文档 | README 66 KB×2 + `docs\dev-notes.md` 33 KB + `CHANGELOG.md` 66 KB + 9 篇 wiki | | 工程笔记质量异常高，性能数字都写在这里 |

### 25 个工具（`mcp\settings.mjs` 的 `TOOL_NAMES` 一处定义，逐个挂载于 `mcp\server.mjs`）

| # | 工具名（`mcp__wincu__` 前缀去掉） | 作用面 | 出处 |
|---|---|---|---|
| 1 | `health` | 后端/截图/输入栈自检 | server.mjs:140 |
| 2 | `snapshot` | 图 + UIA 树（一次拿全） | server.mjs:145 |
| 3 | `accessibility_tree` | 只读树 | server.mjs:176 |
| 4 | `list_windows` | 顶层窗口枚举（含浏览器标签） | server.mjs:194 |
| 5 | `find` | 按 name/automationId/class/value/type 找元素，空结果可 OCR 兜底 | server.mjs:206 |
| 6 | `element_info` | 按 id 或**屏幕坐标**反查元素 | server.mjs:228 |
| 7 | `click` | 坐标或元素中心；`dispatch:auto` 后台/前台自动选 | server.mjs:244 |
| 8 | `double_click` | 同上 | server.mjs:261 |
| 9 | `move` | 移指针 | server.mjs:278 |
| 10 | `drag` | 沿路径拖动 | server.mjs:293 |
| 11 | `scroll` | 元素后台滚（WM_VSCROLL）或坐标滚轮 | server.mjs:319 |
| 12 | `type_text` | 输入文本，`method:auto` | server.mjs:337 |
| 13 | `keypress` | 单键/组合键（Windows 键被拦） | server.mjs:354 |
| 14 | `focus` | 把焦点给元素 | server.mjs:373 |
| 15 | `invoke` | 后台调用：BM_CLICK → Invoke/Toggle/Select | server.mjs:387 |
| 16 | `set_value` | 后台赋值：EM_REPLACESEL → ValuePattern | server.mjs:403 |
| 17 | `activate_window` | 前置窗口（按标题/pid/HWND） | server.mjs:420 |
| 18 | `wait` | 固定等待 | server.mjs:429 |
| 19 | `ocr` | `Windows.Media.Ocr`，独立于 UIA | server.mjs:440 |
| 20 | `screenshot` | 只截图不查 UIA，返回 bounds + imageScale | server.mjs:459 |
| 21 | `wait_for` | 等窗口/元素/OCR 文本出现或消失 | server.mjs:469 |
| 22 | `close_window` | WM_CLOSE（不 kill） | server.mjs:492 |
| 23 | `move_window` | 只移动不激活 | server.mjs:501 |
| 24 | `launch_app` | 起 exe/lnk/已安装应用 | server.mjs:129 |
| 25 | `tools` | 懒加载管理入口：enable/disable/list/describe/reset | server.mjs:572-597 |

外加两条**可切换的加载方案**：`lite`(10 项) / `lazy`（启动只注册 `tools`，靠模型自己 enable）——`mcp\settings.mjs` 的 `LITE_TOOL_NAMES`、`server.mjs:569-590`。
浏览器通道不是新工具名，而是给上述工具加 `browserTab` 参数走 CDP（`server.mjs:957`、`docs\wiki\architecture.md`）。

## 2. 为什么用 MCP 而不是原生插件

### 2.1 它的 `package.json` 怎么声明

两者都声明了，但**不是**「要求用户手配 MCP server」：

- `"main": "mcp/dsh-plugin.mjs"`（package.json:9）+ `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`（package.json:31-33）
  → 它是**正规的 DSH bundle 插件**，`dsh plugin add dsh-computer-use-win` 就能装（README.md:350）。
- `"bin": { "wcu-mcp": "mcp/server.mjs" }`（package.json:6-8）→ 同一个 server 也能裸喂给任何 MCP 客户端。
- `"peerDependencies": { "@deepseek-ai/dsh-mcp-client": ">=0.1.0-rc.2 || >=0.2.0-rc.2" }` 且标记 `optional`（package.json:94、101）
  → 桥是**运行时动态 import** 的硬依赖，缺了就整条插件起不来。
- `cordis.patch.yml` 只做一件事，插一个条目：

```yaml
- insert:
    - id: mcp-dsh-computer-use-win
      name: 'dsh-computer-use-win'
      config:
        mode: full
```
（cordis.patch.yml:12-16）

### 2.2 桥接配置长什么样

适配器就 159 行，核心是 `bridgeConfig()` + `ctx.plugin(bridge, ...)`：

```js
serverName: 'wincu', transport: 'stdio', command: process.execPath,
args: [fileURLToPath(new URL('./server.mjs', import.meta.url))],
env: { ELECTRON_RUN_AS_NODE: '1', WCU_ENABLED_TOOLS: JSON.stringify(enabledToolsForSettings(settings)), ... },
toolCallTimeoutMs: config.toolCallTimeoutMs ?? 90000,
failOnStartupError: config.failOnStartupError ?? false
```
（dsh-plugin.mjs:74-82；`apply` 里 `const bridge = await import('@deepseek-ai/dsh-mcp-client')` 在 dsh-plugin.mjs:85，
`ctx.plugin(bridge, bridgeConfig(...))` 在 dsh-plugin.mjs:156）

即：**DSH 宿主 → (cordis 子插件 dsh-mcp-client) → node 子进程 `server.mjs` → powershell 常驻后端**。
工具在模型侧显示为 `mcp__wincu__<tool>`（cordis.patch.yml:5-6 自己写明）。

### 2.3 代价（逐条，含实测/推断标注）

**① 进程数**：热路径**多 2 个常驻进程**（node-Electron 的 MCP server + 一个 `powershell -Persistent`，server.mjs:691-701）；
一开始动作还要再起 **1 个 WinForms 进程**做 overlay+Esc（takeover.mjs:157-159）；
一旦碰浏览器通道，再起**整只 Chromium**（独立 `--user-data-dir`）+ 一个 watcher node（browser.mjs:817、850）。
我们：DSH 宿主内一个 JS 模块 + 一个常驻 PS 宿主，热路径就这 2 个。内存增量未实测，标注**未证实**。

**② 启动延迟**：后端首个调用 cold ~500ms（`docs\dev-notes.md:101`），**这还没算** MCP server 进程启动 + stdio 握手 + 桥注册工具定义（无单独计时，**未证实**）。
另外改设置要**重启 MCP server**：`connection.update(bridgeConfig(...), true)`，并且要等当前动作做完，最长等 65 秒（dsh-plugin.mjs:114-124）。

**③ 错误传播**：PS 侧结构化错误 `{ok:false, error, category, scriptStackTrace}`（windows-uia.ps1:3454-3461）→ server 转成 `isError:true` 的文本 → 桥 `throw new Error(text)`（mcp-client:262-273）→ ToolRuntime 兜成 isError 结果。**结构化字段全部塌成字符串**，模型只能读到一行 message + 塞在里面的 stack。

**④ 图片怎么回传 —— 这是你最想知道的，结论是：能进附件管线，但有 5 道门，且失败是静默降级成一行文本。**

证据链（都在宿主实现里，已确认）：

1. server 发标准 MCP image block：`content.push({ type:"image", data: result.screenshot.base64, mimeType:"image/png" })`（server.mjs:728、971、1027）。
2. `dsh-mcp-client` **有专门**的图片投影路径，不是丢弃：`containsImage(content)` → `prepareImageProjection(ctx, exec, content, rawName)`（mcp-client:278-289）。
3. 最终**真的**落到 DSH 附件存储：`const refs = await attachments.saveImages(decoded)`，并把原 block 换成 `{ type:"image", attachment: ref }`（mcp-client:377-382）。
4. 输出的 block 通过 `finalizeContent` 在 render 之后替换进来（mcp-client:211-219；`dsh-tools:`3275-3277 在 render 后应用 finalizer）——所以桥自己的 render 只吐纯文本也不影响发图：

```js
render(_args, value) { return [{ type: "text", text: extractText(value.content, rawName) }]; }   // mcp-client:237-243
finalizeContent(exec, result) { ... return projection.content; }                                  // mcp-client:211-219
```

5. **5 道门**（任一不过 → 图变成一行字，不报错、不中断）：

| 门 | 出处 | 不过时的样子 |
|---|---|---|
| `attachments` 服务必须在 | mcp-client:322-324 | `[image unavailable: image/png; no attachment store is mounted; ...]` |
| 当前路由 `inputModalities` 必须含 `image` | mcp-client:330-337 | 同上，reason 换成 `model "x" does not declare image input` |
| mime 只能是 png/jpeg/webp/gif | mcp-client:78-82、307 | `the declared media type is not PNG, JPEG, WebP, or GIF` |
| base64 必须是 canonical | mcp-client:308-310 | `the image data is not canonical base64` |
| 过 `saveImages` 准入（像素/字节上限） | mcp-client:377、384-387 | `durable image storage rejected the result` |

降级文本模板就在 mcp-client:341-343：
`[image unavailable: ${mime}; ${reason}; raw image data remains available to programmatic callers]`

**结论（写进我们的结论）**：MCP 不是「技术上不能发图」，官方的桥已经做完了 MCP image → DSH 附件的转换；
但代价是 **① 多一跳 base64（PS → server JSON → stdio → 桥 decode → 重新 saveImages）② 五道门里任何一道都让图静默变文本 ③ 插件拿不到最终图，坐标契约必然错位（见 §4）④ `render()` 被桥写死，插件没法自己排版结果信封**。

**⑤ 审批**：不能说「MCP 用不了审批」，准确说法是——

- 审批是宿主 seam，**对所有工具一视同仁**：所有工具调用都过 `tools/pre-execute` waterfall（dsh-tools:3116）和 `tools.guard()` 单调守卫（dsh-tools:2816-2830），MCP 桥来的工具也一样。
- 但「什么时候 ask」来自用户配的 hooks（`dsh-hooks-claude-code` / `dsh-hooks-codex` 的 PreToolUse matcher 按工具名正则匹配，能匹配 `mcp__wincu__*`），**默认一个 ask 都没有**。
- 插件本体**完全没有**自己的审批语义：`mcp\*.mjs` 里 `elicit|confirm|approv` 只有 6 处命中，全部是浏览器 `alert/confirm` 对话框与 `close_window` 的措辞，没有一处审批。
- 我们不一样：`requireApproval:'mutating'` + `ctx.approval.request()`（src\runtime.js:378-379、403-424），能在**动作内部**按语义要一次确认。

**⑥ 拿不到的能力**：`ctx.attachments`（直接）、`ctx.approval`（自己的语义）、`render()` 排版、以及工具的 `output.schema`（桥统一成 `{content, structuredContent}`，mcp-client:223-244）。

## 3. 工具面 vs 我们（逐个对比）

先纠正一个口径：我们不是「4 工具 14 action」，`14` 是 `computer` **一个**工具的动作数；总动作面是 **4 工具 / 31 action**
（`computer`:14 = screenshot/cursor/move/click/double_click/right_click/middle_click/drag/scroll/type/key/wait/resume/status，src\tools.js:108；
`app_window`:7 list/focus/launch/close/minimize/maximize/restore，src\tools.js:466；
`ui_element`:8 tree/find/invoke/set_value/focus/expand/collapse/select，src\tools.js:656；
`clipboard`:2 get/set，src\tools.js:821）。

| 能力 | 它 | 我们 | 判断 |
|---|---|---|---|
| 工具数 | **25**（24 桌面 + `tools` 懒加载入口） | 4 | 它多，但上下文代价见 §9 |
| 动作粒度 | 一工具一动作（click/scroll/type 各自一个） | 一工具多 action | 我们省 context，它省了「选错工具」的概率 |
| UIA 树 | `accessibility_tree` / `snapshot` / `find` 深搜 | `ui_element action:tree/find` | **持平** |
| 树裁剪 | maxNodes + 时间预算 + 浏览器版式层折叠（windows-uia.ps1:1693-1730） | 时间预算 + truncated 标记（win-host.ps1:1338-1351） | 它更细（有 maxNodes/去重/折叠） |
| 按坐标反查元素 | `element_info`（elementId 或 **x,y**） | 无 | **它独有**，调 UIA 时很有用 |
| 后台操作（不抢前台） | `invoke`(BM_CLICK)/`set_value`(EM_REPLACESEL)/`scroll`(WM_VSCROLL)/PostMessage click（windows-uia.ps1:1157-1204） | 无，全部走真实输入 | **它独有**，是"不打断用户"的关键 |
| **OCR** | `Windows.Media.Ocr`，词框 + `wait_for` 文本条件（windows-uia.ps1:1256-1379） | **无**（`Media.Ocr` 0 命中） | **它独有** |
| 剪贴板 | 无工具（只在 safety.md 提到风险） | `clipboard get/set`（src\tools.js:815-821） | **我们独有** |
| 多屏 | 桌面抓 = 整块虚拟屏；窗口抓按 HWND | `screen` 索引 + `region` + `hwnd`（src\tools.js:131-136） | 各有取舍：它一张图看全部，我们按屏取更省像素 |
| 窗口绑定 | 标题/pid/HWND 三选一 + **身份漂移守卫** + 移动补偿（windows-uia.ps1:1046-1110） | `app_window focus` + hwnd 抓图，无身份校验 | **它更稳** |
| 批量动作 | 无真批量；`tools enable names:[...]` 只是批量加载工具 | 无 | 平 |
| 条件等待 | `wait_for`（窗口/元素/OCR 文本出现或消失） | `wait`（固定等待） | **它独有** |
| 截图兜底 | 三级：screen-region → PrintWindow → **WGC**（UWP/WinUI 黑屏兜底） | PrintWindow → 黑图检测 → 退回 screen 抓取（win-host.ps1:623-640、718-795） | **它更全**；我们缺「黑屏时告警/换引擎」 |
| 网页 | 独立 **Browser lane**（CDP 直连、独立 profile、后台操作、可保持登录） | 无（只当普通窗口点） | **它独有**，但也是它最大的攻击面 |
| 工具加载策略 | full/lite/lazy/custom + 每工具开关 + 设置页 UI | 固定 4 个 | 它工程化更完整（也带来 settings 热更新的一堆复杂度） |

**结论**：真正缺的硬能力只有三样 —— **OCR、后台输入（BM_CLICK/EM_REPLACESEL/PostMessage）、UWP 黑屏兜底**；
「按坐标反查元素」「wait_for」「窗口身份校验」属于**便宜的可靠性增量**；浏览器通道是另一个产品面，不建议跟进。

## 4. 截图与坐标

### 4.1 它怎么截

三级降级，越往后越贵：

1. **screen-region**：先做「前台 + Z 序 + 几何」三项检查，通过才敢用屏幕裁剪，并回报 `occludedPossible`（windows-uia.ps1:2166-2221、2245-2265）。
2. **PrintWindow(PW_RENDERFULLCONTENT=2)**：窗口不在前台也能抓自己的表面（:2189-2202）。
3. **Windows Graphics Capture**：注释直说「PrintWindow 对 UWP/WinUI/DirectComposition 会渲染成纯黑」，于是另起 WinRT 抓帧（:1406-1535、:2272-2290）。这是它最硬的一块工程。

输出**永远是 PNG**，先落 `%TEMP%\windows-computer-use-*.png`，再读回来转 base64，30 分钟自动 GC（:2226-2228、2343-2350）。
尺寸只由 `maxWidth` 控制，**默认 1600**（server.mjs:465，`maximum: 7680`），**没有任何像素/字节上限**；官方自己测到「全屏 3.8 MB → 窗口裁剪 91 KB」（docs\dev-notes.md:106）。

### 4.2 它怎么把坐标和模型看到的图对齐 —— **这里有个大口子**

它的契约是纯算术，交给模型自己算：

```
screen = bounds.origin + image_px / imageScale
```
（server.mjs:460、540、docs\wiki\mcp-tools.md:27）

`imageScale` = `插件产出图的宽 / 原始物理宽`（windows-uia.ps1:2327-2354），点击接口只接受**物理屏幕坐标**（`Get-PointFromArgs`，:1825-1840）。

问题在于：**`imageScale` 是对"它自己那张 PNG"成立的，而模型看到的不是那张图。**

- 宿主请求侧会把每张图压到 `imagePixelBudget`，默认 `64e4`（`llm-deepseek:`463：`maxPixels: model.imagePixelBudget ?? 64e4`）。
- 默认窗口抓 1600×900 = **1,440,000 px**，是预算的 2.25 倍 → 模型实际看到的约 1067×600。
- 模型读图上的像素点、按 `image/imgScale` 换算 → **系统性偏小约 1.5 倍**；只有当目标窗口宽度 ≲1000 px 时才恰好对上。
- 全仓库（README/README.en/docs×9/CHANGELOG/mcp 源码）搜 `64e4|640,000|pixel budget|imagePixelBudget|request-side` **0 命中** —— 它根本不知道这一层存在。

> 判定：**这条未做端到端实测（未证实具体偏差倍数随窗口大小变化），但代码链是闭合的**：插件报告 scale ↔ 宿主二次缩放 ↔ 模型按插件 scale 换算。这是我们相对它最实的一个优势。

### 4.3 DPI

它做得对，而且踩过坑并写下了症状：

```powershell
# DPI awareness MUST be set before any GDI+/WinForms assembly is loaded:
# ...GetSystemMetrics then returns virtualized 150%-scaled values like 3414x960
# instead of physical 5120x1440.
$ok = [WindowsComputerUseNative]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))  # Per-Monitor V2
```
（windows-uia.ps1:440-454、480-486）

我们同级：`SetProcessDpiAwarenessContext(-4)` + `PER_MONITOR_AWARE_V2`（win-host.ps1:283-298），smoke 实测 `dpi=PER_MONITOR_AWARE_V2`（test\out\smoke.log:4）。

### 4.4 谁更稳

**坐标我们更稳。** 三层一致：截图默认 `maxPixels: 600000 < 640000`（src\index.js:32）→ 交付图几乎不会被请求侧再缩 → 点击时用 `view.capture.x + x / view.scale` 精确反算（src\runtime.js:592-593），并在信封里同时给出"图空间"和"物理空间"两套数（src\runtime.js:488-492）。
它的 DPI 与截图引擎比我们强，但**像素预算这一环是断的**，属于"越努力截高清图，坐标越容易错"的反向优化。

## 5. 安全模型

### 5.1 它有的（都是硬机制，不是提示词）

| 机制 | 行为 | 出处 |
|---|---|---|
| Overlay 指示窗 | TopMost、不占任务栏、按显示器/DPI 变化重定位 | windows-takeover.cs:361、501；CHANGELOG.md:96 |
| Esc 全局急停 | 独立 WinForms 进程 + 低级键盘钩子（`SetWindowsHookEx(13)`），命中 `vk==0x1B` 即取消整个系列 | windows-takeover.cs:150、312-315 |
| 自定义停止快捷键 | `stopShortcut` 有正则校验的配置项 | dsh-plugin.mjs:31、settings.mjs 的 `STOP_SHORTCUT_PATTERN` |
| 系列级屏蔽 | `blockedSeries` 按 `[sessionId, turn]` 持久化"这一轮被停了"，下轮才恢复 | takeover.mjs:57-58、66-67 |
| 角标急停（EMERGENCY STOP） | 指针停在虚拟屏左上角 12px 内满 500ms → 之后所有输入直接抛错 | windows-uia.ps1:1112-1150 |
| 点穿透校验 POINT_COVERED | 目标点上是别的窗口 → 一个事件都不发 | windows-uia.ps1:830-844 |
| 窗口身份漂移 identity_changed | 标题同名但 HWND/PID 变了 → 拒发 | windows-uia.ps1:1068-1110 |
| 前台借还 + 弹窗检测 | 用完把前台还给用户，除非目标弹了菜单/对话框 | windows-uia.ps1:849-872 |
| 关窗不杀进程 | `close_window` 用 WM_CLOSE | server.mjs:493 |

### 5.2 它没有的

- **没有任何审批/确认**：`mcp\*.mjs` 里 `elicit|confirm|approv` 6 处命中全是浏览器 `alert/confirm` 与措辞，**没有一处是"问用户"**。
- **没有白名单/黑名单**：不按进程名/标题拦应用。
- **没有频率限制**：模型可以连点 1000 次。
- **敏感窗口只靠提示词自律**：`docs\wiki\safety.md:15-35` 列了「付款/账号/发消息/UAC/密码管理器要问用户」，但**没有代码执行**。
- 我们相对它多的就是最后这一块：`requireApproval:'mutating'` 会真的走 `ctx.approval.request()`，拒绝时抛 `APPROVAL_DENIED`（src\runtime.js:378-379、403-424）。

### 5.3 明显不安全的地方（按严重度）

1. **默认全开 + 零确认**：`cordis.patch.yml:16` 写死 `mode: full`，settings 默认 `toolPreset:'auto'`（dsh-plugin.mjs:23）→ 装完即可 click / type / **launch_app 任意 exe**，没有任何一道确认。
2. **`launch_app` 就是任意执行**：只校验路径长度（server.mjs:129-136），没有 exe 白名单。这条最容易被 prompt injection 利用。
3. **浏览器通道开了"记住登录"后，本机任何程序能连它的 DevTools 端口** —— 它自己在 `docs\wiki\safety.md:47` 承认了。
4. **Esc 依赖一个独立进程**：overlay/WinForms 进程挂了，全局急停就没了；`takeover.mjs` 里没看到对"钩子进程已死"的自愈重试（**未证实**，只读了主流程）。
5. **角标急停一行环境变量就关掉**：`WCU_FAILSAFE=0`（windows-uia.ps1:1130）。
6. `-ExecutionPolicy Bypass -File windows-takeover.ps1`（takeover.mjs:157）：对它这种"高信任本地能力"是合理选择，但等于默认允许脚本执行。

## 6. PowerShell 侧的工程质量（它的核心资产）

### 6.1 宿主形态：常驻，不是每命令起进程

```
# Persistent backend: one long-lived PowerShell process speaking a
# one-JSON-per-line protocol. ... (bench: ~550ms per one-shot action -> ~8-50ms hot)
```
（server.mjs:691-695；PS 侧主循环在 windows-uia.ps1:3438-3468；崩溃/超时 kill 后懒重建，server.mjs:736-770）

每条请求：`{id, action, args}` → `Invoke-Action` → 一行 JSON 回写；异常统一转
`{ok:false, error, category, scriptStackTrace}`（windows-uia.ps1:3451-3465）。
启动阶段还埋了 `Write-BackendStage` 打点（`native-load-start` … `backend-ready`），失败时给出一行可引用的 `WCU_BACKEND_STARTUP_FAILED stage=...`（:3427-3435）—— 这个"阶段名 + HRESULT"的可诊断性值得抄。

### 6.2 `Add-Type` 怎么组织（**最值得抄的一条**）

把整段 C# 放进 `$script:WcuCs`，然后**把编译产物按 hash 缓存到 %TEMP%**，下次直接 `Assembly.Load(bytes)`：

```powershell
$runtimeKey = $PSVersionTable.PSEdition.ToLowerInvariant() + '-clr' + [Environment]::Version.Major
$dll = Join-Path $env:TEMP ("wcu-native-" + $runtimeKey + '-' + (Get-CsHash -Source $script:WcuCs) + ".dll")
Import-HelperAssembly -Path $dll -Compile { param($out) Add-Type -TypeDefinition $script:WcuCs -OutputAssembly $out }
```
（windows-uia.ps1:445-452；`Get-CsHash` 在 :407，`Import-HelperAssembly` 的并发安全 Move + 已存在则复用 在 :421-438）

细节都想到了：hash 里带 **PSEdition + CLR 主版本**（5.1 编的 DLL 给 pwsh 7 用不了，注释 :447-449 明说）。
效果：省掉每次 ~300-500ms 现场编译（docs\dev-notes.md:103）。OCR 与 WGC 两个 helper 同机制（:1287、:1540）。

### 6.3 `SendInput` 结构体与一个实测坑

标准三段式定义 + `LayoutKind.Explicit` 联合体（windows-uia.ps1:149-166），关键不在定义，而在**定位方式**：

```
// Movement is done with SetCursorPos (raw screen coords, matching the UIA/screenshot
// space), not with MOUSEEVENTF_ABSOLUTE: on multi-monitor / high-DPI setups
// the ABSOLUTE 0..65535 normalization against SM_CXVIRTUALSCREEN silently
// mis-maps (observed: X exactly halved), so we never position via SendInput.
```
（windows-uia.ps1:170-184）

这条很有价值：**移动用 `SetCursorPos`，按键/滚轮才用 `SendInput`**。（我们目前是统一 SendInput，见 win-host.ps1:384-395；是否在多屏高 DPI 下踩过同一个坑，值得自查。）

### 6.4 中文输入

`KEYEVENTF_UNICODE` 逐字符 press/release，**完全不碰剪贴板**，注释点名"密码框等拒绝粘贴的控件也能用"；64 个一批，批间 `ThrowIfCancelled()`：

```csharp
inputs[n].U.ki.wScan = ch;      inputs[n].U.ki.dwFlags = KEYEVENTF_UNICODE;
inputs[n].U.ki.wScan = 0;       inputs[n].U.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
```
（windows-uia.ps1:186-227）

我们同路子（win-host.ps1:76-78、941；smoke 实测 22 UTF-16 units 中文写入并回读校验，test\out\smoke.log:12）——**持平，不用抄**。

### 6.5 UIA 树怎么裁枝/去重/限深

- 用 `TreeWalker` + **过滤后的 ViewCondition**（`ControlView` / 含 offscreen）取子节点，而不是 raw children；配 `CacheRequest 'compact'` 一次性把属性取回来，避免每节点跨进程往返（:1671-1691）。
- 双预算：`maxNodes`（默认 4096/上限）**加** 时间预算 `budgetMs`（默认 5000ms），超了就 `truncated` + `reason`（`maxNodes`/`timeBudget`/`providerError`）（:1693-1711、:1730、:1747）。
- 元素 id 是**路径式** `uia:0.3.2`，每次动作用 `Resolve-Element` **重新解析**，不缓存 `AutomationElement`（AutomationElement 有生命周期，缓存必烂）（:1753-1760）。
- 浏览器版式层折叠（很实用的一招）：

```powershell
# Chromium nests a page six or more levels down, under unnamed layout panes...
if ($Traversal.browserLayout -and $info.controlType -eq 'Pane' -and [string]::IsNullOrEmpty($info.name) -and
    (Invoke-Safe { $Element.Cached.FrameworkId } '') -in @('Chrome', 'Gecko')) { $childLevel = $Level }
if ($childLevel -le $MaxDepth -and $Depth -lt $MaxDepth + 16 ...)
```
（windows-uia.ps1:1721-1730，注释里的 `#56` 是它自己提的 issue 编号）

- providers 注册有个 .NET Framework 坑：第一次注册会因代理表未初始化抛 `NullReferenceException`，**注册两次**才好（:464-472）。

### 6.6 输入安全断言链（工程上很值）

`Start-Input` → `Assert-PointOnTarget` → 执行 → `Complete-Input`（windows-uia.ps1:814-872）：
借用前台前先快照「用户原前台 + 指针位置 + 目标进程的弹窗集合」，动作后按「菜单模式 / 新弹窗 / 原窗口是否还在」逐条决定要不要还前台，并把结论写进结果的 `pointer`/`foreground` 字段（`'returned'` / `'left where the user moved it'` / `'kept in front: ...'`）。
**"把是否还给用户前台"变成可读结果**，模型能据此判断下一步 —— 这个信封设计比我们现在的 coarse 结果更细。

## 7. 性能

### 7.1 它公开的数字（都在 `docs\dev-notes.md:90-106`，persistent 后端实测）

| 动作 | 优化前（每次新起 powershell） | 优化后 hot | 提升 |
|---|---|---|---|
| `health` | ~540 ms | **6 ms** | ~90× |
| `list_windows` | ~600 ms | **44 ms** | ~14× |
| `tree` (depth 2) | ~585 ms | **103 ms** | ~6× |

手段三条（dev-notes.md:98-106）：常驻后端（首个调用 cold ~500ms，之后 6~100ms）、C# DLL hash 缓存（省 300-500ms/次）、截图减重（窗口裁剪 + maxWidth）。

### 7.2 我们的数字（`test\out\smoke.log`，本机实测）

| 项 | 值 |
|---|---|
| `host.start` | **515 ms**（其中 boot 149ms，ps=7.5.4 / PER_MONITOR_AWARE_V2 / STA / uia=true / screen=2560x1600@1.5） |
| `screenshot` | **159 ms**（1011×632 = 638,952 px，host 侧 136ms，scale 0.3949，403 KB） |
| `uia` | 97 ms（10 节点，host 69ms） |
| `cursor` | 1 ms |
| `windows` | 77 ms（8 窗口） |
| 200 次 cursor | 111 ms 总计，**平均 0.55 ms**（相对 one-shot 进程 900ms 快 1627×） |
| `host.close` | 331 ms（优雅退出） |

> 注：那次 smoke 用的是 640000 px 上限（1011×632），当前默认已下调到 `maxPixels: 600000`（src\index.js:32）。

### 7.3 对比结论

- **热路径**：我们的 `cursor` 0.55ms 是"已在同进程里"的量级；它没公开 cursor 数字（**未证实**），但它的 `health 6ms` 已经是它最便宜的动作，我们的 `windows 77ms` 比它 `list_windows 44ms` **慢**——窗口枚举它用原生 `EnumWindows`（windows-uia.ps1:1593-1622），我们走 UIA/Get-Process 混合的概率大，这一项它赢。
- **冷启动**：它 ~500ms 且**不含** MCP server 进程启动 + stdio 握手 + 桥注册工具定义；我们 515ms 是含 DSH 侧 spawn 的全链路。**整体首调我们大概率更快（推断，未证实）**。
- **截图**：我们 159ms / 403KB（JPEG 80，≤600k px）；它 91KB（窗口裁剪）~3.8MB（全屏 PNG）不定，且只在宽度上设限。**大屏时它的传输量是我们的 5~10 倍**，还要多走两条管道。
- **上下文成本**（也是性能）：它的工具定义实测 **All 20,243 / Lite 9,030 / Lazy 510 字符**（docs\tool-context.md:13）；我们 4 个工具的 schema 实测 **10,158 字符**（`computer` 4276 + `app_window` 2517 + `ui_element` 2438 + `clipboard` 927，用 `JSON.stringify({name,description,parameters})` 量的）。
  → **我们比它 All 省 50%**，与它 Lite 相当，但动作面覆盖了桌面主力场景。

## 8. 我们该抄的 3 件事（按性价比排序）

### ① 窗口移动补偿 + 窗口身份漂移守卫（最该抄）

- **抄什么**：观察时记下 `{hwnd, pid, rect}`；动作前若标题解析出的 HWND/PID 变了 → 直接拒发 `identity_changed`；若窗口只是移动了 → 把坐标按 `dx/dy` 平移并在结果里报 `homed:{dx,dy}`。
- **改哪**：`src\win\win-host.ps1`（新增 window 快照表 + 在 click/move/scroll 入口断言），`src\tools.js` 只把新字段放进结果信封。
- **出处**：windows-uia.ps1:1046-1066（`Update-WindowCache`/差值平移）、:1068-1110（`Update-WindowIdentity`/`Assert-WindowIdentity`，含 5 分钟重新基线）。
- **工作量**：M（PS ~150 行 + JS ~30 行）。**风险**：低（只加校验，不改输入路径）。风险点：按标题定位时同一标题多个窗口会误报，需要按 HWND 优先。

### ② 鼠标左上角角标急停（EMERGENCY STOP）

- **抄什么**：任何输入动作前查指针是否在虚拟屏左上角 12px 内且已滞留 500ms，是则抛 `EMERGENCY STOP`；角点/半径/时长可配。
- **改哪**：`src\win\win-host.ps1` 的输入前置断言（跟 approval/Esc 检查并排）。
- **出处**：windows-uia.ps1:1112-1150。
- **工作量**：S（~40 行）。**风险**：极低。
- **为什么值**：我们现在的急停全靠 Esc + overlay 进程 + approval；**角标急停不依赖任何常驻进程**，是最后一道物理刹车，也是"用户手忙脚乱时唯一一定能用"的那道。

### ③ 截图"可能被遮挡"的诚实上报

- **抄什么**：退回屏幕裁剪时，先做「前台 / Z 序 / 窗口几何」三项检查，产出 `occludedPossible: true|false` 并写进结果信封（我们已有 `fallback:'screen'`，但没有"这张图可能不是你想要的窗口"）。
- **改哪**：`src\win\win-host.ps1` 的截图降级分支（win-host.ps1:718-795 附近），把结论塞进 `$result`；`src\tools.js` 的信封文本里带出来。
- **出处**：windows-uia.ps1:2166-2221、2245-2265、2356。
- **工作量**：S~M（~60 行 + 信封一行）。**风险**：低；只会多一个字段，不会多一次失败。
- **备选（没进前三）**：C# helper 的 hash DLL 缓存（windows-uia.ps1:445-452）——我们每次都 `Add-Type -TypeDefinition`（win-host.ps1:268），但我们的 C# 体量远小于它，**收益估计只有几十 ms 而不是它的 300-500ms**（未实测），性价比反而低。OCR / 后台输入 / WGC 兜底是真正缺的能力，但工作量都是 L，单独立项更合适。

## 9. 我们比它强的 3 点（给证据）

### ① 图片 → 坐标是闭环的，它是开环的

- 我们：截图默认 `maxPixels: 600000 < 640000`（src\index.js:32）→ 交给模型的那张图基本就是请求侧最终图 → 点击时 `capture.x + x / view.scale` 精确反算（src\runtime.js:592-593），信封里同时给"图空间/物理空间"两套数（:488-492）。
- 它：`maxWidth` 默认 1600（server.mjs:465），**不限像素**，把 `/imageScale` 的除法甩给模型（server.mjs:460），而模型看到的图已被宿主再缩到 ≤640k px（`llm-deepseek:`463）→ 系统性偏小约 1.5×（§4.2）。
- 一句话：**它把最难的一步（图到底是多大）交给模型猜，我们把这一步钉死在代码里。**

### ② 零 MCP 中间层：少两个进程、少两条 base64 管道、没有静默降级

- 我们：`inject:['tools']` + `ctx.tools.register`，**零运行时依赖**（package.json 单看即可验证），热路径只有 DSH 进程 + 一个常驻 PS 宿主。
- 它：`peerDependencies` 硬依赖 `@deepseek-ai/dsh-mcp-client`（package.json:94），`apply` 里 `await import` 无 try/catch（dsh-plugin.mjs:85）；图片要 base64 走 PS→server→stdio→桥四跳，**任何一道门不过就静默变成一行 `[image unavailable: ...]` 文本**（mcp-client:341-343），模型还以为截图成功了。
- 直接后果：它的 `snapshot` 可以"成功返回"却让模型拿到一句占位文本，然后拿旧坐标去点。

### ③ 上下文更省 + 自带审批语义 + 有剪贴板

- 工具定义：我们 **10,158 字符** vs 它 All **20,243 字符**（各见 §7.3 的度量与 docs\tool-context.md:13），省 50%。
- 审批：我们 `requireApproval:'mutating'` → `ctx.approval.request()` → 拒绝时 `APPROVAL_DENIED` 且什么都不做（src\runtime.js:378-379、403-424）；它 0 处审批，`docs\wiki\safety.md` 全靠模型自律。
- 剪贴板：我们有 `clipboard get/set`（src\tools.js:815-821），它没有工具；而它自己的 safety.md 又把剪贴板内容列为敏感数据（safety.md:39）——**它知道要防，但没给工具面**。

## 10. 它踩的坑 / 可疑处

1. **（最严重）坐标与请求侧像素预算脱节**：§4.2。全仓库 0 处提及 640k/imagePixelBudget，默认 1600 宽必然被再缩。
2. **图片静默降级**：`mcp-client:341-343` 把图换成一行文本，而它的 server 仍返回 `ok`（server.mjs:970-973），模型无从得知"我看的不是图"。
3. **peer 版本范围写错**：`">=0.1.0-rc.2 || >=0.2.0-rc.2"`（package.json:94）——两个 `>=` 取或恒等于前一个，第二个条件永远冗余；而它被标成 `optional`（:101），但缺了不是"少功能"而是 `apply` 直接抛（dsh-plugin.mjs:85 无兜底）。
4. **默认全开 + 零确认 + `launch_app` 任意 exe**：cordis.patch.yml:16、server.mjs:129-136（§5.3）。
5. **改一项设置可能要等 65 秒**：要等当前动作结束再重启 MCP server（dsh-plugin.mjs:114-124）。
6. **同一 profile 装两份会抢一套 `mcp__wincu` 工具**，只有一个 warn 日志（dsh-plugin.mjs:67-70、97）。
7. **发布包里 `test/` 没打进去**（package.json 的 `files` 只含 mcp/scripts/docs/根文件），但 `scripts.test` 指向 `test/run-tests.mjs` → 装包后 `npm test` 必失败。
8. **只有 PNG、无 JPEG、无字节上限**：一次 3.8MB 截图的 base64 直接进 stdio（server.mjs:728）。慢，而且对请求侧 1 MiB 的 `imageMaxBytes`（api-recon §3.5）毫无感知。
9. **Esc 急停依赖独立 WinForms 进程**：该进程死了/起不来，全局钩子就没了，主进程看不出（未证实有看门狗）。
10. **文档与实现的口径差**：README 说 24 个工具、tool-context 说 25（含 `tools`）——同一版本两种说法（README.md vs docs\tool-context.md:9-11），说明工具数在快速迭代中没收口。

---

### 附：这份报告里"未证实"的三处

1. MCP server 进程启动 + 桥握手的独立耗时（§2.3②、§7.3，无公开计时）。
2. 内存增量对比（多两个常驻进程的实际开销，未实测）。
3. 坐标偏差的端到端实测（§4.2 的 1.5× 是代码链推断，未跑真实截图+点击闭环）。
