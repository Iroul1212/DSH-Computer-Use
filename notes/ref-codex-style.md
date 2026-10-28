# 三个只发 GitHub 的 Codex-style computer-use 插件：源码分析

> 分析对象（本地 depth=1 clone，只读）：
> - `_reference/_gh/wushi2333_dsh-computer-use_codex-style/` ★23，364 文件
> - `_reference/_gh/esch30636_dsh-computer-use/` ★1，28 文件
> - `_reference/_gh/shinji00222_dsh-windows-computer-use/` 145 文件
>
> 基准：`dsh-computer-use/`（5 工具 / 33 action，见 `src/tools.js:110,468,658,823,999`）。
>
> 证据等级标注：**[证实]** = 我在源码/本机实际看到；**[未证实]** = 只有作者自述或我未跑过；**[推测]** = 我的推断。
>
> 一处额外的一手旁证：本机装有官方 Codex computer-use 插件缓存
> `%USERPROFILE%\.codex\plugins\cache\openai-bundled\computer-use\26.1007.21434\docs\api.md`。
> 我拿它交叉验证了 wushi2333 主打的「13 method」，见 §1.3。这是本次分析唯一能对「官方」说话的实物证据。

---

## 一、wushi2333 / dsh-computer-use_codex-style（★23）

### 1.1 一句话定位 + 规模

**一句话**：把 OpenAI Codex 的 **window2 桌面 RPC 面**（13 方法）连同反编译得到的 parity 常量，用 **Rust helper** 复刻进 DSH，再外挂一个 Chromium 扩展桥；不依赖 Codex 本体。

| 项 | 事实 | 出处 |
|---|---|---|
| 文件数 | 364 | `Get-ChildItem -Recurse` |
| 语言分布 | `.py` 138 / `.ps1` 52 / `.md` 47 / `.mjs` 37 / `.rs` 23 / `.txt` 22 / `.json` 19 / `.swift` 10 | 同上 |
| native | **Rust**（`helper-rs/src`：`overlay/mod.rs` 210KB、`uia.rs` 127KB、`app_catalog.rs` 91KB、`main.rs` 66KB）；**Swift**（`helper-swift/`，macOS）；**仓库内提交了预编译 exe** `helper-rs/bin/dsh-computer-use.exe` = 2,582,528 B | 目录树 |
| 非 native 引擎 | Python 138 个文件只服务 Chromium（CDP + Playwright + 扩展 hub） | `computer_use/browser_api.py`、`computer_use/cdp_browser.py:34` |
| npm 依赖 | **无 `dependencies`**；6 个 `@deepseek-ai/*` peerDeps（cordis / dsh-tools / dsh-system-prompt / **dsh-user-approval** / **dsh-attachment** / schemastery），后两者 `optional` | `package.json` |
| 进程结构 | cordis 服务 `src/index.js` → `src/sidecar.js` spawn Rust exe（行式 JSON 协议）→ helper-rs | `src/index.js:338`（`sidecar.request('tools')`） |

三个引擎并存（Rust/Python/Swift）是它最重的结构债：364 文件里真正跑在 Windows 上的只有 Rust + 少量 Python。

### 1.2 工具面清单 + 与我们的对照

**a) 官方 13 方法**（模型可见面，`surface=computer`）：见 §1.3 表。

**b) DSH 扩展**（`helper-rs/src/tools.rs:340` 之外，`README.zh-CN.md:184-192` + `dsh-plugin.json`）：

| 工具 | 默认 | 说明 |
|---|---|---|
| `batch_actions` | 开 | 串行动作后只做一次 `get_window_state` |
| `computer_use_health` | 始终 | 后端、白名单、文档门禁、env 审计、经验层、overlay 诊断 |
| `computer_use_experience` | 始终 | 本机经验笔记读写 |
| `click_element` / `scroll_element` | 显式开 | window-v1 别名，**不上架**（`tools.rs:335` 注释） |
| `session_note` / `session_state` / `diagnostic_state` / `end_turn` | 诊断 | `dsh-plugin.json` `tools.diagnostic` |
| `start_audio_recording` / `stop_audio_recording` | 需批准 | 录电脑音频，`VOID_TOOLS` 成员（`tools.rs:310-323`） |
| `tab_*`（浏览器） | skill 门控 | 走 Python，`tools.rs:372` 返回 `deferred` |

**c) 它有什么我们没有的**（按价值排序）：

1. **`list_apps` + `launch_app` 的完整已安装应用目录**：91KB 的 `app_catalog.rs`，来源是开始菜单 `.lnk` 树、`%LOCALAPPDATA%\Microsoft\WindowsApps` 执行别名、`shell:AppsFolder`、App Paths、Uninstall、Appx 包键，缓存到 `%LOCALAPPDATA%\computer-use-app-catalog\shell-apps.json`（`app_catalog.rs:1-7`）。我们只有 `app_window:launch`，没有"列出可启动应用"这一层。
2. **`get_window` 窗口绑定再水合** + `get_window_state` 把「截图 + AX 树」封成一个观察信封。我们是 `computer:screenshot` 与 `ui_element:tree` 两条独立路径。
3. **`perform_secondary_action`**：触发 UIA 元素的次级动作（`Raise` / `Scroll Up|Down|Left|Right` / `Expand` / `Collapse`，`tools.rs:187-195`）。我们的 `ui_element` 只有 `invoke/expand/collapse/select` 这些固定动词，没有"把元素声明的次级动作原样列出来再执行"。这是它比我们更贴 UIA 模型的一处。
4. **`batch_actions`**：一次调用串多个动作再一次刷新。
5. **`start_audio_recording`**：音频采集面，我们完全没有（也没有必要）。
6. **经验层 `computer_use_experience`**：按 app 记录"这台机器上这个 app 怎么操作"的笔记，带 pending 过期与路径脱敏（`src/experience.js:115-122` 把 `LOCALAPPDATA/APPDATA` 换成占位符）。这和我们 8 个内置 App 技能库是同一生态位，但它是**运行时自学习**、我们是**静态技能**。
7. **Chromium 自动化**（扩展 + CDP），见 §1.9 安全。
8. **overlay 光标精灵**（D2D 画的合成鼠标指针 + 运动曲线，`helper-rs/src/overlay/motion.rs` 42KB）。

**d) 我们有什么它没有的**：`move` / `cursor` / `wait` / `status` / `resume` 作为独立动作；`double_click` / `right_click` / `middle_click` 三个独立动作（**它把这三者折进 `click` 的 `click_count` + `mouse_button`**，`tools.rs:104-121`）；`clipboard`（get/set）；`app_skill`；`app_window:minimize/maximize/restore`。

> **口径校正（给 Lead）**：任务说明写「app_skill 2」，但 `src/tools.js:999` 的枚举是 `['list','get','save','append','remove']` = 5 个。按代码实际是 36 个 action，不是 33。请确认对外口径。

### 1.3 「Codex 13-method 桌面面」到底是什么

**结论先说**：这 13 个方法**确实**是 Codex/OpenAI 的真实接口，但它是 **window2 客户端 RPC 面**（`@oai/sky` 的 `Window2ComputerUseClient`），**不是** OpenAI computer-use 经典 `computer` 工具的动作枚举（那套是 click / double_click / scroll / type / wait / keypress / drag / screenshot / move）。把它叫「动作集合」会误导：它没有 `screenshot`、`move`、`wait`、`double_click` 这些独立方法。

**13 个方法逐条**（`helper-rs/src/tools.rs:340-354` 的 `WINDOW2_CORE` 常量，顺序即官方 `.d.ts` 顺序）：

| # | 方法 | 干什么 | 与我们的对应 |
|---|---|---|---|
| 1 | `list_windows` | 列出可定位的顶层窗口 | `app_window:list` |
| 2 | `get_window` | 按 id 重新水合一个窗口绑定 | 无（我们窗口靠 hwnd/标题即时解析） |
| 3 | `list_apps` | 已安装应用 + 各自打开的窗口 | 无（我们无应用目录） |
| 4 | `launch_app` | 按 app id 启动应用（可能暂停等批准） | `app_window:launch` |
| 5 | `get_window_state` | 某窗口的截图 + 完整 AX 树 | `computer:screenshot` + `ui_element:tree` 两条 |
| 6 | `click` | 按元素索引或窗口相对坐标点击（含 `click_count` 折双击、`mouse_button` 折右键） | `computer:click/double_click/right_click/middle_click` |
| 7 | `press_key` | X keysym 风格组合键 | `computer:key` |
| 8 | `type_text` | 向当前焦点打字面文本 | `computer:type` |
| 9 | `scroll` | 从窗口相对坐标滚动 | `computer:scroll` |
| 10 | `set_value` | 直接设置元素值 | `ui_element:set_value` |
| 11 | `drag` | 窗口内两点拖拽 | `computer:drag` |
| 12 | `perform_secondary_action` | 触发元素声明的次级动作 | 无（我们只有固定四动词） |
| 13 | `activate_window` | 把窗口带到前台 | `app_window:focus` |

