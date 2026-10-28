# DSH 插件 API 勘察报告（实测 + 源码出处）

勘察时间：基于宿主 0.1.5-rc.2/rc.3 安装体，只读勘察，未改动任何已有代码。
唯一写入：本文件（`notes/api-recon.md`）。

## 路径简写（下文所有 `file:line` 都相对这两个根）

| 简写 | 绝对路径 |
|---|---|
| `HOST\` | `C:\Users\lizhen\AppData\Local\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\` |
| `PROFILE\` | `E:\Users\lizhen\.dsh\profiles\web\` |
| `REPO\` | `C:\Users\lizhen\Documents\deepseek-harness\default-workspace\dsh-computer-use\` |

行号均为该文件当前行号（`Select-String` 实测），不是估算。

---

## 0. 一句话结论（先看这个）

**这条路是通的，而且是官方一等公民路径**：第三方插件 = 一个普通 ESM npm 包 + `dsh.bundle.patch` 指向的 patch 文件；工具用 `defineTool()` 定义；**图片可以在工具结果里直接交给模型**（`ContentBlock` 的 `image` 块，携带附件引用，不需要 base64，不需要走 MCP）；审批用 `ctx.approval.request()`。

但有一个**硬性前置条件**和两个**要命的坑**，见 §3 和 §8：

1. 图片必须先经 `ctx.attachments.saveImage()` 存成 content-addressed 附件，拿到 `ImageAttachmentRef` —— `ImageBlock` 里**没有** base64 字段。
2. 模型最终看到的图**不是**你存进去的尺寸：`llm-deepseek` 会再投影到 **640,000 像素 / 1 MiB** 的请求图。截图坐标映射必须按这个最终尺寸算，否则点偏。
3. `pnpm` **不在 PATH 上**（实测），`dsh plugin add` 会直接 `exit 127`。

---

## 1. 插件包形状

### 1.1 结论

一个第三方插件包要成为 profile 的一个 **layer**，只需要两件事：

1. `package.json` 里有 `"dsh": { "bundle": { "patch": "<相对包根的 patch 文件>" } }`。
2. 被装进 profile 的 `dependencies` 里。

`dsh plugin --profile web add <pkg>` 装完后会做一次 **reconcile**：遍历 profile `dependencies`，凡是**解析出来的包的 `package.json` 声明了 `dsh.bundle.patch`** 的，就把**真实的包名**追加进 `PROFILE\package.json` 的 `dsh.profile.bundles` 数组（按依赖顺序 append）。没有 `dsh.bundle` 的依赖只会打一行 warning，当普通库。
反向也成立：依赖被删、或新版本把 `dsh.bundle` 声明去掉，就从 `bundles` 里移除。
配置模板里自带的 in-box bundle（`@deepseek-ai/dsh-base` 等）不是依赖，永不被 reconcile 动。

reconcile 是**按已安装状态**而不是按命令行 diff 做的 —— 所以 `dsh plugin update` 能让一个"新版本才开始声明 `dsh.bundle`"的包自动激活。

**不需要** `dsh.bundle` 是数组、不需要注册表、不需要额外清单。bundle 就是一个有 patch 文件的包。

### 1.2 patch 文件格式与合成语义

patch 文件 = **顶层 YAML 数组**，元素是 patch entry。容器有两种形态：`insert`（加行）和 id 定向覆盖（改行）。

所有 layer 的 patch **不是依次 apply**，而是**全部展平成一个列表，然后一次性** `applyEntryPatches([], structuredClone(layers.flat()))` 从**空根**开始合成。这意味着：

- 后面的 layer 能看到前面 layer insert 的行（`buildMap` 边插边索引）；
- 但"某 layer 用 config 整体替换引入的 group 子行"这类角落情况，单遍 id 索引看不到 —— 这是**已知且刻意**的行为（`dsh --dump-config` 用同一个算法，所以 dump 永远等于实际挂载）。
- patch 命不中任何行 → **warn 并跳过**，不报错（这样一个 overlay 可以跨多个 surface 复用）；但 patch 文件的**字段本身非法会 throw**。

`insert` 的两种用法（`HOST\dsh-app-boot\lib\index.js:71-95`）：

- `- insert: [行, 行, ...]` **不带 `id`** → 全部追加到顶层 entry 列表。
- `- insert: [行,...]` **带 `id: <group-id>`** → 追加进那个 **group** entry 的 `config` 数组；目标不存在或不是 group 就 warn+skip。

id 定向覆盖（`HOST\dsh-app-boot\lib\index.js:88-105`）：
`{ id, name?, ...overrides }` → 对目标行**逐 key 赋值**；`name` 若给出且与目标行现有 `name` 不符 → warn+skip（防止 id 撞车改错行）。**注意：`config` 是整体替换，不深合并**（`HOST\dsh-base\cordis.patch.yml:1-8` 的注释明确写了 "A patch replaces the targeted row's whole `config` rather than merging into it"）。

行的字段（从 `HOST\dsh-base\cordis.patch.yml` 全文归纳）：`id`、`name`、`config`、`disabled`、`group`。`id` 对插入行是**可选**的（校验只要求 entry 是 mapping，`HOST\dsh-app-boot\lib\index.js:1199-1202`），但**强烈建议必填** —— 否则用户无法在 profile 层按 id 覆盖/禁用你的行。

### 1.3 宿主怎么把 `name` 解析成模块

分两步，两步都实测过：

**第一步（patch 加载期）**：`anchorInsertedPluginNames`（`HOST\dsh-app-boot\lib\index.js:1168-1178`）遍历每个 `patch.insert` 里的行，凡是 `name` 是**绝对路径**或以 `./`、`../` 开头，就 `pathToFileURL(resolve(dirname(patchFile), name))` 转成 `file://` URL。→ **本地免安装开发的后门**（见 §7.4）。

**第二步（挂载期）**：Loader 的 `import(name, baseUrl)`（`HOST\cordis-plugin-loader\lib\index.js:270-284`）：

- 有 `loader.internal` 就走宿主注入的 importer；
- `name.startsWith('.')` → `import(new URL(name, ctx.baseUrl).href)`；
- 否则 `import(name)` —— 即 Node ESM 的裸包名解析，**从 `baseUrl` 所在的模块位置**解析。

导出形状归一化 `unwrapExports`（`HOST\cordis-plugin-loader\lib\index.js:746-752`）：

```
exports = exports.default ?? exports
if (!exports.__esModule) return exports
return exports.default ?? exports
```

→ 你的入口模块**要么**有 `default` 导出（那就用 default），**要么**用命名导出组成一个 "plugin object"。in-box 的 `dsh-tool-todo` 用的是后者（`HOST\dsh-tool-todo\lib\index.js:196`：`export { Config, apply, inject, name };`）。

### 1.4 入口模块要导出什么（确切语义）

`HOST\cordis\lib\types\registry.d.ts:53-105`：

```ts
namespace Plugin {
  interface Base<T> {
    name?: string;                        // fiber 诊断名 / logger 名
    Config?: StandardSchemaV1<any, T>;    // 启动前校验 config 的 schema
    inject?: Inject;                      // 依赖的服务；全部可用时才加载
    provide?: string | string[];          // 本插件提供的服务名
    intercept?: Dict<boolean>;            // 声明消费哪些服务的 intercept config
  }
  interface Function<T> extends Base<T> { (ctx: Context, config: T): any }
  interface Constructor<T> extends Base<T> { new (ctx: Context, config: T): any }
}
type Inject<M> = (keyof M)[] | { [K in keyof M]?: M[K] }
```

`Plugin.Object` 形态就是 `{ name?, Config?, inject?, apply(ctx, config) }`。

**先后顺序**（由 cordis registry 保证）：

1. loader import 模块 → `unwrapExports` 得到 plugin object；
2. 合并 patch 行的 `config` 与 `Config` schema 的默认值，用 `~standard` **校验**（非法就 throw，profile 启动失败）；
3. 检查 `inject` 里**每一个**服务是否已 provide；**任一缺失则不加载**（不是报错，是静默等待/不激活）；
4. 服务齐了才调用 `apply(ctx, validatedConfig)`。

所以：**`inject` 是"我需要什么才活"，不是"我顺便拿点什么"**。这是第三方插件最容易搞错的地方 —— 把可选依赖写进 `inject` 会让整个插件在缺那个服务时**完全不加载**（连工具都不注册）。可选依赖要用 `ctx.get('xxx')` 并在运行时判空（in-box 的 `read_image` 就是这么处理 `attachments`/`llm` 的，`HOST\dsh-tool-fs\lib\index.js:1069-1071`、`:965-973`）。

### 1.5 `inject` 里能写哪些服务名

以下全部是 `declare module '@deepseek-ai/cordis' { interface Context { ... } }` 里的真实声明，可直接写进 `inject`：

