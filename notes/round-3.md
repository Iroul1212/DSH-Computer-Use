# 第三轮：按顺序补齐四件事

## 1. 按描述找控件（UIA 模糊匹配 + top-3 + 标注截图）

新增 `src/match.js`（纯函数，无 IO，可离线测）：

- 归一化：小写、NFKC（全角半角等价）、去掉标点与符号；
- 中文用**二元组**切词，所以「保存」能命中「保存并关闭」，不需要词典；
- 按 name → automationId → helpText → value → role 的权重打分，命中方式分为
  完全相同 / 前缀 / 包含 / 被查询包含 / 词重合度 / 子序列覆盖率；
- 查询里的类别词（按钮 / button / 输入框 …）会与 role 互相加分，反之减分；
- 禁用 ×0.75、滚出屏幕 ×0.45、尺寸退化 ×0.5，可操作角色 ×1.05；
- 返回 `{score, why}`：分数 + 一句人能看懂的理由。

`ui_element find` 现在收 `description`：

```
3 candidates for "search" in hwnd=527672 (175 controls walked):
1. Group "FileExplorerSearchBox" path=0/2/0/5 score=0.77 - automationId contains the query; bounds=... image=(789,56)
2. ...
```

并把候选在截图上标成 **1..N**（host 新增 `pins` 装饰，物理坐标 → 图像坐标由 host 换算），
视觉模型可以直接照着编号挑。`nameContains` 保留原来的精确子串语义（返回全部命中，最多 20）。

实测：Explorer 175 个控件 → 第一名正是搜索框，三个编号钉在截图上（肉眼验过）。

## 2. wait_for stable 复用帧签名

上一轮已经改好了算法（0.2% 容差），这轮补的是**契约**：`waitKind` / `timeoutMs` /
`stableMs` / `titleMatch` / `name` / `lang` / `maxLines` 这些参数**根本没有出现在 schema 里**，
模型按 schema 调用根本够不着。现在全部声明、`stableMs` 透传，成功文案还会报
「帧安静到 0.02%」这样的实际数值。

## 3. 敏感区域脱敏

`maskRegions`（物理像素矩形，**只能由部署配置**写，工具调用无法开关）在
runtime 的 `call()` 这个唯一入口注入，因此：

- 模型看到的附件是黑的；
- `compare` / `verify` / `wait_for stable` 用的帧签名是黑的；
- OCR 读的那张 PNG 也是黑的（`recognize()` 同样走 `screenshot`）。

实测：整屏遮罩后 OCR 返回 0 行、帧比对恒定「无变化」；传 `mask: null` 也关不掉。
被遮罩的截图会在文字里说明，模型知道那里为什么看不见。

## 4. npm 打包 + 一行安装

- `scripts/package-check.mjs`：打出 `npm publish` 会真正上传的 tarball，断言
  manifest / 所有运行时脚本 / 两个 README / 内置技能都在包里，再解压到别处 import 入口，
  证明解包后仍能启动；还会检查 `cordis.patch.yml` 的 `name:` 与包名一致。**17 项全绿**。
- `prepack` 跑两个离线套件，写坏的工具定义发布不出去；`npm run release` = pack:check + publish。
- 一行安装已实测（临时 profile `cutest`，装完即删）：
  `dsh plugin --profile cutest add "file:<repo>"` → `dsh --profile cutest --dump-config`
  里出现 `# == dsh-computer-use` / `id: computer-use`。
- npm 上的 `dsh-computer-use` 已被他人占用，所以 README 里写清：改成自己的名字
  （`npm pkg set name=...`，同时改 cordis 行的 `name:`，pack:check 会替你守住这条不变量），
  或者直接用 tarball / git / 本地路径安装。