**是不是真对齐？——[证实] 是，而且我用本机官方文件独立验证过**：

1. 它自己给出的出处：`parity/official-constants.json` 的 `officialSource` 指向反编译产物（`codex-computer-use.sky.exe` 的 Ghidra 全函数 C、strings 表、angr Rust 还原），并声明基线 `codexBaseline: 26.903.61454`（`package.json` `dsh.dsh.codexBaseline`、`dsh-plugin.json`）。
2. 代码级出处：`tools.rs:340` 上方注释明确写「exactly the 13 methods on `Window2ComputerUseClient` (`@oai/sky` `types/window2/Window2ComputerUseClient.d.ts`)」。
3. **本机交叉验证 [证实]**：`%USERPROFILE%\.codex\plugins\cache\openai-bundled\computer-use\26.1007.21434\docs\api.md:12-26` 里官方 `interface Window2ComputerUseClient` 列出的正是这 13 个、**顺序完全一致**，并且 `target: "windows"`。参数名也逐字吻合：官方 `ClickInput` 有 `click_count / element_index / mouse_button / screenshotId / x / y`，它的 `click` schema 一模一样（`tools.rs:108-118`，连描述串都是照抄官方文档）；`scroll` 用 `scrollX/scrollY` 而非 snake_case（`tools.rs:150`，与官方一致）。
   - 注意版本差：它声明基线 26.903.61454，我本机是 26.1007.21434。**方法面在这两个 build 之间没有变化**，但其余 parity（默认值、错误串、预算）无法据此验证。
4. **限制**：它的 parity 测试是拿一个 `DESKTOP_13` 测试替身断言「面里包含这 13 个」（`tests/contracts.test.mjs:47,173-177`），**不是**对拍真二进制。所以「面是 13 个」这一层 [证实]，「逐字 parity 到字节」这一层 [未证实]。

### 1.4 按 App 审批（per-app approvals）怎么做的

**事实链（这是三个仓库里唯一的完整审批实现）**：

1. **闸门在 helper（Rust）里，不在插件里**。helper 发现目标 app 没被批准时，回一条 `AppApprovalRequired`：
   `{"AppApprovalRequired": {"request": {"<app>": {"display_name": ..., "risk_level": ..., "allow_persistent_approval": bool}}}}`
   出处：`helper-rs/src/protocol.rs:167-199`（`ApprovalGrant` 结构体）与 `protocol.rs:602,651-652`（解析样例）。**app 是 map 的 key**，所以 grant 本身不带 app 字段。
2. **插件只在被拒之后才问**（不是事前问）：`resolveRefusal()` 收到 refusal → 走 `approvalModeFor(config, spec.name)` 三态 → 需要问时调 DSH 审批服务 → 拿到允许后**重试同一个调用**，并在元数据里加 `x-oai-cua-approved-app: <app>`（`src/tool.js:725-800`；header 常量在 `protocol.rs:8`，helper 侧读取在 `main.rs:214`）。注释明写「插件绝不能自己合成这个 header」（`src/tool.js:723`，判据 APS-01）。
3. **配置数据结构**（`src/tool.js:80-91`）：
   - `approvalDefault: 'prompt' | 'allow' | 'deny'`，默认 **`prompt`**；
   - `approvalTools: Record<toolName, 'prompt'|'allow'|'deny'>`，默认 `{}`；
   - manifest 里也镜像一份：`dsh-plugin.json` → `tools.approval = { default: "prompt", tools: {} }`。
   **要点：这是"按工具名"的配置，不是按 app 名**。app 维度完全来自拒绝负载，用户批准一次只对那一个 app 的这一次调用生效（`allowed-once`），持久化与否由 `allow_persistent_approval` 和 `persist: ['session','always']` 决定。
4. **和 DSH 审批服务的关系**（`src/tool.js:757-786`）：
   - `service = ctx.get('approval')`；`service.request({ agent, toolName, callId, reason, signal, persist, riskLevel, tool_params: { app }, tool_params_display: [...] })`；
   - **只接受 `outcome === 'allowed-once'`**，其余一律抛 `Computer Use was not approved to use <app>`；
   - 官方的 elicitation 元数据（`codex_approval_kind: 'mcp_tool_call'`、`connector_id: 'computer-use'`、`persist: ['session','always']`）**直接挂在同一个 request 对象上**，因为 DSH 的 `ApprovalRequestEvent` 没有这些槽位（`src/tool.js:770-781` 注释原话）。
   - 音频工具特殊：`allowPersistentApproval` 强制 false，永远只给 `session`（`tool.js:748-750`）。
5. **审计与默认值**：每次批准都 `state.recordedApprovals.push({ toolName, app, mode, outcome })`（`tool.js:736,745,786`）；**批准状态不落盘**——`state.rs` 只有内存态（`state.rs:427` 注释 "approved apps, allowlist, notes..."，全文件无写盘路径 [证实]）。
6. **失败模式（4 条，都 fail closed 或显式记账）**：
   | 情形 | 行为 | 出处 |
   |---|---|---|
   | `mode === 'deny'` | 直接抛错，不问 | `tool.js:736` |
   | 没有审批服务 / 没有 agent | fail closed，抛未批准 | `tool.js:752-756` |
   | 用户拒绝或返回非 `allowed-once` | fail closed | `tool.js:786` |
   | 会话已在 `danger-full-access`，或审批策略是 `never` | **免问直接放行，但显式记 `outcome: 'full-access' / 'approval-policy-never'`** | `tool.js:745-755` |
   最后一条是最有争议的设计：策略 `never` 时 DSH 服务会自动拒绝到不了 answerer，所以它把"用户已经用权限预设回答过了"当作已批准。安全上说得通，但它把"没问"和"问了被允许"在审计里区分开了——这点值得学。

**我们该抄什么**：「被拒 → 问 → 带批准头重试」的**顺序**，加上"免问放行也要留痕"的审计模型。不要抄的是：把批准闸门放进 helper 里（我们是 PowerShell 宿主，闸门放 `src/tools.js` 更好管）。

### 1.5 OCR 实现

**没有 OCR**。全仓库 `Windows.Media.Ocr` / `OcrEngine` / `Tesseract` 命中 0 [证实]。反而在 `dsh-plugin.json` 的 `modelDescription` 里明令：「Do not drive the desktop through pwsh, Start-Process, SendKeys, **OCR**, or screenshot scripts: the `get_window_state` image is the vision channel.」——它把 OCR 视为旁路作弊。

对我们是**反证价值**：这条禁令说明官方路线赌的是「AX 树 + 高质量截图」，但前提是 UIA 覆盖够好。我们的 8 个 App 技能库已经在对付"UIA 不覆盖"的场景，OCR 正好补这个洞（见 §3.5）。

### 1.6 overlay / 急停

**画法**：Win32 分层窗口 + Direct2D 自绘：
- 窗口样式 `WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TOPMOST | WS_POPUP`（`helper-rs/src/overlay/mod.rs:96`），`UpdateLayeredWindow` 逐像素 alpha（`mod.rs:88,654`），D2D 渲染（`mod.rs:29-32`）。
- **关键一招**：`SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)`（`mod.rs:234`，自检回读在 `:516`）——**把自己画的药丸从自己的截图里排除**。否则模型每次截图都会看到 overlay 上那行"正在操控你的电脑"，既浪费 token 又可能被模型当成 UI 元素去点。
- 还有合成的光标精灵（`overlay/motion.rs` 42KB + 缓动曲线 `parity/motion-curve.json`），让"幽灵鼠标"的移动可见。这是纯体验投入，性价比最低。