| 服务名 | 类型 | 证据 |
|---|---|---|
| `tools` | `ToolRuntime` | `HOST\dsh-tools\lib\types\index.d.ts:26` |
| `attachments` | `AttachmentStore` | `HOST\dsh-attachment\lib\types\index.d.ts:13` |
| `approval` | `ApprovalService` | `HOST\dsh-user-approval\lib\types\index.d.ts:13` |
| `authorization` | `AuthorizationService` | `HOST\dsh-authorization\lib\types\index.d.ts:35` |
| `llm` | `LlmRuntime` | `HOST\dsh-llm\lib\types\index.d.ts:30` |
| `fs` | `FileSystem` | `HOST\dsh-fs\lib\types\index.d.ts:17` |
| `shell` | `ShellExecutor` | `HOST\dsh-shell\lib\types\index.d.ts:26` |
| `sandbox` | `SandboxProvider` | `HOST\dsh-sandbox\lib\types\index.d.ts:118` |
| `sessionProjections` | `SessionProjectionRegistry` | `HOST\dsh-session-projection\lib\types\index.d.ts:25` |
| `userQuestions` | `UserQuestionService` | `HOST\dsh-user-questions\lib\types\index.d.ts:13` |
| `agents` | `AgentRegistry` | 见 `dsh-agent` 的 Context 增强 |
| `commands` / `compaction` / `skills` / `loader` / `timer` / `hmr` | 见右列 | 同上（`dsh-commands`/`dsh-compaction`/`dsh-skill`/cordis-loader/cordis-plugin-timer/cordis-plugin-hmr） |

对工具插件来说，最常用的最小集是 `inject = ['tools']`；需要发图再加 `'attachments'`（或按 in-box 做法用 `ctx.get` + `ctx.inject(['attachments'], cb)`）。

### 1.6 模板代码

`REPO\package.json`（关键字段）：

```json
{
  "name": "dsh-computer-use",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.js",
  "exports": { ".": "./src/index.js", "./package.json": "./package.json" },
  "files": ["src", "cordis.patch.yml", "README.md"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "peerDependencies": {
    "@deepseek-ai/cordis": "4.0.2",
    "@deepseek-ai/dsh-tools": "^0.1.5-rc.3",
    "@deepseek-ai/dsh-attachment": "^0.1.5-rc.3",
    "@deepseek-ai/dsh-llm": "^0.1.5-rc.3",
    "@deepseek-ai/dsh-user-approval": "^0.1.5-rc.3"
  }
}
```

`REPO\cordis.patch.yml` —— **最小例子就是这一条 `insert:`**：

```yaml
- insert:
    - id: computer-use
      name: 'dsh-computer-use'
      disabled: !!js process.platform !== 'win32'
      config:
        enabled: true
```

`REPO\src\index.js` 的导出形状：

```js
import z from '@deepseek-ai/schemastery'

export const name = 'computer-use'
export const inject = ['tools']
export const Config = z.object({
  enabled: z.boolean().default(true),
})

export function apply(ctx, config) {
  if (!config.enabled) return
  ctx.tools.register(defineTool({ /* §2 */ }))
}
```

> 仓库里现有的 `REPO\cordis.patch.yml` 形状**完全正确**（`- insert:` → 单行 → `id`/`name`/`disabled: !!js`/`config`），与 `HOST\dsh-base\cordis.patch.yml` 的写法逐字一致（对照 `:205-221` 的 `sandbox-policy` / `pwsh-sandbox` 行）。无需改。

### 1.7 证据

- `HOST\dsh\lib\plugin-Ddi42qoW.js:1-13`（模块 doc）、`:33-44`（`exportsPatch`：只认 `dsh?.bundle?.patch !== undefined`）、`:60-88`（`reconcilePlugins`：按已安装状态维护 `dsh.profile.bundles`）、`:94-101`（`anchorPathSpec`：相对路径按**调用者 cwd** 锚定，避免 `add .` 自链 profile）
- `HOST\dsh-app-boot\lib\index.js:826-836`（`resolveBundleDir`：**安装锚点优先**，profile 次之）、`:845-864`（`loadProfileDirectory`：bundle 无 `dsh.bundle` 直接 throw）、`:59-105`（`applyEntryPatches` 全文）、`:1101`（`userPatchesSchema = entryListSchema`）、`:1160-1178`（`loadOverlayPatches` + `anchorInsertedPluginNames`）
- `HOST\dsh-app-boot\lib\index.js:328-357`（`PROFILE_TEMPLATES`：`web` = `[dsh-base, dsh-web-app]`，`patchReload: "live"`；`DEFAULT_PROFILE_BUNDLES = ["@deepseek-ai/dsh-base"]`）
- `HOST\cordis-plugin-loader\lib\index.js:270-284`（name 解析）、`:746-752`（`unwrapExports`）、`:288-306`（`evaluate`/`interpolate`）
- `HOST\cordis\lib\types\registry.d.ts:7-13, 45-105`（`Inject`、`Plugin.Base/Function/Object`）
- 实测：`PROFILE\package.json` 当前 `dsh.profile.bundles = ["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"]`，`dependencies: {}`，`patchReload: "live"`；`PROFILE\cordis.yml` 是空数组 `[]` 且注释写明"Edit cordis.patch.yml, not this file"。

---

## 2. 工具的完整契约

### 2.1 `defineTool()` 参数逐字段

来自 `HOST\dsh-tools\lib\types\schema.d.ts:238-292`（`DefineToolOptions`）与 `HOST\dsh-tools\lib\types\index.d.ts:106-173`（`ToolDefinition`）。

| 字段 | 必填 | 语义 |
|---|---|---|
| `name` | ✅ | 工具名，全局唯一。模型看到的就是它 |
| `description` | ✅ | 给模型看的说明。**只有 `name`/`description`/`parameters` 会被发到模型** —— `timeoutMs`、`isConcurrencySafe` 等元数据**永不**进 prompt（`index.d.ts:148-152`） |
| `parameters` | ✅ | **隐式开放对象根**的每属性 schema，见 2.2 |
| `output.schema` | ✅ | 强制校验的规范输出 schema；成功返回的每个 value 都过它 |
| `output.render(args, value)` | ✅ | **纯同步**投影：`(args, value) => ContentBlock[]`。模型/原生看到的内容就是它。禁止 async、禁止副作用（replay 时会重新调用） |
| `output.presentationMeta?(args, value)` | ⭕ | 纯投影出 UI 用的 `JsonValue`，持久化在 `tool/result` 上供 Host/Client 各自 narrow |
| `execute(args, exec)` | ✅ | `async`，返回 `output.schema` 声明的规范值。**必须**观察或转发 `exec.signal` |
| `timeoutMs?` | ⭕ | 协作式超时预算（ms）。省略 = 无 deadline。声明它就等于承诺"我会转发 `exec.signal` 并在 abort 后收敛" |
| `isConcurrencySafe?(args)` | ⭕ | 纯同步分类器；**只有返回字面 `true`** 才允许与兄弟调用并行。抛异常/非 true/参数非法 → 独占 |
| `finalizeContent?(exec, result)` | ⭕ | 最后一道内容变换，所有归一化结局（含 pipeline 失败）都过一次；返回 `undefined` 表示不改 |
| `presentCall?(args)` | ⭕ | 纯同步，pending 态 UI 呈现，返回 `ToolCallView` |
| `presentResult?(args, result)` | ⭕ | 纯同步，完成态 UI 呈现，返回 `ToolResultView` |

**`defineTool` 没有 `approval` 字段**。审批不在工具定义里，在 `execute` 里调服务（§4）。

### 2.2 `ParameterSchemaSpec` 支持的类型

`HOST\dsh-tools\lib\types\schema.d.ts:98-110`（`ValueSchemaSpec` 联合）：

```ts
type ValueSchemaSpec =
  | { type: 'string';  enum?: readonly string[];  const?: string }
  | { type: 'number';  enum?: readonly number[];  const?: number }
  | { type: 'integer'; enum?: readonly number[];  const?: number }
  | { type: 'boolean'; enum?: readonly boolean[]; const?: boolean }
  | { type: 'null';    enum?: readonly null[];    const?: null }
  | { type: 'array';   items?: ValueSchemaSpec }
  | { type: 'object';  properties?: ParameterSchemaSpec; additionalProperties: boolean }
  | { type: 'json' }                       // 作者侧"任意无损 JSON"，编译成 annotation-only
  | { oneOf: readonly [ValueSchemaSpec, ValueSchemaSpec, ...ValueSchemaSpec[]] }
```

每个节点都可带 `description` / `title` / `default` / `examples`（`ValueSchemaAnnotations`，`schema.d.ts:10-21`）。

- **`required`**：只存在于**属性位置**，写法是属性节点上加 `required: true`（`ParameterPropertySpec = ValueSchemaSpec & { required?: true }`，`schema.d.ts:112-114`）。**没有** `required: ['a','b']` 数组形式。
- **`additionalProperties`**：嵌套/输出 `object` 是**强制必填**的（`schema.d.ts:61-67` 注释："Openness is mandatory so a nested or output object never acquires an accidental JSON Schema default"）。**根 `parameters` 例外** —— 它是隐式开放对象，不要写 `additionalProperties`。
- **枚举**：`enum: [...]`；单值用 `const`。
- **嵌套 object / array**：`type:'object'` 里再放 `properties`；`type:'array'` 的 `items` 是单个 `ValueSchemaSpec`。
- **`oneOf`**：至少两个分支的 exact-one 联合。

