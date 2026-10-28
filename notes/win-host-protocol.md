# Windows 宿主协议（win-host.ps1 ⇄ backend.mjs）

本文件是 `src/win/win-host.ps1`（PowerShell 侧）与 `src/win/backend.mjs`（Node 侧）
之间**唯一的**接口约定。两侧实现都必须严格遵守；改动协议必须同步改本文件。

## 进程模型

- Node 侧 `spawn` 一个**长生命周期**的 PowerShell 子进程：
  `pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <...>\win-host.ps1`
  （`pwsh` 不存在时回退 `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ...`）
- stdin / stdout 都是 **UTF-8、无 BOM、每行一个 JSON 对象**（NDJSON）。不允许任何非 JSON
  输出污染 stdout：所有日志走 stderr（或 `[Console]::Error.WriteLine`）。
- 启动后立刻在 stdout 打印一行 `{"event":"ready", ...}`（见下）。之后 Node 每发一条请求，
  PowerShell 回一条同 `id` 的响应。**串行**：PowerShell 一次只处理一条请求。
- PowerShell 侧读循环用 `[Console]::In.ReadLine()`，读到 `$null`（EOF）即退出。
  收到 `{"cmd":"shutdown"}` 回复后退出。
- 单条请求处理异常必须被包住，回 `{"id":...,"ok":false,"error":{...}}`，宿主进程**不能死**。

## 消息

请求：
```
{"id":"<字符串，调用方生成>","cmd":"<命令名>","args":{...}}
```
响应：
```
{"id":"<回显>","ok":true,"result":{...}}
{"id":"<回显>","ok":false,"error":{"code":"<大写短码>","message":"<人读信息>"}}
```
主动事件（无 id）：
```
{"event":"ready","result":{"os":"...","psVersion":"...","sessionId":1,"dpiAware":true,
  "screens":[{"id":"\\.\DISPLAY1","x":0,"y":0,"width":1707,"height":1067,"primary":true,"scale":1.5}],
  "cursor":{"x":0,"y":0}}}
{"event":"abort","result":{"reason":"escape","at":"<ISO8601>"}}
```
`event` 消息可随时出现，Node 侧必须按 `event` 字段分流，不能当成响应。

## 命令表

坐标一律为**虚拟屏幕物理像素**（`GetSystemMetrics(SM_XVIRTUALSCREEN)` 等），原点可以是负数
（多显示器左侧有屏时）。返回里带 `bounds` 的矩形一律 `{x,y,width,height}`。

### screenshot
args: `{"screen":0|null, "hwnd":null|int, "region":null|{x,y,width,height},
       "maxWidth":1568|null, "maxPixels":null|int, "format":"png"|"jpeg", "quality":80, "showCursor":false}`
result:
```
{"image":{"base64":"<无 data: 前缀>","mime":"image/png","width":1200,"height":750},
 "capture":{"x":0,"y":0,"width":1707,"height":1067},
 "scale":0.703,          // model 像素 / 物理像素，用于把模型给的坐标换回物理像素
 "cursor":{"x":100,"y":200},
 "screen":{"width":1707,"height":1067},
 "foreground":{"hwnd":123,"title":"..","class":"..","pid":1,"process":"chrome","bounds":{..},"clientBounds":{..},"minimized":false,"maximized":false,"foreground":true,"visible":true}|null,
             // 当前前台窗口完整记录，与 windows 每条的 11 字段完全同构；无标题/不可见/被 DWM 遮蔽时为 null。
             // 只走 GetForegroundWindow + 现有记录构造，不做 EnumWindows；该路径启动时已预热，稳态开销约 0.5ms。
 "elapsedMs":42}
```
- `screen` 指定第几个显示器（`screens` 数组下标）；`region` 优先于 `screen`；`hwnd` 用 PrintWindow 抓单窗口
  （失败要能在 result 里写 `"fallback":"screen"` 而不是抛错）。
- 有 `maxWidth` 时等比缩小；`scale = image.width / capture.width`。

### cursor
args `{}` → `{"x":..,"y":..}`

### move
args `{"x":int,"y":int,"durationMs":0}` → `{"x":..,"y":..}`

### click
args `{"x":int|null,"y":int|null,"button":"left"|"right"|"middle","count":1,"modifiers":["ctrl","shift","alt","win"],"holdMs":0}`
→ `{"x":..,"y":..,"count":..}`；`x`/`y` 为 null 表示在当前位置点击。

### drag
args `{"from":{"x":..,"y":..},"to":{"x":..,"y":..},"button":"left","durationMs":300,"modifiers":[]}`
→ `{"from":{..},"to":{..}}`