**Esc 感知**：全局低级键盘钩子 `SetWindowsHookExW(WH_KEYBOARD_LL=13, ...)` 跑在**专用线程 + 自己的消息循环**上（`helper-rs/src/interrupt.rs:497-514`，`PostThreadMessageW` 唤醒线程）。
三个细节值得记：
1. **区分"自己注入的键"和"人按的键"用 `dwExtraInfo == SYNTHETIC_TAG`，不用 `LLKHF_INJECTED`**——注释明说 RDP/虚拟机里人的真实输入也会带 `LLKHF_INJECTED`（`interrupt.rs:581-587`）。我们自己注入的 Esc（比如 `press_key` 里的 Esc）不会被误判成急停。
2. **Esc 被吞掉**（hook 返回 1），helper `exit(130)`（`interrupt.rs:593-607`）。
3. **arming grace**：刚武装的头一小段时间里的 Esc 不算急停，避免吞掉用户"按 Esc 关掉某个弹窗"的正当操作（`interrupt.rs:596-600`）。

**守卫死亡语义**：没有独立守卫。helper 进程既是执行者又是守卫，钩子装不上就启动失败；进程死了由插件侧感知（`src/sidecar.js` 的 pipe 断）。比我们粗糙：我们 `src/overlay/guard.mjs:182` 有显式 fail reason。

### 1.7 截图与坐标

| 项 | 它的做法 | 出处 |
|---|---|---|
| 抓取方式 | **WGC only**（Windows.Graphics.Capture）。官方常量文件里用 PE 导入表扫描证明官方 helper 里 `PrintWindow/BitBlt/StretchBlt/GetDIBits/GetDC` 全不存在 | `parity/official-constants.json` `capture.wgcOnlyPath` |
| 编码 | JPEG q=0.8（`ImageQuality` 属性 + 浮点 `0.8f` 的 VA 证据） | 同上 `capture.jpegQuality` |
| 捕获光标 | `SetIsCursorCaptureEnabled(true)` | 同上 |
| DPI | 归一化到 **96 逻辑像素**：`max(1, (v*96 + dpi/2)/dpi)`；`dpi.rs:27-36` 的 `dpi_scale`；`dpi.rs:40-41` 的 `logical_to_physical` 做窗口相对逻辑坐标 → 物理坐标 | `parity/official-constants.json` `capture.scaleBaseDpi`、`dpi.rs` |
| 缩放 | **默认不缩**。`maxImageEdge` 默认 **0 = 关闭**，注释明写「官方 string 表里没有 maxEdge 概念，加它是 DSH 扩展、会破坏 official parity」 | `src/index.js:530-532`、`parity/official-constants.json` `maxImageEdge` |
| 坐标契约 | **窗口相对逻辑像素**，换算在 helper 里做 | `helper-rs/src/dpi.rs:40` |

**有没有处理宿主请求侧 640k px 二次缩放？——没有 [证实]。**
证据：截图经 `attachments.saveImage/saveImages` 入库（`src/tool.js:830-860`）后，**从不回读返回的 `ref.width/height`**；全 `src/*.js` 搜 `imageScale` / `originalDimensions` / `ref.width` **零命中**（只有 `maxImageEdge` 配置相关命中）。默认 `maxImageEdge=0` 意味着它把原始分辨率（1920×1080 = 2.07MP，甚至 4K）直接交给附件管线，**必然**触发宿主侧请求预算二次缩放，而模型拿到的仍是"窗口相对逻辑像素"的坐标系 → **模型照图点，就会偏**。

这正是我们 `src/runtime.js` 里 `maxPixels: 600000` + 信封回显 `scale` + 代码内反算的价值所在（见 `notes/comparison.md:26`、`notes/positioning.md:11`）。它是**开环**，我们是**闭环**。

### 1.8 值得抄的 3 件事 + 不值得抄的

| # | 抄什么 | 改我们哪个文件 | 工作量 | 风险 |
|---|---|---|---|---|
| **1** | **`SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`**：overlay 建窗后调一次，把药丸从自己的截图里排除；并用 `GetWindowDisplayAffinity` 回读自检 | `src/overlay/overlay.ps1`（我们已有 `WS_EX_LAYERED|TRANSPARENT|NOACTIVATE|TOOLWINDOW`，见 `overlay.ps1:61,152`，但 `DisplayAffinity` 全仓库 0 命中 [证实]） | **0.5 天**（一个 P/Invoke + 2 行调用 + 自检） | 低。Win10 2004+ 才可靠；老系统返回失败要静默降级 |
| **2** | **「被拒 → 问 → 带 `x-oai-cua-approved-app` 重试」的 per-app 审批范式** + "免问放行也记账"的审计模型 | `src/tools.js`（新增 `approvalDefault`/`approvalTools` 配置 + `resolveRefusal` 分支）、`src/runtime.js`（拿 `ctx.get('approval')`） | 2~3 天 | 中。要接 DSH 审批服务，且**绝不能自行合成批准**；`never` 策略下的 auto-grant 要保留显式 outcome |
| **3** | **`list_apps` 的已安装应用枚举**（开始菜单 .lnk + WindowsApps alias + `shell:AppsFolder` + App Paths + Appx）+ 磁盘缓存 | 新增 `src/win/app-catalog.ps1` 或塞进 `src/win/win-host.ps1`，`src/tools.js` 的 `app_window` 加 `launch` 的候选列表 | 2 天 | 中。枚举耗时（首次 1~3s）、Appx 需 `Get-AppxPackage` 权限、缓存路径要放我们的目录不是 `%LOCALAPPDATA%\computer-use-app-catalog` |

**明确不值得抄**：
- **反编译 parity 常量工程**（`parity/` 47 个 md + official-constants.json）：一次性成本极高，绑定某一个 build，且**不可复验**（依赖作者 D 盘上的 Ghidra 产物）。我们要不要对齐官方，应该对 `docs/api.md` 这种文档面，不要对二进制。
- **Rust + Swift + Python 三引擎并存**：我们零运行时依赖 + 常驻 PowerShell 的单引擎是资产，不是债。
- **D2D 光标精灵 + 运动曲线**：42KB渲染代码换"幽灵鼠标看得见"，投入产出极差。
- **`batch_actions`**：与我们 `ui_element` / `computer` 的语义重叠，且它的批量语义要求"批内不做检查点"，风险高于收益。
- **`start_audio_recording`**：完全超纲。

### 1.9 安全问题

| 严重度 | 问题 | 出处 |
|---|---|---|
| **高** | **仓库内提交 2.5MB 预编译 Rust exe**（`helper-rs/bin/dsh-computer-use.exe`，2,582,528 B），安装即运行，源码与二进制无法对应核验。这是三个仓库里唯一的二进制分发 | 目录树 + `src/paths.js:55-71`（`shipped` 路径优先级） |
| **高** | **Chrome 扩展权限过大且明确用于"接管登录态"**：`permissions: ["tabs","debugger","scripting","downloads","history","nativeMessaging"]`、`host_permissions: ["<all_urls>"]`；扩展自述 "Claim existing Chrome/Edge tabs (**login state**)"；`background.js:73` 用 `fetch(targetUrl, { credentials: 'include' })` 抓页面再把内容 `POST` 到 `127.0.0.1:8765/ingest` | `computer_use/chrome_extension/manifest.json`、`computer_use/chrome_extension/background.js:73,98` |
| 中 | 上一条的后果：**已登录页面的整页内容进模型上下文**。虽然只到本地回环（`extension_hub.py:270` 绑 `127.0.0.1`，非 `0.0.0.0` [证实]），但"外发"的对象是模型——等于把邮箱/后台/网银页面喂给 LLM | `computer_use/extension_hub.py:209,270` |
| 正面 | `env_allowlist` 白名单注入环境变量（不是全量继承）；Windows 键族默认禁用；体验笔记写入前脱敏 `LOCALAPPDATA/APPDATA`；批准失败一律 fail closed；无公网出站 | `dsh-plugin.json` `tools.env_allowlist`、`src/experience.js:115-122`、`tool.js:752-786` |
| 无风险项 | 无任意命令执行面（插件不暴露 shell 工具；`launch_app` 按 app id 启动属设计内且过审批）；模型入参里没有文件路径参数，无路径穿越面 [证实：`"path"/"file"` 类 schema 参数 0 命中，仅 helper 输出内部路径] |

---

## 二、esch30636 / dsh-computer-use（★1，28 文件）

### 2.1 一句话定位 + 规模

**一句话**：**零依赖的纯 PowerShell 助手 + 三个 JS 文件**，做「观察一次 → 做一个动作 → 再观察」的严格单步循环，配一个**独立进程的 WPF 液态玻璃 overlay** 当可见性/急停器。