### 2.3 `exec` 上有哪些字段

`exec: ToolRunContext`（`index.d.ts:284-306`）⟵ `ToolExecution`（`:261-270`）⟵ `ToolExecutionInput`（`:197-225`）：

| 字段 | 说明 |
|---|---|
| `callId` | 本次调用的 id |
| `rootCallId` | 根模型调用 id（嵌套时也解析出根） |
| `name` | 工具名 |
| `arguments` | 已校验、已冻结、无损 JSON 快照的参数 |
| `agent?` | **发起调用的 Agent**。有它就能拿 `exec.agent.session`（读写 session log）、`exec.agent.options.{provider,model}`、`exec.agent.session.requestHeader()?.config` |
| `parent?` | 上层 transport 执行的不透明 token（PTC 子分发才有） |
| `signal` | `AbortSignal`，**调用方拥有的取消信号**。必须观察或转发 |
| `token` | registry 分配的执行身份 |
| `deferContext(userMessage)` | 把一条 context 挂到本结果之后，等 `tool/result` 之后再进 agent loop |
| `concludeTurn()` | 把成功结果标记为"本轮结束" |

**超时**：`exec` 上**没有** timeout 字段。超时是工具自己声明的 `timeoutMs`，由 `dsh-tool-call-timeout-policy` 这个 `tools/execute` wrapper 实现（§5.3）。并且文档明说：registry **不会**放弃你的 promise，"it cannot hard-kill same-process code"（`index.d.ts:168-170`）→ 超时是**协作式**的，你的 `execute` 必须真的响应 `signal`。

### 2.4 `presentCall` / `presentResult` 的 card 枚举

`ToolCallView`（`HOST\dsh-tools\lib\types\presentation.d.ts:41`）三选一：

| `card` | 专属字段 |
|---|---|
| `'generic'` | `title`(必填)、`kind?`、`rawInput?`、`content?: ContentBlock[]`、`locations?: {path, line?}[]` |
| `'terminal'` | `title`(命令)、`description?`、`cwd?` |
| `'diff'` | 见 `presentation.d.ts:102-117` |

`kind` 枚举（`ToolCallKind`，`presentation.d.ts:13`）：
`'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'fetch' | 'other'`（默认 `other`）。

`ToolResultView`（`:130`）六选一：`generic | terminal | diff | search-matches | search-paths | read | web-search | web-fetch`（`SearchResultView`/`WebResultView` 是联合，见 `:249`、`:326`）。

`title`/`kind`/`rawInput` 之外 **generic 还支持**：`content`（UI 侧的内容块）与 `locations`（编辑器 follow-along 高亮跳转）。

> 注意 `presentCall` 会在**实时流**和**会话日志 replay** 两种场景被调用，所以必须"只依赖 args、纯函数、不抛"。

### 2.5 最小可用模板（从真实源码抄的结构）

```js
// REPO/src/tools/screenshot.js
import { defineTool } from '@deepseek-ai/dsh-tools'

export function makeScreenshotTool({ ctx, capture }) {
  return defineTool({
    name: 'computer_screenshot',
    description:
      'Capture the current Windows desktop and return the screenshot itself. ' +
      'Use it to see the screen before clicking; coordinates you return are read ' +
      'in the returned image space.',
    // 隐式开放对象根：不要写 additionalProperties
    parameters: {
      window_id: {
        type: 'string',
        description: 'Optional window handle; omit for the whole desktop.',
      },
      format: {
        type: 'string',
        enum: ['png', 'jpeg'],
        default: 'png',
        description: 'Encoded image format.',
      },
      max_width: {
        type: 'integer',
        description: 'Downscale the capture to at most this width in pixels.',
      },
    },
    output: {
      // 输出 schema 用同一个 DSL；object 节点必须显式 additionalProperties
      schema: {
        type: 'object',
        additionalProperties: false,
        required: true,
        properties: {
          path: { type: 'string', required: true },
          image: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              attachmentId: { type: 'string', required: true },
              mediaType: {
                type: 'string',
                enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
                required: true,
              },
              bytes: { type: 'integer', required: true },
              width: { type: 'integer', required: true },
              height: { type: 'integer', required: true },
            },
          },
        },
      },
      // 纯投影：value -> ContentBlock[]（图片块见 §3）
      render: (_args, value) => [
        { type: 'text', text: `<screenshot>${value.path}</screenshot>` },
        { type: 'image', attachment: imageRefFromValue(value.image) },
      ],
      presentationMeta: (_args, value) => ({ path: value.path }),
    },
    isConcurrencySafe: () => false,   // GUI 截屏会互相抢屏幕
    timeoutMs: 20_000,                // 声明了就一定要转发 exec.signal
    async execute(args, exec) {
      const shot = await capture(args, { signal: exec.signal }) // 必须传 signal
      // …… 存附件、返回规范值（§3）
      return { path: shot.path, image: shot.image }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Screenshot ${args.window_id ?? 'desktop'}`,
      kind: 'read',
      rawInput: { format: args.format, max_width: args.max_width },
    }),
  })
}
```

### 2.6 证据

- `HOST\dsh-tools\lib\types\schema.d.ts:98-114`（`ValueSchemaSpec` / `ParameterSchemaSpec`）、`:238-292`（`DefineToolOptions` 逐字段 + 注释）、`:76-83`（`ObjectValueSchemaSpec.additionalProperties` 强制）
- `HOST\dsh-tools\lib\types\index.d.ts:106-173`（`ToolDefinition`：`output` 必填、`timeoutMs` 不进模型、`presentCall` 纯函数要求）、`:197-306`（exec 字段全集）、`:601`（`register(definition): () => void`）
- `HOST\dsh-tools\lib\types\presentation.d.ts:13, 41, 47-75, 130`
- 真实用例：`HOST\dsh-tool-todo\lib\index.js:120-190`（最小 `defineTool`：`output.schema` + `render` + `execute` + `presentCall`，`presentCall` 用 `{card:'generic', title, kind:'other', rawInput}`）；`HOST\dsh-tool-fs\lib\index.js:1027-1120`（带输出图片的完整 `defineTool`，含 `isConcurrencySafe`、`presentationMeta`、`presentCall`）

---

## 3. 工具怎么把图片交给模型（最关键的一条）

### 3.1 结论：**通**，而且是官方一等公民路径

三条硬事实：

1. **`ContentBlock` 里有 `image` 块**，`ImageBlock = { type: 'image', attachment: ImageAttachmentRef }`。**没有 base64 字段、没有 url 字段** —— 必须携带附件引用（`HOST\dsh-llm\lib\types\types.d.ts:50-56`）。
2. **工具结果里的 image 块会被送到模型**。`llm-deepseek` 适配器有一条**专门**的 tool-result 图片路径：把 tool 消息保持为纯字符串，然后把其中的图片**收集到紧随其后的一条 user 消息**里，前缀文本是 `"Attached image(s) from tool result:"`（`HOST\dsh-llm-deepseek\lib\index.js:24`，实现 `:164-230`）。
3. in-box 已经有工具在这么干：`read_image`（`HOST\dsh-tool-fs\lib\index.js:1027-1120`）。这是**可以直接照抄的参考实现**。

所以：**不需要 MCP，不需要返回文件路径再让模型用 read 工具读，不需要 base64。**

### 3.2 三步流程

```
工具 execute():  截图 bytes → ctx.attachments.saveImage({data, mediaType, name}) → ImageAttachmentRef
工具 output.schema:  声明这个 ref 的字段（attachmentId/mediaType/bytes/width/height…）
工具 output.render(): 返回 [{type:'text', ...}, {type:'image', attachment: <ref>}]
                    ↓
llm 层: contentHasImage() 递归遍历 tool-result 内容 → 若模型支持 image 输入则原样序列化
                    ↓
DeepSeek wire: {role:'tool', content:'<text>'} + {role:'user', content:[{type:'text',text:'Attached image(s) from tool result:'},{type:'image_url',image_url:{url:'data:image/png;base64,...'}}]}
```

### 3.3 谁注入、服务名、API 签名

- 服务名：**`attachments`**，类型 `AttachmentStore`，通过 `declare module '@deepseek-ai/cordis' { interface Context { attachments: AttachmentStore } }` 声明（`HOST\dsh-attachment\lib\types\index.d.ts:12-15`）。
- 实现由 `@deepseek-ai/dsh-attachment-local` 提供，**在 `dsh-base` 里默认挂载**（`HOST\dsh-base\cordis.patch.yml:118-119`，实测 `dsh --profile web --dump-config` 输出含该行）。
- 签名（`HOST\dsh-attachment\lib\types\index.d.ts:17-140`）：

```ts
abstract class AttachmentStore extends Service {
  abstract readonly imageLimits: ImageAttachmentLimits
  abstract saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef>
  saveImages(inputs: readonly SaveImageAttachment[]): Promise<readonly ImageAttachmentRef[]>
  abstract readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment>
  imageHostPath(ref: ImageAttachmentRef): string | undefined
  readImageRequest(ref, policy: ImageRequestPolicy, signal?): Promise<RequestImageAttachment>
}

