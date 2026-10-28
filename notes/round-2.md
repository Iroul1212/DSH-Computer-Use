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