| 项 | 事实 | 出处 |
|---|---|---|
| 文件数 | 28 | 目录树 |
| 语言分布 | `.js` 7 / `.md` 7 / `.ps1` 7 / `.mjs` 3 | 同上 |
| native | **无**。C#/Rust 都没有；Win32 全靠 PowerShell 里 `Add-Type` 现场编译 `P/Invoke` | `helper/CuOverlay.ps1:88`（`GetAsyncKeyState` DllImport） |
| npm 依赖 | **无 `dependencies`、无 `peerDependencies`**；全仓库只有一行外部 import：`import { defineTool } from '@deepseek-ai/dsh-tools'` | `package.json`、`lib/tools.js:1` |
| 体量 | JS ~120KB（`lib/tools.js` 43KB 最大）+ PS 92KB（`helper/ComputerUseAgent.ps1`）+ 22KB overlay | 文件大小 |
| 进程结构 | `lib/helper-client.js` spawn `powershell.exe` 跑 `helper/ComputerUseAgent.ps1`（常驻、行式 JSON-RPC）；overlay 是**第二个** PowerShell 进程 | `lib/helper-client.js:15,86-131` |

对我们最有参考价值的一点：**这是三个里唯一和我们技术选型完全同构的**（零依赖 + 常驻 PowerShell 宿主 + JS 侧薄壳）。它的坑大概率也是我们的坑。

### 2.2 工具面清单 + 与我们的对照

**5 个工具**（`lib/tools.js`）：

| 工具 | 说明 |
|---|---|
| `computer_list_windows` | 列窗口 |
| `computer_observe` | 一次观察：截图 + AX 树 + 窗口信息 + `state_id` + `coordinate_scale`/`origin` |
| `computer_action` | **恰好一个**动作，消费 `state_id` |
| `computer_sequence` | 一次调用串多步（`lib/tools.js:666`） |
| `computer_launch_app` | 启动应用 |

`computer_action` 的 **12 个 action**（`lib/tools.js:594` 逐字）：
`click` / `double_click` / `right_click` / `middle_click` / `mouse_move` / `type` / `key` / `scroll` / `drag` / `set_value` / `wait` / `activate_window`。

**它有什么我们没有的**：
1. **`state_id` 一次性消费 + 严格单步纪律**：每个输入动作都会把观察作废，用过的 `state_id` 再提交直接报错「element indexes and coordinates expire after every action」（`lib/tools.js:169`）。这是一条**结构性强约束**，比我们靠提示词要求"用完重截"更硬。
2. **`coordinate_scale` / `origin` 信封**：观察返回里显式回显坐标系（`lib/tools.js:264-272`），和我们做法一致（见 §2.7）。
3. **`computer_sequence`**：一次调用多动作（注意：与它自己的单步纪律有张力，靠"整组不可重放"约束）。
4. **抗遮挡截图 `PrintWindow`**（见 §2.7）。
5. **`activate_window` 作为独立动作**（我们放在 `app_window:focus`）。
6. **进程黑名单 / 窗口类黑名单 / 允许列表三件套**（`lib/config.js:88-92`），并在 helper 启动握手时 `set_policy` 下推（`lib/helper-client.js:143-147`）。

**我们有什么它没有的**：`cursor` / `status` / `resume`；`ui_element` 的 8 个动作（它是把树当文本喂给模型 + `element_index`，没有 `find`/`tree`/`expand` 这类查询动作）；`clipboard`；`app_skill`；`app_window:minimize/maximize/restore`；`middle_click` 之外我们没有的它也有——总之两边动作面高度重叠，它的差异主要在**纪律**而非**能力**。

### 2.3 「Codex 13-method」

**N/A**。它不是 parity 路线：没有任何 `parity/` 目录，README 不宣称对齐 Codex，动作面是自研的 12 个。最接近的映射：`get_window_state → computer_observe`、`click/scroll/drag/type_text/press_key/set_value/activate_window` 一一对应，**缺** `list_apps` / `launch_app`（它只有 `computer_launch_app`，没有应用目录）/ `get_window` / `perform_secondary_action`。

结论：**它没有 Codex 13-method 这回事，别按"对标官方"去读它**；它的价值在纪律和 overlay。

### 2.4 按 App 审批

**没有 per-app 审批**，只有一套**启发式风险判定**：
- `Config.confirmRiskyActions: true`（默认） + `policy.assessAction({action, args, state, window, elementName})`（`lib/policy.js:174-217`）：
  - 元素名/按钮名命中破坏性正则（`lib/policy.js:30`）→ 要求确认；
  - `type` 超过 8000 字符直接拒（`policy.js:148`）；
  - `key` 是 `Ctrl+L` 时给警告（可能选中地址栏，`policy.js:202`）；
  - `drag` 一律给警告（可能移动文件，`policy.js:210`）。
- 确认通道：`ctx.get('approval')`，但**失败语义比我们想抄的松**：
  - 无审批通道且 `warnWhenApprovalUnavailable: true`（默认）→ **不阻断，继续执行，只在结果里附 `WARNING: ... This action was NOT user-confirmed`**（`lib/tools.js:99,124`；配置在 `lib/config.js:96-98`）。
  - 只有在 `exec.agent` 存在但返回非允许时才是硬失败（`lib/tools.js:129`）。

**默认值问题**：`warnWhenApprovalUnavailable: true` 意味着"审批服务不可用"= 继续裸奔 + 一句警告。这**不是 fail closed**，比我们弱一档。值得抄的是它的**风险分类维度**（按元素名 + 动作类型 + 参数特征打分），不值得抄的是这个默认值。

### 2.5 OCR

**没有 OCR**（0 命中）。文本只能靠 UIA 树。

### 2.6 overlay / 急停

**overlay 画法**：**独立进程**的 WPF 应用（`helper/CuOverlay.ps1` 22KB），画两个窗：
- `vignette`（全屏渐晕）+ `island`（顶部状态岛，"正在操控你的电脑 | 按 ESC 终止"，见 `lib/index.js:39`）。
- 样式：`WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE`（`CuOverlay.ps1:121-123`），设完**回读 exStyle 验证** `WS_EX_TRANSPARENT` 是否真的生效（`CuOverlay.ps1:268-283`）；验证失败 → exit 非零，**不走下去**（`CuOverlay.ps1:411-413`）。这个"设完必须回读验证"的习惯很值得学。
- 生命周期：**心跳文件 + 父 PID 双保险**——`DSH_CU_PARENT_PID` 消失就退、`heartbeat` 文件过期（无活动）就退（`CuOverlay.ps1:28-37`）。

**Esc 感知方式**：`DispatcherTimer` **每 80ms 轮询 `GetAsyncKeyState(VK_ESCAPE)`**（`CuOverlay.ps1:467,480-483`），命中就写一个 `escape` 文件；helper 侧每个请求开头和等待期间**读这个文件**（`ComputerUseAgent.ps1:451-459` `Test-CuEscapeRequested`，调用点在 `:518,1527,1861,2053`）。所以 Esc 是**跨进程文件 IPC**，不是同进程钩子。

**有没有"守卫死亡"语义？——有，但是 fail-open（这是它最该被批评的一处）**：
- 每次桌面请求开头 `Invoke-CuOverlayActivity` 刷心跳并尝试重启 overlay（`ComputerUseAgent.ps1:511-519`）；
- 如果 overlay 进程**连续 3 次非零退出**，直接 `OverlayEnabled = $false` 然后 `return`——**从此既没有可见提示、也没有 Esc 保护，键鼠照常注入**（`ComputerUseAgent.ps1:465-480`，原注释 "Do not respawn it forever at the cost of every call: disable the overlay for this helper"）。
- 相比之下 helper 进程本身死掉是 fail closed 的：`HelperUnavailableError` 会把所有 pending 请求失败掉（`lib/helper-client.js:126-131`）。

**我们比它强的地方就在这里**：我们的 `src/overlay/guard.mjs` 在守卫异常时 fail closed（带 fail reason），它反过来降级成裸奔。

### 2.7 截图与坐标