interface SaveImageAttachment {
  data: Uint8Array           // 已编码的图片字节（不是 RGBA）
  mediaType: ImageMediaType  // 'image/png'|'image/jpeg'|'image/webp'|'image/gif'
  name?: string              // 展示名，永不被当作路径
}

interface ImageAttachmentRef {
  attachmentId: AttachmentId  // 品牌类型，用 AttachmentId(str) 铸造
  mediaType: ImageMediaType
  bytes: number
  width: number
  height: number
  name?: string
  originalDimensions?: { width: number; height: number }  // 仅当归一化缩小时存在
}
```

- `AttachmentId` 品牌函数从 `@deepseek-ai/dsh-attachment` 导出（`index.d.ts:11`）。

### 3.4 真实可跑的代码片段（照抄 `read_image` 的结构）

```js
// REPO/src/tools/screenshot.js
import { defineTool } from '@deepseek-ai/dsh-tools'
import { AttachmentId, AttachmentError } from '@deepseek-ai/dsh-attachment'

const IMAGE_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: true,
  properties: {
    attachmentId: { type: 'string', required: true },
    mediaType: {
      type: 'string',
      enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
      required: true,
    },
    bytes: { type: 'integer', required: true },
    width: { type: 'integer', required: true },
    height: { type: 'integer', required: true },
    name: { type: 'string' },
  },
}

// 规范值 -> ImageBlock 携带的附件引用（纯函数，render 里调用）
function imageRefFromValue(image) {
  return {
    attachmentId: AttachmentId(image.attachmentId),
    mediaType: image.mediaType,
    bytes: image.bytes,
    width: image.width,
    height: image.height,
    ...(image.name === undefined ? {} : { name: image.name }),
  }
}