### scroll
args `{"x":int|null,"y":int|null,"dy":int,"dx":int}`（`dy>0` 向上/远离用户，与 Windows WHEEL_DELTA 同号；
一"格"=120）→ `{"x":..,"y":..,"dy":..,"dx":..}`

### type
args `{"text":"<完整字符串>","intervalMs":0}` → `{"chars":<写入字符数>}`
- 必须支持中文/emoji：用 `SendInput` + `KEYEVENTF_UNICODE`（每个 UTF-16 code unit 一个 down/up），
  不要用 `SendKeys`。

### key
args `{"keys":["ctrl","c"]}` 或 `{"keys":["enter"]}` → `{"keys":[...]}`
- 支持 `ctrl shift alt win enter tab esc space backspace delete home end pageup pagedown up down left right
  f1..f12 a..z 0..9 以及 `"+"` 这类单字符`。组合键按顺序按下、逆序抬起。

### windows
args `{"filter":""}` → `{"windows":[{"hwnd":123,"title":"..","class":"..","pid":1,"process":"chrome",
 "bounds":{..},"clientBounds":{..},"minimized":false,"maximized":false,"foreground":true,"visible":true}]}`
- 只列可见、有标题的顶层窗口；`filter` 做 title/process 子串（不区分大小写）过滤；前台窗口排第一。

### focus
args `{"hwnd":int|null,"titleMatch":"子串"}` → `{"window":{...}}`
- 必要时 `ShowWindow(SW_RESTORE)` 再 `SetForegroundWindow`（含 AttachThreadInput 兜底）。

### window
args: `{"op":"minimize"|"maximize"|"restore"|"close","hwnd":int}`
→ `{"hwnd":..,"op":"..","bounds":{x,y,width,height},"minimized":bool,"maximized":bool,"closed":bool}`
- minimize/maximize/restore 用 `ShowWindow`（SW_MINIMIZE=6 / SW_MAXIMIZE=3 / SW_RESTORE=9），睡 60ms 后可读回状态。
- close 用 `PostMessageW(hwnd, WM_CLOSE=0x0010, 0, 0)`，**不** TerminateProcess；随后最多轮询 ~500ms 等窗口销毁，
  销毁则 `closed:true`（`bounds/minimized/maximized` 取关闭前快照）。
- hwnd 不存在/已销毁 → `{"ok":false,"error":{"code":"WINDOW_GONE","message":".."}}`。

### windowState
args: `{"hwnd":int}`
→ 存在: `{"hwnd":..,"exists":true,"pid":..,"process":"notepad","class":"..","bounds":{x,y,width,height},"minimized":bool,"visible":bool}`
→ 已销毁: `{"hwnd":..,"exists":false}`（**不是** error，调用方按 `exists` 判定，不要用 try/catch 分支）
- 只做 `IsWindow` + 矩形（`DwmGetWindowAttribute` 优先，与 `windows` 同源）+ `IsIconic` + `GetWindowThreadProcessId` + 进程名（带缓存），**不做 EnumWindows**。
- 用途：`screenshot {hwnd}` 之后每次 mutating 动作前比对 `bounds`/`pid`，不一致就拒发并让模型重新截图。
- 实测（本机）：首次 2.88ms，20 次均值 ~1.5ms（含 NDJSON round-trip，IPC 地板 ~0.46ms）。

### uia
args `{"hwnd":int|null,"depth":8,"maxNodes":1200,"includeOffscreen":false}`
result `{"root":<node>,"nodes":123,"truncated":false,"hwnd":..}`
node:
```
{"path":"0/2/1","role":"Button","name":"保存","value":null,"automationId":"btnSave",
 "class":"Button","bounds":{"x":..},"enabled":true,"offscreen":false,
 "patterns":["Invoke","Value"],"children":[...]}
```
- 用 `UIAutomationClient`/`UIAutomationTypes`：`AutomationElement.FromHandle`，`TreeWalker.ControlViewWalker`。
- `path` 为 `0/2/1` 形式的子索引链，供 `uiaAct` 定位；每个节点都带 `path`。
- 要限制 `depth`/`maxNodes` 并及时停止（`truncated:true`）。

### uiaAct
args `{"hwnd":int,"path":"0/2/1","action":"invoke"|"setValue"|"focus"|"expand"|"collapse"|"select","value":null|".."}`
→ `{"action":..,"ok":true,"bounds":{..}}`（不支持该 Pattern 时 `ok:false` + error code `PATTERN_UNSUPPORTED`）