| 项 | 它的做法 | 出处 |
|---|---|---|
| 抓取 | 优先 `PrintWindow`（抗遮挡），失败回落屏幕抓取 | `helper/ComputerUseAgent.ps1`（`Get-WindowCapture` 系列） |
| 落地 | helper 写 PNG 到临时文件 → JS `readFile` → `attachments.saveImage` → 删临时文件 | `lib/tools.js:238-250`、`config.js:93` `keepScreenshots:false` |
| 预缩放 | helper 侧 `screenshotMaxWidth: 1600` / `screenshotMaxHeight: 1200` | `lib/config.js:81-82` |
| **宿主二次缩放** | **处理了，而且是三个里唯一显式回读的做法**：`ref = await attachments.saveImage(...)` 之后用 `imageScaleX = shot.width / ref.width`（`lib/tools.js:264-265`，注释："Image scale = capture pixels per model-visible image pixel (>= 1 when the attachment store downscaled the helper capture further)"），再和捕获缩放相乘：`scale_x = capture_scale_x * imageScaleX`（`:269-270`） | `lib/tools.js:264-272` |
| 坐标契约 | 模型给**截图像素**，`screen = origin + coord * scale`（`lib/tools.js:23`、`lib/index.js:31`） | 同上 |
| DPI | 由 helper 侧处理（`imageScale` 参数 x/y 分轴，`ComputerUseAgent.ps1:1041-1044`） | 同左 |

**结论**：它的坐标闭环**和我们同构，甚至比我们多一层保险**——它把"宿主缩了多少"直接从附件回执里读出来，而不是事先算。我们的 `maxPixels: 600000` 是**预防**（一次缩到位，落在 640k 预算内），它是**事后修正**。两种都对；**两者叠加才是最优**（我们预缩 + 它那种回读校验）。这是它最值得我们抄的一处。

### 2.8 值得抄的 3 件事 + 不值得抄的

| # | 抄什么 | 改我们哪个文件 | 工作量 | 风险 |
|---|---|---|---|---|
| **1** | **附件回执回读校验**：`saveImage` 后用 `ref.width` 反算真实缩放，和我们的 `scale` 比对，不一致就以回执为准并回显警告 | `src/runtime.js`（截图入库处）+ `src/tools.js`（信封字段） | **0.5~1 天** | 低。等价于给闭环加一条断言，能立刻暴露宿主改预算时的坐标漂移 |
| **2** | **overlay 样式设置后回读验证**（`GetWindowLong` 查 `WS_EX_TRANSPARENT` 真的生效），失败就 fail closed 而不是继续 | `src/overlay/overlay.ps1`（我们已有 `WS_EX_TRANSPARENT`，`overlay.ps1:152`，但无回读自检 [证实]） | 0.5 天 | 低 |
| **3** | **`state_id` 一次性消费**：观察令牌用一次即作废，重用即报错 | `src/tools.js`（`computer`/`ui_element` 的输入路径） | 1~2 天 | 中。会改变现有模型调用习惯，可能引发"重复动作被拒"的回归；建议先做成可配置开关 |

**明确不值得抄**：
- **overlay 连续失败 3 次后关闭保护继续跑**（`ComputerUseAgent.ps1:465-480`）：这是我们明确比它强的地方，反向抄等于降低安全水位。
- **80ms `GetAsyncKeyState` 轮询**：我们有进程内钩子/更直接的路径，轮询既慢（最多 80ms 延迟）又有"UI 线程忙就丢"的问题。
- **截图落盘再读**：我们内存直传更好，落盘多一个清理面（它自己也要 `rm` 兜底）。
- **`warnWhenApprovalUnavailable` 默认 true**：审批不可用时继续执行，这条不能抄。

### 2.9 安全问题

| 严重度 | 问题 | 出处 |
|---|---|---|
| **中高** | **`allowWindowsKey` 是死配置**：`config.js:100` 定义默认 false、`config.js:206` 校验、`config.js:232` 参与判断，但真正下推给 helper 时**硬编码** `allow_win_key: false`（`lib/helper-client.js:146`）→ 用户把它设成 true 也不生效。方向上是安全的，但它是**误导性配置**，且说明这条链没人端到端验过 | `lib/config.js:100,206,232` vs `lib/helper-client.js:146` |
| **中** | **审批不可用时继续注入键鼠**（默认 `warnWhenApprovalUnavailable: true`），只加一句 WARNING | `lib/config.js:96-98`、`lib/tools.js:99,124` |
| 正面 | 有进程黑名单（终端/注册表/UAC/密码管理器/安全中心，`ComputerUseAgent.ps1:367`）、窗口类黑名单、可选允许列表；Windows 键族硬禁；helper 启动握手检测安全桌面并告警（`helper-client.js:136`）；取消动作时直接 kill helper（`helper-client.js:260`） | 同左 |
| 正面 | 无外网、无任意命令执行面、模型入参无路径参数；临时截图默认删 | 全仓库 `http(s)` 非 localhost 命中 0 |
| 说明 | 每个工具调用都有 `requestTimeoutMs: 30s`、启动 `90s`（含 Add-Type 编译）、`idleTimeoutMs: 10min`（`config.js:74-79`）——**这些超时值可以直接拿去校准我们的宿主** | 同左 |

---

## 三、shinji00222 / dsh-windows-computer-use（145 文件）—— OCR 重点

### 3.1 一句话定位 + 规模

**一句话**：**C# 原生引擎（`DesktopEngine.exe`）+ TypeScript/MCP 接入层**，卖点是「目标窗口绑定 + 停止机制 + 结果验证 + **Windows OCR**」；是 Yu-tao-Li 那套 PowerShell 实现的 C# 重写。

| 项 | 事实 | 出处 |
|---|---|---|
| 文件数 | 145 | 目录树 |
| 语言分布 | `.mjs` 40 / `.md` 28 / `.ps1` 13 / `.json` 11 / **`.cs` 11** / `.png` 10 / `.jsonl` 7 / `.ts` 7 | 同上 |
| native | **有，C#**：`src/Engine/` 11 个 `.cs`（`WindowsUi.cs` 11.7KB、`VisualBatch.cs` 9.7KB、`InputActions.cs` 8.7KB、`Capture.cs`、`Safety.cs`、`Engine.cs`、`Native.cs`、`Arguments.cs`、`Fixture.cs`、`Program.cs`） | 同左 |
| 构建 | `net10.0-windows10.0.19041.0`，`UseWindowsForms` + `UseWPF`，`TreatWarningsAsErrors`；需 **.NET 10 SDK**，发布自包含 exe（用户无需装 .NET） | `src/Engine/DesktopEngine.csproj`、`README.md:29-33` |
| npm 依赖 | `@modelcontextprotocol/sdk ^1.27.1` + `ajv ^8.18.0`，两者 `bundleDependencies` 内联；peer `@deepseek-ai/dsh-mcp-client` / `schemastery`（都 optional） | `package.json` |
| 血统 | fork 自 **Yu-tao-Li/dsh-computer-use-win 0.4.3**（commit `822ca8e`），更上游 **cgissing/windows-computer-use**；`upstream/` 是归档副本、**不参与构建** | `NOTICE.md:1-9` |
| 进程结构 | TS 侧 spawn **一个常驻** `native/DesktopEngine.exe`，行式 JSON 往返（不是每次调用起进程） | `src/adapter/backend.ts:1-8` |

> 提醒：`upstream/scripts/windows-uia.ps1` 有 134KB，是**上游归档**，不是本项目的运行时。但对我们的 OCR 落地极其有用——它是**纯 PowerShell 环境里做 WinRT OCR 的完整可跑样例**（见 §3.5.2）。

### 3.2 工具面清单 + 与我们的对照

**25 个 MCP 工具**（前缀 `mcp__shin_desktop__windows_computer_use_`，`src/adapter/catalog.ts` 各工具 `"name"` 行）：

`health`(7) / `snapshot`(16) / `accessibility_tree`(112) / `list_windows`(197) / `find`(217) / `element_info`(313) / `click`(381) / `double_click`(455) / `move`(529) / `drag`(587) / `scroll`(654) / `type_text`(720) / `keypress`(782) / `focus`(833) / `invoke`(888) / `set_value`(943) / `activate_window`(1006) / `wait`(1040) / **`ocr`(1056)** / `screenshot`(1112) / `wait_for`(1160) / `close_window`(1266) / `move_window`(1300) / `resume`(1344) / `run_batch`（`src/adapter/batch-schema.ts:11`）。

风格是「**一个动作一个工具**」，不做 action 派发。