export function makeScreenshotTool(ctx, capture) {
  return defineTool({
    name: 'computer_screenshot',
    description:
      'Capture the Windows desktop and return the screenshot itself. ' +
      'Requires a model with image input.',
    parameters: {
      window_id: { type: 'string', description: 'Omit for the whole desktop.' },
      max_width: { type: 'integer', description: 'Downscale to at most this width.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: true,
        properties: {
          path: { type: 'string', required: true },
          image: IMAGE_VALUE_SCHEMA,
        },
      },
      // 纯同步：value -> ContentBlock[]，图片块紧跟在文本信封后面
      render: (_args, value) => [
        {
          type: 'text',
          text: `<screenshot>${value.path}</screenshot>\n${value.image.mediaType} ${value.image.width}x${value.image.height}px ${value.image.bytes} bytes`,
        },
        { type: 'image', attachment: imageRefFromValue(value.image) },
      ],
      presentationMeta: (_args, value) => ({ path: value.path }),
    },
    isConcurrencySafe: () => false,
    timeoutMs: 20_000,
    async execute(args, exec) {
      // 1) 截图（你自己的 Win32 实现），必须转发 exec.signal
      const shot = await capture(args, { signal: exec.signal })
      // 2) 只有 attachments 服务在时才可能发图
      const attachments = ctx.get('attachments')
      if (attachments === undefined) {
        throw new Error('cannot return a screenshot: no attachment service is mounted')
      }
      // 3) 部署是否接受这种 media type
      if (!attachments.imageLimits.mediaTypes.includes(shot.mediaType)) {
        throw new Error(`${shot.mediaType} images are not accepted by this deployment`)
      }
      // 4) 尺寸门槛（超了直接拒绝，不会自动缩小 —— 见 3.5）
      const { maxImageBytes, maxImageDimension, maxImagePixels } = attachments.imageLimits
      if (shot.width > maxImageDimension || shot.height > maxImageDimension) {
        throw new Error(`screenshot side exceeds the ${maxImageDimension}px limit; downscale it first`)
      }
      if (shot.width * shot.height > maxImagePixels) {
        throw new Error(`screenshot exceeds the ${maxImagePixels}-pixel limit; downscale it first`)
      }
      if (shot.data.byteLength > maxImageBytes) {
        throw new Error(`screenshot exceeds the ${maxImageBytes}-byte limit; downscale it first`)
      }
      // 5) 存成 content-addressed 附件
      let ref
      try {
        ref = await attachments.saveImage({
          data: shot.data,          // Uint8Array
          mediaType: shot.mediaType,
          name: shot.name ?? 'screenshot.png',
        })
      } catch (error) {
        if (error instanceof AttachmentError) {
          // IMAGE_DIMENSION_TOO_LARGE / IMAGE_TOO_MANY_PIXELS / IMAGE_TOO_LARGE /
          // IMAGE_TYPE_MISMATCH / INVALID_IMAGE / ATTACHMENT_WRITE_FAILED
        }
        throw error
      }
      // 6) 返回规范值；render 负责变成 image block
      return {
        path: shot.path,
        image: {
          attachmentId: ref.attachmentId,
          mediaType: ref.mediaType,
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
          ...(ref.name === undefined ? {} : { name: ref.name }),
        },
      }
    },
  })
}
```

注册（`apply` 里，按 in-box 的写法只在 `attachments` 就绪时注册）：

```js
export function apply(ctx, config) {
  ctx.inject(['attachments'], (imageCtx) => {
    imageCtx.tools.register(makeScreenshotTool(imageCtx, capture))
  })
}
```

> `ctx.inject([...], cb)` 是 cordis 的"服务齐了再执行回调"的写法（`HOST\cordis\lib\types\registry.d.ts:104-111`）；in-box 用法见 `HOST\dsh-tool-fs\lib\index.js:1270`。

### 3.5 mime / size 限制与降采样（全部是实测常量）

**附件存储（`dsh-attachment-local`）**，`HOST\dsh-attachment-local\lib\index.js:888-908`、`:993-998`：

| 项 | 默认值 | 行为 |
|---|---|---|
| 单图编码字节 | **20 MiB**（`DEFAULT_MAX_IMAGE_BYTES = 20*1024*1024`） | **超了直接拒绝，不缩** |
| 单条消息图片数 | 20 | 拒绝 |
| 单条消息图片总字节 | 200 MiB | 拒绝 |
| 单图总像素 | **64,000,000** | 拒绝 |
| 单边像素 | **8192** | 拒绝 |
| 支持的 mime | `image/png`、`image/jpeg`、`image/webp`、`image/gif` | 其余拒绝（`assertDeploymentAccepts`） |

**存储归一化（存储侧"落地"的尺寸）**：`normalizedImageMaxPixels = 2048*2048`（4,194,304 像素）、长边 `8192`、编码字节目标 `4 MiB`（`HOST\dsh-attachment-local\lib\index.js:904-908`）。→ **超大图会被降采样**，并且 `ImageAttachmentRef.originalDimensions` 会记录缩放前的尺寸（`dsh-tool-fs` 正是用这个给模型算坐标换算倍数，`HOST\dsh-tool-fs\lib\index.js:1005-1014`）。

**请求侧投影（真正上 wire 的尺寸）** —— 这条最容易被忽略（`HOST\dsh-llm-deepseek\lib\index.js:452-464`, `:1844-1850`）：

- `imagePixelBudget` 默认 **640,000 像素**（`DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET = 64e4`），`"low"` 时是 **512×512**；
- `imageMaxBytes` 默认 **1 MiB**（`DEFAULT_REQUEST_IMAGE_MAX_BYTES`）；
- 每个请求最多 600 张图（`DEFAULT_MAX_IMAGES_PER_REQUEST`）。
- 这两个值可以在 `llm-deepseek` 那一行的 `config.models.<name>.imagePixelBudget` / `.imageMaxBytes` 上调（`HOST\dsh-llm-deepseek\lib\index.js:1878-1882`）。

> **对 computer-use 的直接后果**：即使你截了 1920×1080 并存了 1568 宽的 png，模型**看到的**是一张 ≤640k 像素（约 924×692 或等比）且 ≤1 MiB 的图。模型返回的点击坐标是在**这张最终图**的坐标系里。所以坐标映射应按 `最终请求图尺寸 / 物理屏幕尺寸` 的缩放比计算；只按"我存进去的尺寸"算会系统性点偏。建议：自己先缩到接近 640k 像素（如 1024×640）再 `saveImage`，让投影几乎不发生二次缩放，映射稳定可预测 —— 这也是仓库现有 config 里 `screenshot.maxWidth: 1568` 需要复核的地方（1568×882 ≈ 1.38M 像素，仍会被请求侧再缩一次）。

### 3.6 图片能力是按路由"门控"的

- `llm` 层：若某路由的 `inputModalities` 明确不含 `image`，会先 `projectImagesForTextModel()` 把图换成稳定占位文本（`HOST\dsh-llm\lib\index.js:2251`），**不会**报错。
- `llm-deepseek` 适配器：`assertTextOnly()` / `assertSupportedImageRoles()` 会拒绝 `system`/`assistant` 角色里的图片；**只有 `user` 和 `tool-result` 里的图片合法**（`HOST\dsh-llm-deepseek\lib\index.js:46-53`）。
- in-box 的 `read_image` 额外做了**严格门控**：解析当前路由的 provider/model 并要求 `inputModalities` 显式包含 `'image'`，否则拒绝（`HOST\dsh-tool-fs\lib\index.js:965-973`）。**建议照抄这个门控** —— 否则用户在纯文本模型上会拿到一张静默变成占位符的图。
- DeepSeek 目录里模型默认 `inputModalities: ["text","image"]`（`HOST\dsh-llm-deepseek\lib\index.js:1846`），所以默认路由是能收图的。

### 3.7 如果这条路"不通"的备选（本次结论：不需要）

按优先级：① 直接返回 image 块（本文方案）；② 返回保存后的绝对路径 + 文本说明，让模型自己调 `read_image`；③ MCP + 图片。**本次勘察结论是 ① 可用，无需 ②③。**

### 3.8 证据

- `HOST\dsh-llm\lib\types\types.d.ts:50-56`（`ImageBlock`，无 base64 字段）、`:76-102`（`ToolResultBlock.content: ContentBlock[]`）
- `HOST\dsh-attachment\lib\types\types.d.ts:12-40`（`ImageMediaType`、`ImageAttachmentRef`）、`:65-140`（limits / `SaveImageAttachment` / `ImageRequestPolicy`）
- `HOST\dsh-attachment\lib\types\index.d.ts:12-15, 17-140`（服务名与全部方法签名）
- `HOST\dsh-attachment-local\lib\types\index.d.ts:24-56`（全部默认值）、`HOST\dsh-attachment-local\lib\index.js:888-908, 993-998`（常量实际值）
- `HOST\dsh-llm-deepseek\lib\index.js:19-24`（tool-result 图片路径的 doc 与常量）、`:62-73`（`imageParts` → `image_url`/`file`）、`:164-230`（`serializeMessagesWithImages`：把 tool-result 图片收进后随的 user 消息）
- `HOST\dsh-tool-fs\lib\index.js:901-948`（`IMAGE_VALUE_SCHEMA`）、`:965-995`（能力门控 / 部署门控 / 品牌化）、`:1005-1023`（文本信封 + `imageReadContent`）、`:1046-1120`（完整 `defineTool` 实现，含 `saveImage` 与错误码映射）
- `HOST\dsh-llm\lib\index.js:2251`（文本模型投影）、`HOST\dsh-llm-deepseek\lib\index.js:46-53`（角色限制）、`:452-464, 1844-1850`（请求图预算）
- 实测：`dsh --profile web --dump-config` 输出含 `- id: attachment-local / name: '@deepseek-ai/dsh-attachment-local'`。

---

## 4. 审批（approval）

### 4.1 结论

- 服务名 **`approval`**，类型 `ApprovalService`（`HOST\dsh-user-approval\lib\types\index.d.ts:11-15`）。
- **`defineTool` 没有 `approval` 字段**。审批是 `execute` 里的**一次服务调用**，不是声明。
- 唯一签名：`request(req: ApprovalRequest): Promise<ApprovalOutcome>`（`index.d.ts:130`）。
- `ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`（`HOST\dsh-user-approval\lib\types\types.d.ts:20`）。**只有 `'allowed-once'` 是许可**；其余三种都必须 fail closed（抛错 = 工具失败，模型收到 `isError` 结果，动作不执行）。
- `defineTool` 层面还有一个**更底层**的钩子：事件 `tools/pre-execute`，`PreToolDecision` 可以让一次调用被策略层拒绝（`HOST\dsh-tools\lib\types\index.d.ts:419-431`）。但那属于"策略插件"（`dsh-permission-presets` 一类），**工具自己请求批准应该用 `ctx.approval.request`**。

### 4.2 请求对象（`ApprovalRequest`）

`HOST\dsh-user-approval\lib\types\index.d.ts:66-92`：

| 字段 | 必填 | 说明 |
|---|---|---|
| `agent` | ✅ | 谁的会话在问。路由 UI answerer 用，也是审计事件的落点 |
| `toolName` | ✅ | 哪个工具的请求（展示 + 审计） |
| `callId` | ⭕ | 正在被决策的那次工具调用 id（`exec.callId`），让 UI 把提示挂到已流式的工具卡上 |
| `reason` | ⭕ | **人话解释为什么问**。强烈建议必填 |
| `signal` | ⭕ | abort 就撤回请求，立刻 settle `'cancelled'`，迟到的答案被丢弃 |

### 4.3 被拒时怎么表现（in-box 的规范做法）

`dsh-sandbox` 的 `approveEscalation` 是**官方参考实现**（`HOST\dsh-sandbox\lib\index.js:92-110`）：

```js
const outcome = await approval.approver.request({
  agent: approval.agent,
  toolName: approval.toolName,
  callId: approval.callId,
  reason: `escalate sandbox to ${mode}: ${justification}`,
  ...(approval.signal ? { signal: approval.signal } : {}),
})
switch (outcome) {
  case 'allowed-once': return mode
  case 'rejected':     throw new Error(`the user rejected escalating this ${subject} to "${mode}"`)
  case 'cancelled':    throw new Error(`approval for escalating to "${mode}" was cancelled`)
  case 'unavailable':  throw new Error(`sandbox escalation to "${mode}" requires approval, but no approval channel is available`)
  default: return assertNever(outcome, 'EscalationOutcome')
}
```

要点：**抛 `Error`**，不要返回一个"被拒绝"的规范值。工具 registry 会把 throw 变成 `isError` 结果，模型看得懂"用户拒绝了"，而且**动作确实没执行**。条件不满足（无 approver / 无 agent / 不是加宽）时**先抛**，不要先去问。

### 4.4 `policy: never` / `--danger-full-access` 时的行为

`ApprovalPolicy = 'ask' | 'never'`（`index.d.ts:36-47`）：

- `'ask'`（默认）：走 answerer waterfall；**没有 answerer 时落到 fail-closed 的 `'unavailable'`**。
- `'never'`：**永不提示任何人**，每个 ask **确定性地** resolve 成 `'rejected'`。这是 CI/无人值守的严格立场。

所以 `policy: never` 下你的 `request()` **不阻塞、不弹窗，直接返回 `'rejected'`** → 你的工具会抛错失败。**重要**：如果你把 `requireApproval` 写成"总是问"，那么在 `danger-full-access`（= `policy: never`）下你的工具会**全部不可用**。

`danger-full-access` 与 `approval: never` 的绑定就在 `dsh-base` 的 patch 里（`HOST\dsh-base\cordis.patch.yml:224-243`）：

```yaml
    - id: approval
      name: '@deepseek-ai/dsh-user-approval'
      config:
        policy: !!js "(process.env.DSH_PERMISSION_MODE ?? 'workspace-write') === 'danger-full-access' ? 'never' : 'ask'"

    - id: permission
      name: '@deepseek-ai/dsh-permission-presets'
      config:
        presets:
          read-only:        { sandbox: read-only,        approval: ask }
          workspace-write:  { sandbox: workspace-write,  approval: ask }
          danger-full-access: { sandbox: danger-full-access, approval: never }
```

→ **`--danger-full-access` 不是一个 CLI flag**，它是环境变量 **`DSH_PERMISSION_MODE=danger-full-access`**（`HOST\dsh-base\cordis.patch.yml:209`）。CLI 本身（`HOST\dsh\lib\bin.js:85-110`）只有 `--profile / --from-default-profile / --patch / --dump-config / --dump-default-config`，**没有** `--danger-full-access`。

**因此正确设计是**：`requireApproval` 做成三档（`'never' | 'mutating' | 'always'`），默认 `'mutating'`（只对会改状态的动作问），并且在 `outcome === 'unavailable'` 时**降级为拒绝而不是挂起**。仓库现有 config 里 `requireApproval: never` 作为默认值也是合理的（等于"信任会话策略"），但要让文档说清：用户想真的被问，需要 `requireApproval: mutating` **且** `DSH_PERMISSION_MODE` 不是 `danger-full-access`。

### 4.5 模板代码

```js
// REPO/src/approval.js
/**
 * 请求一次性的用户批准。返回 true 表示允许本次动作，false 表示拒绝/取消/无通道。
 * 绝不挂起：unavailable 一律当作拒绝。
 */
