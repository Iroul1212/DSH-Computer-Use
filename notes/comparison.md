# 竞品源码对比：DSH 生态里的 computer-use 插件

对比对象（都能在本机复现，源码取自 npm 包）：

| 代号 | 包 | 版本 | 规模 | 路线 |
|---|---|---|---|---|
| **ours** | `dsh-computer-use`（本项目） | 0.1.0 | `src/` 约 110KB + 8 个技能 md | cordis 原生插件，零运行时依赖，常驻 PowerShell 宿主 |
| **copylee** | `@copylee/dsh-computer-use` | 0.8.0 | `lib/index.js` 391KB + `CuHelper.cs` 144KB + web UI 48KB | C# 常驻助手 + koffi 进程内 FFI + 自带 web 设置页 |
| **yutao** | `dsh-computer-use-win` | 0.5.3 | 30 文件 | 独立 MCP stdio server（自带 PowerShell/UIA 后端）+ 薄 cordis 适配器 |

原始勘察报告：`notes/ref-copylee.md`（57KB，11 节）、`notes/ref-yutao.md`（437 行，10 节），每条结论都带出处。

> 另外 `esch30636/dsh-computer-use`、`wushi2333/dsh-computer-use_codex-style`、`shinji00222/dsh-windows-computer-use` 也是 Codex-style，但**只发布在 GitHub**，本机 git 到 github:443 被代理拒绝，无法做源码级对比（只能看目录元数据）。

---

## 1. 一张表看完

| 维度 | ours | copylee | yutao |
|---|---|---|---|
| 工具面 | **5 工具 / 36 动作**（`computer` 14 + `app_window` 7 + `ui_element` 8 + `clipboard` 2 + `app_skill` 5） | 9 工具 / 17 动作 | 25 个细粒度工具 + 浏览器 CDP |
| 工具定义体积 | ~10.2K 字符 | —（自建面更大） | **20.2K 字符** |
| 运行时依赖 | 无 | 无（C# 在运行时编译） | 无（但多一个进程） |
| 宿主进程 | 常驻 PowerShell（冷启 536ms，截图 153ms，cursor 0.42ms/次） | 常驻 C# 助手（+ 可选 koffi 进程内 FFI） | 常驻 PowerShell（由 MCP server 拉起） |
| 截图→模型 | `attachments.saveImage` → `{type:'image', attachment}` | 自己的截图/缓存层 | MCP image → 官方桥 → `attachments` |
| 坐标契约 | **闭环保守**：压到 ≤600000px、信封回显 `scale`、代码内反算 | **开环**：默认 1.15MP、只回显缩放前尺寸 → 必被请求侧二次缩放 | **开环**：把 `imageScale` 丢给模型自己除，不知会被二次缩放 |
| 审批 | 可选 `requireApproval: mutating` + 明确文档说明 `never` 策略下会被拒 | 按应用授权走 DSH 原生审批，但全权会话下退化为"点名即授权" | **零审批**，只有提示词自律 |
| 急停 | 全局 Esc + **守卫/宿主意外死亡都 fail closed** | 全局 Esc（C# 键盘钩子）；koffi 输入路径无人监听 | 未见统一急停 |
| 按 App 技能 | ✅ 8 个内置 + 用户层 + 目录进工具描述 + `app_skill` | ✅ 10 个内置 + 用户层；但 `catalog()` 是死代码 | ❌（有 skills 概念但面向浏览器） |
| 陈旧观测防护 | ✅ 窗口漂移/身份漂移/窗口消失都拒发 | 未见 | ✅ 有 `homed`/`identity_changed` 拒发 |
| web UI 扩展 | 无 | ✅ 设置页/导航图标/强调色/技能卡片 | 无 |
| 可测性 | 5 个套件、**复用宿主自己的 schema validator**、10 条安全契约 | 未见 | 未见 |

---

## 2. copylee 值得我们学的地方

1. **C# 常驻助手 > 纯 PowerShell**（性能取向）。它把 UIA、分层窗口、全局键盘钩子做进一个编译好的助手，PowerShell 只当启动器；配合 DSH 自带的 koffi 还能进程内直接调 Win32，省掉 IPC。代价是 144KB C# + 打包产物与源码同步风险。**我们暂不跟进**：零依赖 + PowerShell 常驻已经够快（截图 153ms、cursor 0.42ms），而 C# 会引入"编译期依赖 SDK/Add-Type 稳定性"的新故障面。
2. **web UI 扩展**（`dsh.client` manifest → 设置页/技能卡片）。这是产品化差异，但会引入 react peer 依赖与 `client.inject` 契约面。**不做**，我们用 YAML 配置 + `app_skill` 工具替代。
3. **按 App 技能库**（详见 §4，已采纳）。
4. 它的 `open_application` 会在打开应用时把该应用的技能**一次性追加进工具结果**、每 session 每技能只一次 —— 我们改成了"**截图给一行指针 + 模型按需 `app_skill get`**"，token 更省、也避免一次塞 4000 字。

## 3. yutao 值得我们学的地方

