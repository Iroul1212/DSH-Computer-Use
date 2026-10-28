# overlay — 可见指示器 + Esc 急停守卫

Agent 真的会操作这台电脑时，人类必须**看得见**并能**立刻打断**。这个目录就是那层安全壳。

- `overlay.ps1` —— 独立的 WinForms GUI 进程：屏幕四周一圈半透明橙色呼吸光晕 + 顶部圆角小药丸
  「DeepSeek Harness 正在操控你的电脑 · 按 Esc 停止」。
- `guard.mjs` —— Node ESM 的 `Guard` 类：拉起 / 关闭 overlay，把 overlay 的 NDJSON 事件翻译成
  `ready` / `abort` / `exit`，并保证「守卫掉了」永远不会被当成「可以继续跑」。

协议形状与 `notes/win-host-protocol.md` 的 `guard` / `abort` 完全一致：

```
guard  -> {"armed":bool,"tripped":bool,"reason":null|string,"since":null|ISO}
abort  -> {"event":"abort","result":{"reason":"escape","at":"<ISO8601>"}}
ready  -> {"event":"ready","result":{"hwnd":int,"bounds":{x,y,width,height},"pid":int}}
```

## 单独跑 overlay

```powershell
pwsh -NoProfile -File src\overlay\overlay.ps1
```

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `-Message <text>` | `DeepSeek Harness 正在操控你的电脑 · 按 Esc 停止` | 药丸上的文字 |
| `-Opacity <0..1>` | `1` | 整体不透明度（光晕与药丸一起缩放 alpha） |
| `-Mode border-or-pill-or-both` | `both` | 只画框 / 只画药丸 / 都画 |
| `-DisableHotkey` | 关 | 只画框，**不吃 Esc**（录屏、演示时用） |
| `-AutoCloseSeconds <n>` | `0` | `0` = 不自动关；`>0` 到点自行退出 |
| `-SelfTest` | 关 | 2 秒后打印 `{"event":"selftest","result":{"ok":true}}` 并退出 |

stdout **只有 NDJSON**，其余全部走 stderr；退出码 0。

## 在插件里用

```js
import { Guard, isSupported } from "./src/overlay/guard.mjs";

const guard = new Guard();
guard.on("abort", ({ reason, at }) => { /* 立刻停止模型循环、释放输入 */ });

if (isSupported()) await guard.arm({ message: "…", opacity: 0.9, mode: "both" });

// 每次操作前后都自检；armed=false 就绝对不能继续
const { armed, tripped, reason } = guard.status();
if (!armed || tripped) throw new Error("guard down: " + reason);

await guard.disarm();
```

- `arm()` 幂等：已经在跑就直接返回当前 `status()`。
- `tripped` 一旦为 `true` 就**粘住**，只有显式 `reset()` 才清掉。
- overlay **意外退出**时 `armed` 自动变 `false`、`reason` 记为 `overlay-exited`，并发出 `exit` 事件。
  **绝不能把「守卫掉了」当成「继续跑」** —— 调用方只应在 `armed === true && tripped === false` 时操作电脑。

## Esc 语义

- 用 `GetAsyncKeyState(0x1B)` + `System.Windows.Forms.Timer`（40ms）轮询，**不用 `RegisterHotKey`**，
  所以不会和别的程序抢热键、也不会把 Esc 长期占住。
- 只认**上升沿**（松开 -> 按下）：如果 overlay 启动时 Esc 本来就按着，会先等一次松开，不会误触。
- 触发后：stdout 打一行 `abort` -> `Application.Exit()` -> 退出码 0。
- Esc 是**全局**的：只要守卫在跑，在任何程序里按 Esc 都会中止 Agent。这是有意的。

## 为什么不抢焦点、为什么点击穿透

窗口扩展样式同时带：

- `WS_EX_LAYERED` —— 用 `UpdateLayeredWindow` 做逐像素 alpha，光晕才能平滑渐隐；
- `WS_EX_TRANSPARENT` + `WM_NCHITTEST -> HTTRANSPARENT` —— 鼠标事件直接穿过去，点哪都是点底下的窗口；
- `WS_EX_NOACTIVATE` + 重写 `ShowWithoutActivation` + `WM_MOUSEACTIVATE -> MA_NOACTIVATE` —— 永远不抢前台；
- `WS_EX_TOOLWINDOW` —— 不出现在 Alt+Tab / 任务栏里。

必须点击穿透的理由：这是一个**全屏**覆盖层。如果不穿透，它会吃掉所有鼠标事件 ——
Agent 自己的 `click` 会打在自己的框上，人也点不到任何东西，安全层反而把桌面锁死了。

## 已知限制

- **独占全屏 / 部分全屏游戏**（DirectX exclusive fullscreen，或带反作弊屏蔽 overlay 的场景）下看不到光晕，
  因为 DWM 合成被绕过；窗口化全屏（borderless）正常。
- **UAC 安全桌面**、锁屏、以及以更高完整性级别运行的窗口之上不可见（普通用户进程盖不住安全桌面）。
- 多显示器时覆盖整个虚拟屏幕（`SystemInformation.VirtualScreen`），光晕画在虚拟屏幕四条边上，
  不是每个显示器各画一圈。
- 屏幕截图（GDI `BitBlt` 桌面 DC）**能**拍到 overlay；但 DPI 不感知的截图进程抓到的是缩放后的图。
- 光晕呼吸每 160ms 重绘一次全屏 ARGB 位图；`-Mode pill` 时没有动画，几乎不占 CPU。
- 只支持 Windows：`isSupported()` 在非 win32 上返回 `false`，`arm()` 会抛错。

## 自测

```powershell
pwsh -NoProfile -File src\overlay\overlay.ps1 -SelfTest
node test\overlay-selftest.mjs
```

`test\overlay-selftest.mjs` 会真的 `arm()`、等 `ready`、用 `keybd_event` 注入一次真实 Esc，
然后断言收到 `abort` 且 `status().tripped === true`，最后 `disarm()`。