export async function askApproval(ctx, exec, { reason, mode }) {
  if (mode === 'never') return true
  const approver = ctx.get('approval')
  if (approver === undefined) return false            // fail closed
  if (exec.agent === undefined) return false          // 没有 agent 无法路由问题
  const outcome = await approver.request({
    agent: exec.agent,
    toolName: 'computer',                             // 或 exec.name
    callId: exec.callId,
    reason,
    ...(exec.signal ? { signal: exec.signal } : {}),
  })
  return outcome === 'allowed-once'
}
```

在 `execute` 里用：

```js
async execute(args, exec) {
  if (MUTATING.has(args.action)) {
    const ok = await askApproval(ctx, exec, {
      reason: `run computer action "${args.action}" on the real desktop`,
      mode: config.requireApproval,
    })
    if (!ok) throw new Error(`the user did not approve computer action "${args.action}"`)
  }
  // ……真正执行
}
```

> 审计是自动的：每次 `request()` 都会往请求者 session 追加 `approval/asked` + `approval/decided` 一对事件（`HOST\dsh-user-approval\lib\types\types.d.ts:36-52`）。不要在 `request` 之外再记一遍。另外 `request()` **要求当前 turn 是打开的**，idle 时 ask 会在追加任何事件之前就 reject（`index.d.ts:112-120`）。

### 4.6 证据

- `HOST\dsh-user-approval\lib\types\index.d.ts:11-15`（服务名）、`:36-47`（`ApprovalPolicy` 语义）、`:66-92`（`ApprovalRequest`）、`:112-130`（`request()` 的 fail-closed 契约）
- `HOST\dsh-user-approval\lib\types\types.d.ts:20`（`ApprovalOutcome`）、`:36-52`（审计事件）、`:60-75`（`approval/request` waterfall 事件）
- `HOST\dsh-sandbox\lib\index.js:92-110`（官方 `approveEscalation`：switch 四分支 + 抛错）
- `HOST\dsh-base\cordis.patch.yml:209`（`DSH_PERMISSION_MODE`）、`:224-243`（`approval` 行 + `permission` presets）
- `HOST\dsh-tools\lib\types\index.d.ts:419-447`（`PreToolDecision` / `PostToolDecision`：策略层钩子，与工具内审批互补）

---

## 5. 危险能力边界：沙箱、执行线程、超时

### 5.1 结论速览

| 问题 | 答案 | 依据 |
|---|---|---|
| `dsh-sandbox*` 会挡住 win32 交互式输入吗？ | **不会**。沙箱约束的是**子进程的写权限/命令**（文件系统 + 进程 spawn），不拦 GUI/Win32 调用 | §5.2 |
| 工具执行在单独 worker/线程里吗？ | **不在**。`execute()` 就在宿主 Node 进程里被 await | §5.3 |
| 能不能在工具里做 GUI 调用？ | **能**，因为你就在宿主进程内，可以直接用 native addon / `node:ffi` / `child_process` 起一个 helper | §5.3 |
| 工具超时默认多少？ | **没有默认**。`timeoutMs` 不声明 = 无 deadline；`timeout-policy` 插件本身**没有 Config** | §5.4 |
| 怎么配超时？ | 每个工具自己声明 `timeoutMs`（毫秒） | §5.4 |

### 5.2 沙箱是"命令与文件"的边界，不是"桌面"的边界

- `dsh-sandbox` 的语义单位是 **sandbox mode**：`read-only` / `workspace-write` / `danger-full-access`，以及"只能向上加宽、且每次加宽都要审批"的 `ESCLATION_TARGETS = ['workspace-write','danger-full-access']`（`HOST\dsh-sandbox\lib\index.js:28-45`）。
- win32 上的执行者是 ACL restricted-token runner：`ctx.sandbox` 在 Windows 解析到 ACL restricted-token 链（`HOST\dsh-pwsh-sandbox\lib\index.js:97-101`），只挂给 **shell 执行器**（`dsh-pwsh-sandbox` / `dsh-bash-sandbox`）和 **fs fence**（`dsh-fs-sandbox`）。
- 这意味着：`computer_screenshot` / `computer_click` 这类工具**自己**做的 Win32 调用**完全在沙箱语义之外** —— 沙箱不会拒绝你，**也不会保护你**。
- ⚠️ **这既是能力也是责任**：一旦你把 `dsh-computer-use` 装上去，模型就拥有一条**绕过沙箱**的通道（能点任何窗口、能 `SendKeys` 到管理员终端）。所以 §4 的审批对这类工具不是可选项，而是**唯一的防线**。仓库现有 config 的 `dryRun`、`escStop`、`overlay` 三个开关方向完全正确，建议默认值上再收紧一点。

### 5.3 执行线程：同进程、不可硬杀

`HOST\dsh-tools\lib\types\index.d.ts:166-171` 原文：

> "The registry preserves caller cancellation through around-dispatch signal replacement and **does not abandon this promise, but it cannot hard-kill same-process code**."

→ 工具体与宿主**同一个进程**，`execute()` 返回的 promise 被 registry await。推论：

1. **GUI 调用不会被 sandbox 拦**，但也**不会被进程隔离保护**；你的 native addon 崩了就是整个 DSH 崩。
2. **取消是协作式的**：`exec.signal` 被 abort 后，如果你的截图/点击循环不检查它，工具会一直跑（甚至已经超时了也还在跑）。
3. 长命的 GUI 资源（overlay 窗口、hook、COM 对象）要挂到 ctx 的 dispose 上，否则 profile reload（`patchReload: live` 会热重载）时会泄漏。
4. 需要真隔离的话，得你自己 `child_process` spawn 一个 helper 并管它的生命周期 —— 但那样就落回 `dsh-pwsh-sandbox` 的沙箱管辖之下（如果走的是 `ctx.shell`）。

### 5.4 超时：无默认值，纯 opt-in

- `dsh-tool-call-timeout-policy` 是一个 **`tools/execute` wrapper 插件**，`name = "timeout-policy"`，**没有 Config schema**（`HOST\dsh-tool-call-timeout-policy\lib\types\index.d.ts:1-30` 全文只有 `TOOL_TIMEOUT` / `name` / `inject` / `apply`）。
- 它挂在 `dsh-base` 里：`HOST\dsh-base\cordis.patch.yml:377-378`（`- id: timeout-policy`）。
- 逻辑（`HOST\dsh-tool-call-timeout-policy\lib\index.js:123-131`）：
  ```js
  const timeoutMs = ctx.tools.get(exec.name, exec.agent)?.timeoutMs
  if (timeoutMs === undefined) return next()          // 没声明 = 完全不管
  const d = deadline(exec.signal, timeoutMs, TOOL_TIMEOUT)
  ...
  if (timeoutOf(d.signal, 'TOOL_TIMEOUT') !== undefined) return toolTimeoutResult(timeoutMs)
  ```
- 超时结果的模型可见文案：`tool call timed out after ${timeoutMs}ms`（`:93-95`），结构化 code `TOOL_TIMEOUT`。
- **配置方式**：不是改插件 config，而是**在你的 `defineTool` 里写 `timeoutMs`**。改不动全局默认值。
- 另外 `dsh-base` 给 shell 的 timeout 是 60s（`HOST\dsh-base\cordis.patch.yml:62`、`:218`），那是**执行器**的 timeout，与工具 `timeoutMs` 是两回事。

> 建议：截图/点击这类动作 `timeoutMs: 15000~30000`；**并且**在 `execute` 里手动 `exec.signal.throwIfAborted()` 或 `signal.addEventListener('abort', ...)`，因为 wrapper 只会在**结果返回时**把内容替换成超时文案，它**不会**停掉你正在跑的代码。

### 5.5 证据

- `HOST\dsh-sandbox\lib\index.js:28-45`（`WIDER_MODES` / `ESCALATION_TARGETS`）、`:92-110`（审批式加宽）
- `HOST\dsh-pwsh-sandbox\lib\index.js:92-105`（win32 = ACL restricted-token；沙箱只挂 shell 执行器）
- `HOST\dsh-tools\lib\types\index.d.ts:166-171`（同进程、不可硬杀）、`:148-158`（`timeoutMs` 语义）
- `HOST\dsh-tool-call-timeout-policy\lib\types\index.d.ts:1-30`（无 Config）、`HOST\dsh-tool-call-timeout-policy\lib\index.js:93-95, 123-131`（实现）
- `HOST\dsh-base\cordis.patch.yml:377-378`（timeout-policy 已挂载）、`:62, 218`（shell 60s）

---

## 6. 配置（schemastery + cordis.patch.yml）

### 6.1 用 schemastery 写 `Config`

`Config` 的类型必须是 **StandardSchemaV1**（`HOST\cordis\lib\types\registry.d.ts:58-66`）。`schemastery` 的 `z` 自带 `~standard`（`HOST\schemastery\lib\types\index.d.ts:2, 142`）。

```js
import z from '@deepseek-ai/schemastery'
export const Config = z.object({ allowParallelInProgress: z.boolean().required() })
```

（in-box 范例：`HOST\dsh-tool-todo\lib\index.js:13-15`。zod 4 也实现了 `~standard`，但 `Config` 推荐 schemastery。）

`.default(v)` 不写就取默认值；`.required()` 不写就 **profile 启动失败**。第三方插件应当**所有字段都带默认值**，否则用户装上去 boot 就挂。

### 6.2 `config:` 怎么在 patch 里传

```yaml
- insert:
    - id: computer-use
      name: 'dsh-computer-use'
      config:
        enabled: true
        screenshot:
          maxWidth: 1024
          format: png