1. **窗口移动补偿 + 身份漂移守卫**（已采纳，见 §4）：`homed:{dx,dy}` / `identity_changed` 拒绝，消灭"观察→动作之间窗口被挪/被重启"的静默错点。这是本次对比里性价比最高的一条。
2. **UIA 树裁枝**：它对 UIA 做了去重/限深/超时（`windows-uia.ps1:1046-1110` 一带），我们的 `uia` 只有 depth/maxNodes + 6s 超时，裁枝规则更粗。**待办**（未实现）。
3. **MCP 路线的教训**（见 §5）：它证明了 MCP 能进附件管线，但过 5 道门、任一不过就**静默降级成一行文本**，而且 `render()` 被桥写死。我们用原生插件就没有这层损耗。

---

## 4. 本次对比后实际改掉的两件事

### 4.1 按 App 技能库（`app_skill`）
- `src/skills.js`：`SkillStore` / `parseSkill` / `MAX_SKILL_CHARS=4000` / `matchKey`；front matter `app/match/summary`；用户层 `$DSH_HOME/computer-use-skills/*.md` 按 id 覆盖内置。
- `skills/`：`excel word powerpoint chrome explorer notepad vscode terminal` 8 个内置配方（以"能按键盘解决就别点坐标"为原则写）。
- 注入分三层，都受 token 预算约束：① `computer` 的工具描述里带**一行一个 App 的目录**；② 截图信封里，前台 App 命中时多一行 `App skill available for X (...)`；③ 模型需要细节时调 `app_skill get`，正文上限 4000 字符。
- 比 copylee 多做的：把它的死代码 `catalog()` 真正接进了工具描述。

### 4.2 窗口漂移守卫
- 当截图绑定到某个窗口（`computer` 的 `hwnd` 参数）时，记录 `{hwnd, bounds, pid}`；此后每个 mutating 动作在 `beforeMutation` 里先调宿主 `windowState`（<3ms，只 `IsWindow`+`GetWindowRect`）核对：
  - 窗口没了 → `TARGET_WINDOW_GONE`
  - hwnd 换了进程 → `TARGET_WINDOW_CHANGED`
  - 位置/尺寸变了 → `TARGET_WINDOW_MOVED`
- 三种情况都**拒发**并提示"重新截图再操作"，而不是点到新位置上。
- 宿主不支持该命令时自动降级为 no-op（老版本兼容）。

---

## 5. 明确不做的事（及原因）

| 不做 | 原因 |
|---|---|
| 换 C#/koffi 原生助手 | 引入编译与原生依赖故障面；现有 PowerShell 常驻已满足延迟要求（实测 153ms 截图 / 0.42ms cursor） |
| 加 web UI 设置页 | 需要 react + `dsh.client` 契约，收益是"好看"，不是"能用" |
| 走 MCP 形态 | 多一层进程 + 桥接；图片过 5 道门后**可能静默降级成文本**；拿不到 `ctx.approval`/`ctx.attachments` 的一手语义 |
| 25 个细粒度工具 | 工具定义 20.2K 字符 vs 我们 10.2K；小工具多会让弱模型选择困难、破坏请求 shape 稳定性 |
| `dsh.engines.dsh` 版本闸门 | copylee 声明了它，但我在装好的 0.1.5 宿主 `dsh-app-boot` 里**没找到读取 `engines` 的代码**，语义未证实，不写不确定的字段 |

---

## 6. 竞品里的安全问题（我们自己要避免的）

1. **copylee：全权会话下"按应用授权"退化为模型点名即自动 grant**（`lib/index.js:8818-8823`）——审批形同虚设。我们的答案是：所有 mutating 动作统一过同一个 `beforeMutation`，且在 `requireApproval` 打开时**不根据应用名给特权**。
2. **copylee：危险动作没有代码级闸门，只写在 system prompt 让模型自律**（`index.js:2173`）。我们的闸门是代码：Esc/守卫死亡/宿主死亡/黑名单/漂移/审批，全部 throw。
3. **copylee：Esc 只在 C# 键盘钩子里，koffi 进程内输入路径无人监听** —— 同一插件里两条输入通道，安全网只覆盖一条。我们只有一条输入通道（宿主），且 overlay 与宿主死亡都能冻结。
4. **copylee：截图缓存清理器会解析 DSH 内部存储格式并删除附件** —— 这是跨插件破坏性最强的代码路径，一旦 DSH 存储格式变了就可能误删。我们从不碰 DSH 存储，截图只调 `attachments.saveImage`。
5. **yutao：图片失败静默降级**（`[image unavailable: ...]` 但工具返回 ok）。我们失败就 throw，让模型知道"没看到图"。

---

## 7. 仍未证实的部分

- copylee 的 koffi 双引擎具体在什么条件下启用（打包产物里是分支判断，未逐行验证）。
- copylee 客户端的 React 扩展点行为（只读了 `lib/types/client/*.d.ts`，没实跑 UI）。
- yutao 的 UIA 裁枝算法细节（只读了 PowerShell 侧的入口与注释窗口）。
- 三个仅 GitHub 的插件（`esch30636` / `wushi2333` / `shinji00222`）完全未读源码。