**它有什么我们没有的**：
1. **OCR**（§3.5，本次重点）。
2. **`run_batch`**：先 `screenshot`，然后一张截图里规划 **1~8 个动作**一次执行，返回最终截图 + 逐步结果；支持 `checkpoint: true` 在关键步（跳转/提交/开菜单）停下；滚动与 Enter 自动结束当前组；检测到窗口移动/焦点变化/标题变化/Esc 即中止剩余动作，**整组不可重放**（`README.md:46-58`、`batch-schema.ts:3-17`）。这是纯省 token 的设计，我们目前没有。
3. **`wait_for`**（条件轮询）、**`close_window`** / **`move_window`**。
4. **`find` / `element_info` / `invoke` / `focus` 拆成独立查询工具**（我们把它们合在 `ui_element` 的 8 个 action 里——我们更省工具槽位，它更省参数）。
5. **MCP server 模式**（`bin: dist/server.js`，可给别的 MCP 客户端用）。
6. **跨进程互斥** `Local\DSH-Desktop-Native-Desktop-v1`（`Safety.cs:8`）——防同一台机器上两套引擎抢桌面。我们也可以加。

**我们有什么它没有的**：`clipboard`（get/set）；`app_skill`；`cursor` / `status`；`right_click` / `middle_click` 作为独立动作；`app_window:minimize/maximize/restore`；**5 工具 33~36 action 的聚合面对比它的 25 个扁平工具**（我们的工具槽位和 token 开销低得多）。

### 3.3 「Codex 13-method」

**N/A**。它是 MCP 工具面，不宣称 parity，没有 `parity/` 目录，也不引用 Codex。它的「13 方法对照」只能说：13 个里它能覆盖 11 个（缺 `list_apps`/`launch_app` 的应用目录、`get_window` 的绑定再水合；`perform_secondary_action` 无对应），另外多出 OCR / batch / wait_for / close/move_window 这些官方没有的。

### 3.4 按 App 审批

**完全没有 [证实]**。全仓库（含 `src/`、`docs/`、`tests/`）搜 `approval` **0 命中**；没有 `ctx.get('approval')`、没有确认弹窗、没有白名单审批。

它的替代品是**结构约束**（不是审批）：
- 每个输入工具都要求先观察目标窗口（「操作前要求观察目标窗口」，`README.md:17`）；
- 观察给 `observationId` 令牌，窗口移动/焦点变化/标题变化/token 陈旧 → **拒绝盲目输入**（`catalog.ts` 各工具 `observationId` 参数、`README.md:17`）；
- `resume` 工具要求"明确的新人类请求"才能解除停止（`catalog.ts:1345`）。

**这是三个仓库里最弱的一环**：键鼠注入**不需要用户确认**，唯一刹车是 Esc + 窗口绑定。我们在这点上是领先的（有审批 + Esc + 守卫 fail closed），**但它的"观察令牌 + 漂移拒绝"比我们的窗口漂移检测更结构化**，可以互补。

### 3.5 OCR 实现（重点，写到能照着实现）

#### 3.5.1 一句话答案

**引擎是 `Windows.Media.Ocr`（WinRT 系统 OCR），不是 tesseract，不是云 API，不联网。** 两套实现：
- **主实现（C# 引擎）**：`src/Engine/Capture.cs:57-83`，跑在常驻的 `DesktopEngine.exe` 进程里；
- **备用/上游样例（PowerShell + 现场编译 C#）**：`upstream/scripts/windows-uia.ps1:884-978`，跑在 PowerShell 宿主进程里，`csc.exe` 编译一个静态类缓存成 `%TEMP%\wcu-ocr-<hash>.dll`。

对我们来说**第二条才是可直接复用的**（我们是 PowerShell 宿主，见 §3.5.4）。

#### 3.5.2 关键事实表

| 问题 | 答案 | 出处 |
|---|---|---|
| 引擎 | `Windows.Media.Ocr.OcrEngine` | `Capture.cs:5,61`；`windows-uia.ps1:888,916` |
| 跑在哪 | C#：`DesktopEngine.exe` 的**单 worker 线程**（`[STAThread]` + `BlockingCollection` 队列，一次处理一个请求）；PS 版：PowerShell 宿主进程内调编译好的静态类 | `Program.cs:8-45`；`windows-uia.ps1:980-984` |
| 语言包怎么选 | **`OcrEngine.TryCreateFromUserProfileLanguages()`** —— 完全跟随当前用户的 Windows 语言偏好列表，**没有显式指定语言、没有遍历 `AvailableRecognizerLanguages`、没有允许调用方传 language** | `Capture.cs:61`；`windows-uia.ps1:916` |
| 语言包缺失 | 返回 null → 抛 `OCR_UNAVAILABLE: install a Windows OCR language pack.`（PS 版抛 "No OCR engine available (no OCR language installed for this system)."） | `Capture.cs:61`；`windows-uia.ps1:917-918` |
| 怎么调 async WinRT（C#） | `Capture.Ocr()` 是同步外壳：`Recognize(frame,args).GetAwaiter().GetResult()`；内部 `DataWriter.WriteBytes(png) → StoreAsync → InMemoryRandomAccessStream → BitmapDecoder.CreateAsync → GetSoftwareBitmapAsync(Bgra8, Premultiplied) → engine.RecognizeAsync(bitmap)` | `Capture.cs:57-65` |
| 怎么调 async WinRT（PS） | 自己写 `WaitOp<T>(IAsyncOperation<T>)`：用 `TaskCompletionSource` + `op.Completed` 回调，按 `AsyncStatus.Completed/Canceled/Failed` 分别 `SetResult/SetCanceled/SetException`，再 `GetAwaiter().GetResult()`。**这是 PowerShell 里最稳的 WinRT async 桥法**（PS 5.1 无法可靠解析 WinRT 类型字面量，所以必须编译 C#） | `windows-uia.ps1:893-905`、注释在 `:875-883` |
| 结果带坐标吗 | **带，词级 + 行级**：`result.Lines[].Words[].BoundingRect`（X/Y/Width/Height）；返回 `{ text, lines:[{text, words:[{text, boundingBox}]}], matched:[...], source:"Windows.Media.Ocr", imageScale, bounds }` | `Capture.cs:66-82` |
| 坐标系 | **物理屏幕 px**：`frame.Bounds.X + (int)(r.X / frame.Scale)`（先除以截图缩放还原到物理像素，再加窗口原点）；`matched` 额外给中心点 `x/y` | `Capture.cs:68-72,74-77` |
| query 匹配 | 把 query 和整行文本都做 `Compact()` = 去掉所有空白 + `ToLowerInvariant()`，然后 `Contains`；**命中按整行合并框**（`boxes.Min/Max`）并给中心点。注释："Match whole visible lines too, so segmented Chinese queries still work" | `Capture.cs:66,73-77,83` |
| 耗时 | **仓库内没有任何测量值 [未证实]**。定性 [推测]：`OcrEngine` 创建与语言数据加载是主要固定成本（首次几十~几百 ms，之后同进程复用），单张 1600px 宽位图识别通常百 ms 级。它把 OCR 跑在**已经 downscale 过的帧**上（`maxWidth` schema 默认 1920 / 代码默认 1600），快但小字号精度会掉——这是可换成"OCR 用原图、只把结果图缩给模型"的优化点 | `Capture.cs:43`（`maxWidth` 默认 1600）、`catalog.ts:89-93`（schema 默认 1920） |
| 失败怎么降级 | **没有自动降级链**。`OCR_UNAVAILABLE` 直接抛给模型；识别为空则返回空 `lines`（不报错）；上游版在 UIA 树稀疏时反向提示"改用 ocr"（`windows-uia.ps1:2062`），在目标无响应时提示改用 desktop 截图（`:2551`）；无法截取时抛"no capturable surface"（`:2556`） | 同左 |

#### 3.5.3 关键代码（≤15 行，C# 主实现，`src/Engine/Capture.cs:57-77`）

```csharp
internal static object Ocr(Frame frame, Arguments args) => Recognize(frame, args).GetAwaiter().GetResult();
private static async Task<object> Recognize(Frame frame, Arguments args) {
    var engine = OcrEngine.TryCreateFromUserProfileLanguages()
        ?? throw new InvalidOperationException("OCR_UNAVAILABLE: install a Windows OCR language pack.");
    using var stream = new InMemoryRandomAccessStream();
    using (var writer = new DataWriter(stream)) { writer.WriteBytes(frame.Png); await writer.StoreAsync(); writer.DetachStream(); }
    stream.Seek(0);
    var decoder = await BitmapDecoder.CreateAsync(stream);
    using var bitmap = await decoder.GetSoftwareBitmapAsync(BitmapPixelFormat.Bgra8, BitmapAlphaMode.Premultiplied);
    var result = await engine.RecognizeAsync(bitmap);
    // 每个 word.BoundingRect → box = { frame.Bounds.X + r.X/frame.Scale, frame.Bounds.Y + r.Y/frame.Scale, ... }
}
```