```

嵌套 YAML 对象整体作为 `apply(ctx, config)` 第二参（已校验 + 已填默认值）。`disabled: true` 是**行级**开关，比 `config.enabled: false` 更彻底（插件根本不加载）。

### 6.3 `!!js` 表达式

- 解析：`!!js` 标量 → `{ __jsExpr: "<源码>" }`（`HOST\dsh-app-boot\lib\index.js:17-30`，tag `tag:yaml.org,2002:js`）。
- 求值：行激活时执行 `new Function('ctx','expr','with (ctx) { return eval(expr) }')`（`HOST\cordis-plugin-loader\lib\index.js:288-294`；调用点 `:296`、`:378`）。

能用：全局对象（`process`、`Buffer`…）+ `ctx` 及其服务。
不能用：`import`、`require`、你模块里的局部变量 —— 复杂逻辑写成配置字段。

in-box 真实用法（`HOST\dsh-base\cordis.patch.yml:209-221`）：

```yaml
        mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'
        workspaceRoot: !!js process.cwd()
      disabled: !!js process.platform === 'win32'
```

`dsh --dump-config` 把 `!!js` **原样打印不求值**（`HOST\dsh-app-boot\lib\index.js:1211-1215`），dump 出来可粘回 patch。

### 6.4 用户改配置改哪个文件

**`PROFILE\cordis.patch.yml`** —— 不是 `cordis.yml`，也不是插件的 `cordis.patch.yml`。按 **`id`** 覆盖，最后一次写入生效：

```yaml
# E:\Users\lizhen\.dsh\profiles\web\cordis.patch.yml
- id: computer-use
  config:
    enabled: true
    requireApproval: mutating
    screenshot:
      maxWidth: 1024
```

三条硬规则：

1. **整块替换，不深合并**。没写的字段回落 schema 默认值，**不继承** bundle 里那份 config。
2. `name` 若写必须与被覆盖行一致，否则 warn+skip（`HOST\dsh-app-boot\lib\index.js:96-100`）。
3. 命不中行 → warn+skip、profile 照常启动。改完一定查 stderr 有没有 `entry ... not found`。

### 6.5 证据

`HOST\cordis\lib\types\registry.d.ts:58-66`；`HOST\schemastery\lib\types\index.d.ts:2, 142`；`HOST\dsh-tool-todo\lib\index.js:13-15`；`HOST\dsh-app-boot\lib\index.js:17-30, 59-105, 1101, 1195-1202`；`HOST\cordis-plugin-loader\lib\index.js:288-306, 378`；`HOST\dsh-base\cordis.patch.yml:209-221`；实测 `PROFILE\cordis.patch.yml` 为注释 + `[]`。

---

## 7. 本地开发 / 安装闭环

### 7.1 两个实测事实

1. **`pnpm` 不在 PATH 上**（`Get-Command pnpm` 返回空）。`dsh plugin` 的实现是 `spawnSync('pnpm', args, { cwd: profileDir, stdio:'inherit', shell: win32 })`；ENOENT 时打印 `dsh: pnpm not found on PATH — install pnpm to manage profile plugins` 并 **返回 127**（`HOST\dsh\lib\plugin-Ddi42qoW.js:146-152`）。
2. **bundled pnpm 是 `pnpm.mjs`，不是可执行 shim**：`E:\...\dependencies\pnpm\bin\` 下只有 `pnpm.mjs` / `pnpm.cjs` / `pnpx.*`。实测 `node E:\Users\lizhen\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs --version` → `11.28.5`（node v24.19.0）。

### 7.2 让 pnpm 可用（二选一）

方案 A（推荐）：全局装 pnpm，之后 `dsh plugin` 直接用。

```
npm install -g pnpm
pnpm --version
```

方案 B（不装东西）：直接用 bundled pnpm 在 profile 目录里跑 pnpm，再手工维护 bundles 列表。

```
cd E:\Users\lizhen\.dsh\profiles\web
node E:\Users\lizhen\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs add link:C:\Users\lizhen\Documents\deepseek-harness\default-workspace\dsh-computer-use
```

然后手工把 `dsh-computer-use` 追加到 `PROFILE\package.json` 的 `dsh.profile.bundles`（`dsh plugin` 的 reconcile 做的就是这件事，见 `HOST\dsh\lib\plugin-Ddi42qoW.js:60-88`）。注意 `dependencies` 里出现的名字必须是**包的真实 name**。

### 7.3 装进 web profile 并验证（逐条）

```
# 0. 定位 dsh CLI（实测可用；若已在 PATH 直接用 dsh）
$dsh = C:\Users\lizhen\AppData\Local\npm-cache\_npx\1e7f6d9597241db0\node_modules\.bin\dsh.cmd
& $dsh --version                                     # 实测输出 0.1.5-rc.2

# 1. 装（相对路径会按调用 dsh 时所在目录锚定）
cd C:\Users\lizhen\Documents\deepseek-harness\default-workspace\dsh-computer-use
& $dsh plugin --profile web add .

# 2. 确认 reconcile 真的写进了 bundles（关键验证点）
Get-Content E:\Users\lizhen\.dsh\profiles\web\package.json -Raw

# 3. 确认 layer 合成进来、且没有命不中行的 warn
& $dsh --profile web --dump-config 2>&1 | Select-String computer-use
```

第 2 步期望：`dsh.profile.bundles` 变成 `[dsh-base, dsh-web-app, dsh-computer-use]`（均带 `@deepseek-ai/` 前缀）。
**有 `dependencies` 但 `bundles` 没变** → 包的 `dsh.bundle.patch` 没被读到（路径写错，或 `files` 漏了 patch 文件）。

第 3 步期望：出现 `# == dsh-computer-use` 与 `- id: computer-use`。
`--dump-config` 是**静态合成**（不执行 `apply`），只证明行在树里，不证明工具注册成功。

### 7.4 免安装后门（不碰 pnpm，最快迭代）

`anchorInsertedPluginNames` 会把 patch 里以 `./`、`../` 或绝对路径写的 `name` 转成 `file://` URL（`HOST\dsh-app-boot\lib\index.js:1168-1178`），可完全跳过 `dsh plugin add`：

```yaml
# E:\Users\lizhen\.dsh\profiles\web\cordis.patch.yml
- insert:
    - id: computer-use-dev
      name: 'file:///C:/Users/lizhen/Documents/deepseek-harness/default-workspace/dsh-computer-use/src/index.js'
      config:
        enabled: true
```

优点：改源码即生效、无 install 步骤。
缺点：不是发布形状，且裸包名解析仍有 §8.2 的坑。适合快速验证契约，正式交付仍走 7.3。

### 7.5 验证工具真的出现在工具表里

```
& $dsh --profile headless Use the computer_screenshot tool once and report the image dimensions you received.
```

headless 模板 = `[dsh-base, dsh-headless]`，首次使用自动初始化（`HOST\dsh-app-boot\lib\index.js:335-338`）。

判据：模型真的发起了调用 → 工具在表里且 `render` 产物被接受；模型说没有这个工具 → 没注册（几乎总是 §1.4 的 `inject` 把整个插件卡死了）。

注意 headless 的 `bundles` 里没有你的插件（你只装进了 `web`）。三种补法：装两次；在 headless 的 `cordis.patch.yml` 也用 7.4 的法子；或用 `--patch` 临时 overlay（repeatable，`HOST\dsh\lib\bin.js:86`）。

**最省 token 的验证**：写 5 行 node 脚本 import 你的入口模块，断言返回对象有 `name` / `parameters` / `output.render` / `execute`，能挡住 90% 的契约错误而完全不用调用模型。in-box 另有 `@deepseek-ai/dsh-tools/testing` 的 `defineContentToolFixture` 供仓库内测试（`HOST\dsh-tools\lib\types\testing.d.ts:1-24`）。

### 7.6 生效时机

- `PROFILE\package.json` 的 `dsh.profile.patchReload` 为 **`live`**（实测）→ `cordis.patch.yml` 改动热应用，**不需重启**。
- `bundles` 列表变化 / 新增依赖属于 boot 期解析 → **必须重启 DSH**。

### 7.7 证据

`HOST\dsh\lib\plugin-Ddi42qoW.js:104-160`（`:146-152` ENOENT→127；`:157-160` git 插件需 allowBuilds）；`HOST\dsh\lib\bin.js:19-41, 86-110`；`HOST\dsh-app-boot\lib\index.js:335-338, 1168-1178`。
实测：`pnpm` 缺失；bundled `pnpm.mjs --version` = 11.28.5；`dsh --version` = 0.1.5-rc.2；`dsh --profile web --dump-config` 正常输出带 `# ==` 来源注释的合成树。

