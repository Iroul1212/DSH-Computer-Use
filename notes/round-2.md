# 第二轮：把「看见 + 自校验 + 不点偏」闭环补齐

这一轮做的是 positioning.md 里 P0 的第 2、3 项，外加一个在真机上发现的严重缺陷。

## 1. 截图装饰真正接上了模型侧（grid / mark / dim / compare）

上一轮 commit 只写了 `src/win/decorations.ps1`，但 `win-host.ps1` 里还留着一份旧实现，
而且**从来没有 dot-source 过 decorations.ps1** —— 换句话说那份文件是死代码。
现在：删掉 win-host.ps1 里的旧副本，改为 `. (Join-Path $PSScriptRoot 'decorations.ps1')`，
并把 `grid` / `gridStep` / `mark` / `dim` / `compare` 一路从 tool schema → runtime.capture → host 打通。

## 2. 帧比对（compare）与 verify：动作到底有没有生效

- 每次截图都会刷新该目标（窗口 / 屏幕）的一张小尺寸签名（宽 256 的 32bpp 帧）。
- `compare: true` 时用 C# 编译的 `DshFrameDiff.Diff` 做像素差（PowerShell 版实测 534ms/帧，C# 版可忽略）。
- **先比对、后画装饰**：否则网格/标记会被算成"画面变了"，而且带装饰的帧会污染下一次比对。
- 比对只发生在同一目标、同尺寸之间；窗口被 resize 或换目标 → `comparable: false`。
- `verify: true`：动作后再截一张，只回 `change` 与一句判词（"NO visible change …"），**不附件图片**；
  `observe: true` 是同一张图再加附件。判词由 `runtime.describeChange()` 统一生成。

## 3. 光标回执 + POINTER_NOT_LANDED（真机上发现的坑）

用真实桌面测试时发现：当有程序（这里的例子是全屏游戏）在 raw-input 模式抓鼠标时，
`SendInput` 会**成功返回 1 但指针根本不移动**，`SetCursorPos` 也会失败。
旧代码会照着错误的位置点下去 —— 这是 computer use 里最不能容忍的失败。

现在 `Move-CursorTo` 每一步都读回 `GetCursorPos`：

1. 落到目标（±2px）→ 正常返回；
2. 没落到 → 用 `SetCursorPos` 补救一次；
3. 还是不行 → `Fail 'POINTER_NOT_LANDED'`，错误信息直接告诉模型"有程序在抓鼠标，先 focus 目标窗口，别硬点"。

顺带 `move/click/drag/scroll` 都返回 `pointer` 回执
（`{x, y, requestedX, requestedY, drift, landed}`），模型和审计日志都能区分"移动了"和"被告知要移动"。

## 4. 测试

- 新增 `test/observe-selftest.mjs`（8 项）：装饰是否生效、装饰是否被排除在比对之外、
  跨目标不比、以及指针被吞时是否 fail closed。实测（本机有游戏抓鼠标）：
  装饰全部 PASS，指针走 fail-closed 分支。
- `plugin-selftest` 增加离线用例：用假 runtime 验证 grid/mark/dim/compare/verify 真的透传，
  且 `verify` 不带附件、判词正确。
- `overlay-selftest` / `safety-selftest` / `smoke-win` 在桌面吞掉合成输入时改为 SKIP 并说明原因，
  不再假装失败（合入前 `npm test` 全绿：exit 0）。

## 5. 下一轮候选

1. 按描述找控件（UIA 模糊匹配 + top-3 候选 + 标注截图）—— 纯 JS，性价比最高。
2. `wait_for stable` 用现成的帧签名实现（"画面不动了"比 sleep 可靠）。
3. 敏感区域脱敏（截图前对配置的区域打码）。
4. `npm publish` + `dsh plugin add dsh-computer-use` 一行装。

---

## 6. 有真实桌面之后又修的三处（游戏退出后测试暴露）

上一轮测试是在「全屏游戏抓着鼠标」的机器上跑的，很多输入路径只能 SKIP。
游戏退出后重跑，`npm test` 从「有 SKIP」变成「全绿」，同时暴露出三个真问题：

### 6.1 `wait_for stable` 在真实窗口上永远不成立

旧实现比较两张截图的 **JPEG 字节是否相同**。真实窗口几乎永远不会有两次完全相同的字节——
记事本光标闪烁就足够让 `stable` 永远超时（实测 8s 超时）。
现在改为复用 `compare` 的帧签名：**采样像素差异 ≤ 0.2%** 就算「安静」，并要求连续安静 `stableMs`。
记事本实测 4 帧 / 约 1.0s 收敛。超时信息也会带上最后一次的 ratio 并建议改用 element/text 等待。

### 6.2 `verify` / `observe` 比对错了目标

`afterAction` 里第二次截图**没带 hwnd**，于是「上一步看的是某个窗口、这一步比的是整个屏幕」，
必然 `comparable: false`（模型看到「无法比较」，功能等于没有）。
现在 `afterAction` 会沿用 `runtime.lastView.window.hwnd`，和目标保持一致；
截图 view 也和模型刚看过的那张对齐。

### 6.3 「变化」阈值太低 + 指针回执没传上去

- 光标闪烁在 256 宽采样里约 0.15%，旧的 0.05% 阈值会把它判成「画面变了」。
  阈值改为 **0.2%**：光标/转圈不算变化，菜单弹出、出现文字（实测 2.9%~4.5%）照常判为变化。
- host 层的 `pointer` 回执没有透到 tool 返回值（文档写了、模型看不到）。现在
  `move / click / drag / scroll` 的返回值里都带 `pointer: {x,y,requestedX,requestedY,drift,landed}`。

### 6.4 新增的真实闭环回归用例

`test/observe-selftest.mjs` 追加两问（自己起 notepad、自己关掉）：

- `type` 后 `compare` → `changed=true, ratio≈2.9%, bounds` 覆盖文本区；
- 静置 300ms 后再 `compare` → `changed=false, ratio≈0.04%`。

实测 `npm test`：schema 5/5、plugin 13、skills 15、safety 11、ocr+wait_for 5、
observe 10 checks、smoke 11 PASS —— **0 FAIL / 0 SKIP**。