要点：**PNG 字节直接喂给 `BitmapDecoder`，全程内存，不落盘**；`GetSoftwareBitmapAsync(Bgra8, Premultiplied)` 的格式必须和 `BitmapDecoder` 输出对齐，否则 `RecognizeAsync` 会抛。

#### 3.5.4 我们怎么落地（照这个抄，改动点精确到文件）

**为什么走 PowerShell 变量（3.5.2 第二条）而不是 C#**：我们的宿主是 `src/win/win-host.ps1`（78KB，常驻）。加一个 `ocr` 动词的最小改动路径是：

1. **在 `src/win/win-host.ps1` 里内置一段 C# 源码 + 首次调用时编译**，照 `windows-uia.ps1:941-978` 的配方：
   - 引用 `C:\Windows\System32\WinMetadata\` 下的 `Windows.Media.winmd`、`Windows.Storage.winmd`、`Windows.Graphics.winmd`、`Windows.Foundation.winmd`（**只引用到的那几个，命令行才不超长**）；
   - **不能用 `Add-Type`**（它用 `Assembly.Load` 预校验引用，加载不了 `.winmd`），必须直接调 `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`，`/target:library /out:<%TEMP%\wcu-ocr-<源hash>.dll>`，每个 `/r:` 单独一个参数；
   - 编完 `[Reflection.Assembly]::LoadFrom($dll)`；用源码 hash 命名实现"编译一次、之后复用"。首次约 1~3s，后续 0 成本。
2. **async 桥用 `WaitOp` 那套 `TaskCompletionSource` + `op.Completed`**（见 3.5.2 表），**不要**在 PowerShell 里直接 `[Windows.Media.Ocr.OcrEngine]::...`（PS 5.1 解析不了 WinRT 类型字面量）。
3. **输入用我们自己的截图字节**：我们已经有内存截图（`src/win/backend.mjs`），把它写成临时 PNG 文件传路径（PS 版就是这么做的：`StorageFile.GetFileFromPathAsync`），或干脆用 `InMemoryRandomAccessStream`——**建议落临时文件**，PS 里拼 `IRandomAccessStream` 更容易出错，而临时文件用完即删（我们的临时目录策略已在）。
4. **坐标系复用我们的闭环**：`Capture.cs` 那个 `frame.Bounds.X + r.X/frame.Scale` 我们**不需要**——我们的截图像素→物理像素映射已经在 `src/runtime.js` 里算好并在信封里回显。OCR 只要返回**截图像素坐标系**的词框（即 `r.X, r.Y, r.Width, r.Height` 原样），由现有反算逻辑统一处理，**一份坐标换算只留一处**。
5. **语言包**：照抄 `TryCreateFromUserProfileLanguages()`，但要**加一条前置探测**——`OcrEngine.AvailableRecognizerLanguages`（C# 侧）里有没有中文；没有就返回明确错误（"未安装中文 OCR 语言包，设置 → 时间和语言 → 语言 → 添加语言 → 中文(简体) 的可选功能 → 光学字符识别"）。这是我们能做到比它更好的地方：它只会丢一句 `OCR_UNAVAILABLE`。
6. **工具面**：建议加成 `ui_element` 的第 9 个 action（`ocr`，参数 `query?` / `windowId?`），而不是新开第 6 个工具——保我们的工具槽位优势；返回 `{ text, lines:[{text,box}], matched:[{text,box,center}] }`。
7. **降级链**（它没有，我们要有）：`ui_element:tree` 节点数 < 10 时（我们已经能测到）→ 自动建议/自动补一次 `ocr`；OCR 空结果 → 回 `screenshot` 让模型自己看，并明确告知"OCR 未识别到文字"。

工作量估计：**3~4 天**（编译配方 + async 桥 + 工具接入 + 中文包探测 + 测试）。风险：中（首次编译失败要有清晰的降级信息；`%TEMP%` 残留 DLL 要清理策略）。

### 3.6 overlay / 急停

**overlay 画法**：WinForms 无边框窗体当 banner，350×36，右上角（`Safety.cs:33-37,76-79`）：
- `ShowWithoutActivation => true` + `CreateParams.ExStyle |= 0x08000000 (WS_EX_NOACTIVATE) | 0x80 (TOOLWINDOW) | 0x20 (TRANSPARENT)`（`Safety.cs:89-93`）——三个 ex-style 与另两个仓库完全一致，说明这是这类 overlay 的标准配方；
- 窗体和 Esc 监听**在同一个专用 STA 线程**上，靠 `Application.Run()` 起消息泵（`Safety.cs:41-54`）。

**Esc 感知**：`SetWindowsHookEx(13=WH_KEYBOARD_LL, ...)` + `Application.Run()` 消息循环（`Safety.cs:5,21-25,48`）。
- 回调判据：`code >= 0 && (wparam == 0x100 || wparam == 0x104) && Marshal.ReadInt32(lparam) == 27`（`WM_KEYDOWN`/`WM_SYSKEYDOWN` + vkCode==VK_ESCAPE），命中就 `Interlocked.Increment(escapeEvents); Stop();`。
- **Esc 不吞键**：总是 `CallNextHookEx`（`Safety.cs:25`）。所以用户按 Esc 之后那个键还会传给前台窗口——体验上更安全（不会"吃掉"用户的 Esc），但不如 wushi2333 那样能保证"停止键不外泄"。
- **就绪握手（最值得抄的一段）**：`hook != 0` 还不够，还要 `banner.BeginInvoke(() => ready.Set())` 成功才认为"钩子线程真的在泵消息"；10 秒超时抛 `STOP_LISTENER_TIMEOUT`；`hook == 0` 抛 `STOP_LISTENER_UNAVAILABLE`（`Safety.cs:48-54`）。构造失败直接让整个引擎起不来。

**有没有「守卫死亡」语义？——有，而且是我们这三个里做得最好的一份**：
- `ListenerAlive => thread.IsAlive && hook != 0 && startError is null`（`Safety.cs:19`）；
- `Check()` 里线程死了就抛 `STOP_LISTENER_UNAVAILABLE`（`Safety.cs:66-70`）——**fail closed**；
- **每个动作执行完都 `Check()`**：`Program.cs:42` `if (action is not ("health" or "resume" or "run_batch")) safety.Check();`；
- 停止是**按 turn 粘住**的：`blocked[turn] = 0`，只有新的人类请求走 `Resume(key)` 才解除（`Safety.cs:57-64`）；适配层还叠了一层 `blockedTurns`（`src/adapter/backend.ts:41,59-63`）→ 双保险；
- 跨进程互斥 `Mutex("Local\DSH-Desktop-Native-Desktop-v1")`，拿不到就 `DESKTOP_BUSY`（`Safety.cs:74-77`）。

**结构性亮点（顺手记下）**：请求走 `BlockingCollection` 单 worker 串行执行，但**读线程独立**——收到 `{"action":"cancel"}` 立刻 `safety.Stop()` 并回执，**worker 正忙于长动作时也能被取消**（`Program.cs:22-24`）。这是 out-of-band 取消通道，比"只能杀进程"优雅得多。

### 3.7 截图与坐标

| 项 | 它的做法 | 出处 |
|---|---|---|
| 抓取 | `scope:"desktop"` → 整个虚拟屏；否则目标窗口。**非前台窗口时先试 `PrintWindow(hwnd, hdc, 2)`**，再对结果做**全黑采样检测**（最多 10×10 采样点），全黑就当失败 | `Capture.cs:19-40` |
| 回落 | `CopyFromScreen`，且只抓窗口与虚拟屏的交集；交集为空抛 `WINDOW_OFFSCREEN`；此时 `occludedPossible=true` 上报给模型 | `Capture.cs:33-41` |
| 缩放 | `maxWidth`（schema 默认 1920，代码默认 1600）等比缩放，`scale = maxWidth/width` | `Capture.cs:43-46` |
| 返回 | `{ mimeType, base64, bounds, imageScale, width, height, source, occludedPossible }`——**内存 base64，不落盘** | `Capture.cs:49-50` |
| DPI | 进程级 `Application.SetHighDpiMode(PerMonitorV2)`（`Program.cs:10`），坐标系一律**物理像素** | 同左 |
| 坐标契约 | 模型面对的是**物理屏幕 px**；截图描述写 "SCREEN = bounds origin + image/imageScale"，即**让模型自己做除法** | `catalog.ts:1113` |
| 宿主 640k 二次缩放 | **没有处理**：`imageScale` 只描述它自己那次缩放，不回读附件回执 | `Capture.cs:49`、`Capture.cs:80` |

**三方坐标契约对比（重要）**：

| 仓库 | 模型看到的坐标系 | 谁做换算 | 是否闭环 |
|---|---|---|---|
| wushi2333 | 窗口相对逻辑 px（96dpi 归一） | helper（`logical_to_physical`） | **开环**（不回读附件） |
| esch30636 | **截图像素** + `origin`/`scale` 信封 | JS（`shots`/`attachment ref`） | **闭环**（回读 `ref.width`） |
| shinji00222 | **物理屏幕 px** | **模型自己算** | **开环**（把除法丢给模型） |
| **我们** | **截图像素** + `scale` 信封（≤600000px 预缩） | **代码内反算**（`src/runtime.js`） | **闭环** |

结论：**我们的做法是四者里最稳的**；esch30636 的"回读回执"是唯一值得加的一层校验。

### 3.8 值得抄的 3 件事 + 不值得抄的

| # | 抄什么 | 改我们哪个文件 | 工作量 | 风险 |
|---|---|---|---|---|
| **1** | **Windows.Media.Ocr**（§3.5.4 的完整落地路径：`csc` 编译 C# WinRT 助手 + `WaitOp` async 桥 + `Compact()` 去空白匹配 + 中文包探测 + 降级链） | `src/win/win-host.ps1`（新增 `ocr` 动词 + 内嵌 C# 源码）、`src/tools.js`（`ui_element` 第 9 个 action）、`src/skills.js`（技能里加"UIA 不行就用 OCR"的指引） | **3~4 天** | 中。首次编译失败要有清晰降级；`%TEMP%` DLL 清理；OCR 只在 UIA 稀疏时兜底，别当默认路径（费时且不准） |
| **2** | **Esc 监听的"就绪握手 + 每动作后 Check()"组合**（`hook!=0` 不够，还要 `BeginInvoke` 成功才算就绪）+ **out-of-band cancel 通道**（读线程独立于 worker） | `src/overlay/guard.mjs`（就绪判据）、`src/win/win-host.ps1`（加一条与主循环并行的取消读取） | **1~2 天** | 低。纯健壮性增强，不改协议 |
| **3** | **`PrintWindow` 抗遮挡抓取 + 全黑检测回落**（我们抓后台窗口时同样会遇到"抓了个全黑图"） | `src/win/win-host.ps1`（截图动词） | 1 天 | 低。注意 `PrintWindow` 对部分 GPU 加速窗口无效，必须保留 `CopyFromScreen` 回落 + `occludedPossible` 上报 |

**明确不值得抄**：
- **25 个扁平 MCP 工具**：token 成本高、工具槽位浪费。我们 5 工具聚合是对的。
- **把物理屏幕坐标丢给模型自己算**（`catalog.ts:1113`）：这是开环，模型会算错。我们的闭环保住。
- **`mcp__` 前缀 + MCP 双栈**：我们是 cordis 原生，多一层 MCP 只增加故障面。
- **`run_batch` 的"整组不可重放"复杂度**：收益是省 token，代价是错误恢复变难；我们 `ui_element` 已经能表达组合意图，暂不需要。
- **`--fixture` 测试模式和 `Fixture.cs`**：思路可以学（我们有 `test/` 已覆盖），但不必照搬实现。

### 3.9 安全问题

| 严重度 | 问题 | 出处 |
|---|---|---|
| **高** | **零审批**：键鼠注入不需要任何用户确认，唯一刹车是 Esc + 窗口绑定。模型一旦被页面内容诱导，可以直接在用户桌面上点任何东西 | 全仓库 `approval` 命中 0 [证实] |
| 中 | **`resume` 工具**：停止后可以由模型自己调 `resume` 继续（描述说"Standalone MCP only: resume after an explicit new human request"，但**代码层面没有校验"新的人类请求"是否真的存在**） | `catalog.ts:1344-1345` |
| 中 | **预编译 exe 信任**：`native/DesktopEngine.exe` 不在源码仓库里（README 明说源码安装不能替代 Release 包），必须从 Releases 下载 → 供应链集中在一个二进制上；但好的一面是**构建可复现**（`.csproj` + `npm run build`，比 wushi2333 直接 commit exe 强） | `README.md:26-33`、`.csproj` |
| 正面 | 无外网（`http(s)` 非注释命中 0）；`REQUEST_TOO_LARGE` 2MB 上限（`Program.cs:19`）；UTF-8 无 BOM 输出；单实例 mutex；口令/密码控件隐藏（`verification.md:43`）；停止按 turn 粘连不可自动恢复 | 同左 |
| 正面 | 无任意命令执行面、模型入参无文件路径参数 | 全仓库 `"path"/"file"` schema 参数仅 OCR/截图内部输出路径 |

---

## 四、跨仓库结论：性价比排序与我们的优势

### 4.1 最值得抄的 1 件事（性价比第一）

**Windows.Media.Ocr（来自 shinji00222）**。理由：
1. **能力缺口最大**：我们 5 工具 33 action 里没有任何"看图读字"的能力，UIA 不覆盖的自绘界面（Electron 画布、游戏、Qt、RDP、某些 Office 富文本）目前只能靠模型看截图猜坐标；OCR 能把"猜"变成"测得"。
2. **成本可控**：`Windows.Media.Ocr` 是**系统自带、零依赖、不联网**，与我们"零运行时依赖"的定位完全兼容——不需要引 tesseract、不需要云 API。
3. **有可直接照抄的 PowerShell 配方**：`upstream/scripts/windows-uia.ps1:884-978` 是同一技术选型（PowerShell 宿主）下的完整实现，连 `csc.exe` 引用哪些 `winmd`、怎么绕开 `Add-Type` 的限制、怎么用 `TaskCompletionSource` 桥 async 都写好了。
4. **和我们的闭环天然咬合**：它返回词级 `BoundingRect`，我们已有的"截图像素→物理像素"反算逻辑可以直接复用，**不需要第二套坐标换算**。

### 4.2 其余值得抄的（按性价比）

2. **`WDA_EXCLUDEFROMCAPTURE`**（wushi2333，`overlay/mod.rs:234`）：0.5 天、10 行，让 overlay 不出现在自己的截图里。我们 `DisplayAffinity` 全仓库 0 命中 [证实]，是纯增量。
3. **附件回执回读校验**（esch30636，`lib/tools.js:264-272`）：给我们的闭环加一条断言，宿主改预算时立刻暴露坐标漂移。
4. **Esc 就绪握手 + 每动作后 `Check()`**（shinji00222，`Safety.cs:48-54`、`Program.cs:42`）：把我们"守卫死亡 fail closed"做得更可证明。
5. **「被拒 → 问 → 带批准头重试」+ per-app 审计**（wushi2333，`tool.js:725-800`）：如果后续要上"按 App 审批"，这是唯一完整范式。

### 4.3 我们比它们强的 3 点（写进 README 的素材）

1. **坐标闭环**：只有我们和 esch30636 闭环；wushi2333 开环（默认不缩、不回读），shinji00222 把除法丢给模型。我们是**预缩 + 代码内反算 + 信封回显**三层。
2. **工具面经济性**：5 工具 33~36 action vs 它的 25 个扁平工具；模型选工具的认知负担和 schema token 都低一个量级。
3. **fail-closed 守卫**：esch30636 的 overlay 连续失败 3 次后**关闭保护继续注入键鼠**（`ComputerUseAgent.ps1:465-480`）；我们的 `guard.mjs` 是 fail closed。

### 4.4 未证实清单（不要把下列当结论引用）

- wushi2333 的「逐字 parity 到基线 26.903.61454」：方法面我**已用本机官方 `docs/api.md` 证实**，但默认值/错误串/预算未交叉验证；其 parity 测试用的是测试替身不是真二进制。
- shinji00222 的 OCR **耗时**：仓库内无任何测量值，本文只给量级推测。
- shinji00222 的 `upstream/` 归档测试不代表新版通过（作者自己在 `NOTICE.md` 里也这么说）。
- wushi2333 的 `helper-rs/bin/dsh-computer-use.exe` 与源码是否对应：**无法验证**（无构建产物 hash 对照）。
- 我自己**没有运行**这三个插件的任何一个（只读源码），所有"行为"结论均来自代码阅读 + 官方文档比对。