---

## 8. 风险清单（第三方插件常见踩坑）

### 8.1 包形状 / ESM

| # | 坑 | 症状 | 正确做法 |
|---|---|---|---|
| 1 | 必须 `type: module` 且发布**编译后**的 JS | `Unexpected token export` / `Cannot use import statement` | `tsc` 出 ESM，`main` / `exports` 指向 `lib/*.js` |
| 2 | 不能直接发 TS（宿主无 TS loader） | `Unknown file extension .ts` | 先编译，`exports` 只暴露 `.js` |
| 3 | `exports` 漏了 `./package.json` | 部分工具链解析不到 | 加 `./package.json: ./package.json` |
| 4 | `files` 漏掉 `cordis.patch.yml` | 本地能跑，装进 profile 后 boot 报 `failed to read overlay` | `files` 必须含 `cordis.patch.yml` 与 `lib`/`src` |
| 5 | 同时有 `default` 和命名导出 | 命名导出的 `inject` / `Config` 被忽略 | 二选一，推荐**只**用命名导出 |
| 6 | `name` 与包名混淆 | 只是 warning，但易撞 `provide` | `name` 用短名（`computer-use`），包名 `dsh-computer-use` |

依据：`HOST\dsh-tool-todo\package.json`（形状样板）；`HOST\cordis-plugin-loader\lib\index.js:270-284`（只有 `import()`）、`:746-752`（default 优先）；`HOST\dsh-app-boot\lib\index.js:1160-1167`（patch 缺失即 throw）；`HOST\dsh-tool-todo\lib\index.js:11, 196`（命名导出样板）。

### 8.2 依赖解析（**最要命的坑之一**）

profile 目录是 `E:\Users\lizhen\.dsh\profiles\web`，它的 `node_modules` 由 pnpm 管理。而宿主自己的 `@deepseek-ai/*` 在 **npx 缓存**里（`HOST`），**不在 profile 的解析链上**。

后果：你的 `import { defineTool } from '@deepseek-ai/dsh-tools'` 会从**你的插件文件**往上找 `node_modules`；profile 里没有 → `ERR_MODULE_NOT_FOUND`。

而且 `PROFILE\pnpm-workspace.yaml` 设了 **`autoInstallPeers: false`**（实测），所以写在 `peerDependencies` 里的宿主包**不会被自动安装**。

三个方案：

1. **把宿主包写进 `dependencies`**：pnpm 从 registry 装一份。省事，但有**版本漂移**风险（必须钉到宿主同版本）且会出现**两份 `dsh-tools`**；`defineTool` 只产出纯对象、registry 按形状消费，通常没事，但任何 `instanceof` 跨副本会失败。
2. **装完手动链接宿主副本**（最稳）：在 `PROFILE\node_modules\@deepseek-ai\` 下为 `dsh-tools`、`dsh-attachment`、`dsh-llm`、`dsh-user-approval`、`cordis`、`schemastery` 建目录联接（junction），指向 `HOST` 下的同名目录。这样插件与宿主共用**同一份**模块实例。
3. **零依赖写法**：入口模块不 import 任何 `@deepseek-ai/*`，直接手写 `{ name, description, parameters, output, execute }` 并 `ctx.tools.register({...})`。`register(definition: ToolDefinition)` 只按形状消费（`HOST\dsh-tools\lib\types\index.d.ts:601`），**不要求**对象来自 `defineTool`。代价是失去 `defineTool` 的参数校验。

> 版本漂移实测：CLI 报 `0.1.5-rc.2`，而各包 `package.json` 的 `version` 是 `0.1.5-rc.3`。**不要假设 rc.2 与 rc.3 的 API 相同**，以本文引用的 `.d.ts` 为准。

### 8.3 语义 / 运行时

| # | 坑 | 正确做法 |
|---|---|---|
| 7 | 把**可选**依赖写进 `inject` | 该服务缺失时整个插件**静默不加载**，连工具都没有。可选依赖用 `ctx.get()` + 判空，或 `ctx.inject([...], cb)` 只包住需要它的部分 |
| 8 | `output.render` 写成 async / 带副作用 | 它会为实时调用**和**日志 replay 各跑一次。必须纯同步、只依赖 `(args, value)` |
| 9 | `execute` 不转发 `exec.signal` | 声明了 `timeoutMs` 却无法收敛 → 超时后仍在跑还占着 GUI |
| 10 | 用返回值表达失败 | 想返回数据就返回规范值，想让模型停手就 `throw`（throw = `isError`，模型看得懂，动作也确实没执行） |
| 11 | 在 `render` 里造每次不同的对象 | replay 不一致、diff/缓存失效。图片块要用 `value` 里的字段重建 |
| 12 | 给根 `parameters` 写 `additionalProperties` | 根是隐式开放对象，写了会被当非法字段 |
| 13 | 嵌套 `object` 忘了 `additionalProperties` | `defineTool` 编译期直接报错（`schema.d.ts:61-67` 强制） |
| 14 | 在 `!!js` 里写多行逻辑或想 `import` | 求值器只有 `ctx` + 全局对象 |
| 15 | 改 profile 时改 `cordis.yml` | 那个文件永远是 `[]`。只改 `cordis.patch.yml` |
| 16 | 以为 patch 的 `config` 是深合并 | 是**整块替换**，少写的字段回落 schema 默认值 |

### 8.4 安全（computer-use 特有）

| # | 风险 | 缓解 |
|---|---|---|
| 17 | 工具同进程 → native addon 崩溃拖垮整个 DSH | 把 Win32/GUI 工作放子进程 helper，主进程只做 IPC |
| 18 | 绕过沙箱 → 模型能点任何窗口 | 审批默认 `mutating`；`dryRun` 默认开；全局 Esc 停；overlay 明示受控 |
| 19 | 截图含密码/私密内容 | 提供窗口白名单 / 遮罩；明确告知用户截图会上传模型 |
| 20 | 坐标映射错 → 点偏到危险位置 | 按**最终请求图尺寸**算缩放（§3.5），并在文本信封里给出映射系数 |

### 8.5 证据

`HOST\cordis-plugin-loader\lib\index.js:270-284, 288-294, 746-752`；`HOST\dsh-app-boot\lib\index.js:826-836, 1160-1167, 1168-1178`；`HOST\dsh-tools\lib\types\schema.d.ts:61-67`；`HOST\dsh-tools\lib\types\index.d.ts:601`；`HOST\dsh-tool-todo\package.json` + `lib\index.js:11, 13-15, 196`。
实测：`PROFILE\pnpm-workspace.yaml` 含 `autoInstallPeers: false` 与 `nodeLinker: hoisted`；CLI `0.1.5-rc.2` vs 包 `0.1.5-rc.3`。

---

## TL;DR —— 写插件必须照做的 10 条硬性要求

1. **包必须是 ESM**：`type: module` + 编译好的 `.js`（宿主无 TS loader）+ `exports` 带 `./package.json`。
2. **`package.json` 必须有 `dsh.bundle.patch`** 指向 `./cordis.patch.yml`，且 `files` 要包含该文件 —— 这是能否成为 profile layer 的唯一开关。
3. **patch 顶层是数组**，最小形态是一条 `- insert:` + 一个带 `id` 的行；`id` 一定要给（用户靠它覆盖/禁用）。
4. **入口用命名导出** `{ name, inject, Config, apply }`，不要与 `default` 并存（`default` 会吞掉元数据）。
5. **`inject` 只写缺了就不该活的服务**（通常 `['tools']`）；可选依赖一律 `ctx.get()` + 判空，否则整个插件静默不加载。
6. **`output.render` 必须纯同步**（`(args, value) => ContentBlock[]`）；`output.schema` 必须声明，`object` 节点必须写 `additionalProperties`，根 `parameters` 不要写。
7. **发图三步**：`ctx.attachments.saveImage({data, mediaType, name})` → 把 `ImageAttachmentRef` 放进规范值 → `render` 返回 `{ type: 'image', attachment: ref }`。**ImageBlock 里没有 base64 字段。**
8. **坐标按最终请求图算**：存储归一化 2048x2048 / 4 MiB，请求投影 **640,000 像素 / 1 MiB** —— 别按自己截的尺寸算点击。
9. **审批 = `ctx.approval.request({agent, toolName, callId, reason, signal})`，只在 `allowed-once` 放行**，其余三种一律 fail closed；`DSH_PERMISSION_MODE=danger-full-access` 会把策略钉成 `never`（直接 rejected），所以别把审批写成总是问。
10. **超时无默认值**：每个工具自己声明 `timeoutMs`，并真的转发 `exec.signal`（registry 不会硬杀同进程代码）。装之前用 `dsh plugin --profile web add .` + `dsh --profile web --dump-config` 验证合成，再用 `--profile headless` 验证工具真在表里。

---

*本报告全部结论来自对已安装宿主源码的只读勘察 + 现场命令实测。未修改任何已有代码；唯一写入文件为本文件。*