### clipboard
args `{"op":"get"}` → `{"text":".."}` / `{"op":"set","text":".."}` → `{"ok":true}`
- 用 `System.Windows.Forms.Clipboard`，需 STA：宿主要在 STA 线程执行（见下）。

### guard
args `{"op":"arm"|"disarm"|"status"|"reset"}` → `{"armed":false,"tripped":false,"reason":null,"since":null}`
- 由 Node 侧 overlay/guard 模块实现（见 `src/overlay/README`），本文件只固定**形状**。

### shutdown
args `{}` → `{"ok":true}` 然后进程退出。

## PowerShell 侧实现约束

- 启动即设 Per-Monitor DPI 感知：`SetProcessDpiAwarenessContext(-4)`（失败回落 `SetProcessDPIAware()`），
  否则坐标与截图在高 DPI 下对不上。
- `Add-Type -AssemblyName System.Windows.Forms, System.Drawing, UIAutomationClient, UIAutomationTypes`。
- 鼠标/键盘统一用 `SendInput`（`user32.dll` + `INPUT` 结构体），不要混用 `mouse_event`/`SetCursorPos`
  （后者不产生真实输入事件）。
- STA：宿主主线程若是 MTA，剪贴板等操作需 `[System.Threading.Thread]` 起 STA 线程执行（或整体用
  `-STA` 启动；`pwsh -STA` 在 PS7 Windows 上可用）。
- 所有 `Add-Type` 只做一次（放启动时），避免每条请求重复编译。
- 每步操作完成后 `Start-Sleep -Milliseconds` 给 UI 让路；`click` 之后默认不等，由模型显式 `screenshot`。

## Node 侧（backend.mjs）要求

- 类 `WinHost`：`start()`、`call(cmd, args, {timeoutMs=20000})`、`on('event', cb)`、`close()`。
- 请求串行队列；超时回 reject 且**不阻塞**后续请求（超时后标记该 id 丢弃迟到响应）。
- 子进程崩溃时 1 次自动重启（`restart()`），并把本次会话标记为"新宿主"。
- 崩溃/超时要能从 stderr 尾巴里带出诊断信息。

---

## 附录 A：实现补充与澄清（宿主 v1.1）

以下是落在两侧代码里的**细节补充**，未改动任何既有字段名／命令名。

### A.1 screenshot
- `maxWidth` 缺省 = 1568（协议默认值）；显式传 `null` = 不按宽度限制。
- `maxPixels` 在 `maxWidth` **之后**生效：若 `width*height > maxPixels`，按同一宽高比二次缩小，
  缩小后再校验一次（floor 之后用 0.998 系数兜底），保证**最终** `image.width*image.height <= maxPixels`。
- `image.width/height` 与 `scale` 始终反映**最终**尺寸；`capture` 始终是物理像素捕获区域；`screen` 是主屏物理尺寸。
  三者一个都不少，Node 侧坐标换算只需 `物理 = capture + 模型 / scale`。
- `format:"jpeg"`：`quality` 生效（10..100，默认 80，越界自动夹紧），`mime` 恒为 `image/jpeg`（不会是 `image/jpg`）。
  `format:"png"`：忽略 `quality`，`mime` 为 `image/png`。
- 额外返回（可选消费）：`image.bytes`、`timings{captureMs,transformMs,encodeMs}`、`maxPixels`。
- `hwnd` 抓窗口用 `PrintWindow(PW_RENDERFULLCONTENT=2)`；返回 0 或整幅全黑（cloaked／最小化）时回退整屏并带 `"fallback":"screen"`。
  整屏捕获若全黑，会用 `CaptureBlt` 再试一次。

### A.2 输入
- `type` 的 `chars` = 实际发出的 **UTF-16 code unit 数**（一个 emoji 记 2）。中文／emoji 用 `KEYEVENTF_UNICODE` 逐 code unit 发送；
  `intervalMs > 0` 时逐字符 sleep，否则按 400 个事件一批发送。
- `key` 组合键按顺序按下、**逆序抬起**；单个字符若需要 Shift（如 `"+"`）会自动补 Shift，除非调用方已显式传 `shift`。
  支持 `f1..f24`、`a..z`、`0..9`、方向键、`enter/tab/esc/space/backspace/delete/home/end/pageup/pagedown` 与常见符号名。
- `scroll` 的 `dy/dx` 单位是 **WHEEL_DELTA**（一格 = 120，`dy>0` 向上／远离用户）。按「格」思考的调用方可传 `"unit":"notch"`（内部 ×120）。
- `drag` 中途按 **Esc** 会立刻抬起按键，并推一条 `{"event":"abort","result":{"reason":"escape","at":"<ISO8601>"}}`。
- `click` 的 `count>1` 之间固定间隔 70ms；`holdMs` 是按下到抬起之间的保持时间。
- 鼠标绝对移动按虚拟屏归一化到 0..65535，并带 `MOUSEEVENTF_ABSOLUTE|MOUSEEVENTF_VIRTUALDESK`。

### A.3 windows / focus / window
- `windows` 只列 `IsWindowVisible` + 有标题 + 非 DWM cloaked 的顶层窗口；每条记录固定 11 个字段
  （`hwnd/title/class/pid/process/bounds/clientBounds/minimized/maximized/foreground/visible`），前台窗口排第一。
  `foreground` 只有 `GetForegroundWindow()` 那一条为 true；若前台窗口没有标题（被过滤掉）则可能没有 true。
- `focus` 返回 `{"window":{..},"bounds":{..},"focused":bool,"foreground":bool}`；`window` 与 `windows` 记录同构，`bounds` 是同一份矩形，
  始终返回，Node 侧可直接取坐标。
- `window` 见上文新增小节（minimize／maximize／restore／close）。

### A.4 uia / uiaAct
- `uia` 三重限制：`depth`（默认 8，上限 20）、`maxNodes`（默认 1200，上限 4000）、墙钟预算 `timeoutMs`（默认 6000，上限 30000）；
  任一触顶即 `truncated:true`，并立即返回已抓到的子树。
- `path` 是**控制视图兄弟序号链**（`0/2/1`）。跳过 offscreen 节点时**序号仍按原始兄弟位置递增**，
  因此 `uia` 里看到的 path 可以被 `uiaAct` 原样走回。
- `uiaAct` 除协议 6 个 action 外额外支持 `"toggle"`（TogglePattern）。
- 元素存在但缺 Pattern → `PATTERN_UNSUPPORTED`；path 越界 → `ELEMENT_NOT_FOUND`。

### A.5 宿主进程
- 启动参数在协议基础上**加速 `-STA`**（协议允许）：主线程为 STA，`Clipboard` 直接可用；
  若仍以 MTA 启动，宿主自动改走 Win32 `CF_UNICODETEXT` 路径，对外行为一致。
- `ready.result` 额外字段：`psEdition / hostPid / dpiMode / apartment / uia / inputStructBytes / virtualScreen / bootMs`。
  `inputStructBytes` 用于自检 `sizeof(INPUT)==40`。
- 错误码一览：`BAD_JSON / BAD_ARGS / UNKNOWN_CMD / INTERNAL / NO_WINDOW / WINDOW_GONE / CAPTURE_FAILED /
  SENDINPUT_FAILED / CURSOR_FAILED / UIA_UNAVAILABLE / UIA_FAILED / PATTERN_UNSUPPORTED / ELEMENT_NOT_FOUND / CLIPBOARD_FAILED`。
  错误对象额外带 `cmd` 字段便于定位。
- `guard` 命令宿主侧也实现了同形状状态机（arm/disarm/status/reset），Node/overlay 只读转发时不会拿到错误。

### A.6 已知坑（本机实测，Win10.0.26200 / PS 7.5.4）
- `Graphics.CopyFromScreen` 在本机 .NET 上**拒绝** `SourceCopy|CaptureBlt` 组合值（InvalidEnumArgumentException），
  而单独用 `CaptureBlt` 会得到**全黑**图；因此按 `SourceCopy` → 全黑再试 `CaptureBlt` 的顺序实现。
- 返回 `byte[]` 的函数必须写成 `return ,$bytes`：否则 PowerShell 会把 84 万个 byte 拆成箱装对象，
  PNG 编码一步从 ~30ms 涨到 ~200ms（截图总耗时随之破 300ms）。
- `INPUT` 的嵌套结构体在 PowerShell 里 `$input.mi.dx = ..` **不生效**（拿到的是值类型副本），
  必须先构造 `MOUSEINPUT`／`KEYBDINPUT` 再整体赋给 `INPUT.mi`／`INPUT.ki`。
- `Add-Type` 源码里同一 extern 声明重复 `[DllImport]` 特性会 CS0579 编译失败。
- 宿主进程必须**先**设 DPI 感知再碰 `System.Windows.Forms`／`Drawing`，否则 `Screen.Bounds` 与 `CopyFromScreen` 全部按逻辑像素工作。

### A.7 验收记录
见 `test/out/smoke.log`：`node test/smoke-win.mjs` → 11 PASS / 0 FAIL（含 200 次 cursor 驻留性能对照）。
