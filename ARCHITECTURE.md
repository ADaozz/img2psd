# 架构：把 agent 变成可替换运行时

## 硬约束

1. **只有生图/放大可以碰模型/Codex。** 仅 `src/agents/codex.ts` 允许调用 Codex CLI；其余路径不得 `import '@openai/codex-sdk'`、不得启动 App Server、不得读 `~/.codex`。生图/放大是可插拔后端：`local`（本地放大）/ `api`（兼容 Images API）/ `apiyi`（API易图片编辑）/ `codex`（Codex CLI）。API易按模型 id 选择请求协议。
2. **程序永不调用模型。** 管线只生产 job、校验提交、发布事实。
3. **任何 agent 都能执行。** 执行者只需：能跑 shell、能读写文件、能查看图片。不要求 tool-calling 协议、不要求 MCP、不要求特定 SDK。

## 分层

| 层 | 内容 | 依赖 |
|---|---|---|
| L0 core | 分组树、事实与哈希、SVG 校验、父范围、补全合成、整树合并、失效与恢复 | 仅 `sharp` + Node 标准库 |
| L1 job | 把每个待做步骤物化为一个自包含目录（机器可读 + 人类可读） | L0 |
| L2 agent 边界 | `l2d` CLI：唯一交互面 | L0/L1 |
| L3 图片后端 | `imagegen` / `upscale` 命令 | `local` / `api` / `apiyi` / `codex` 任选 |

**依赖方向单向**：L3 → L2 → L1 → L0，任何一层都不知道执行者是谁。

## job 契约

```
jobs/<seq>-<step>-<group-slug>/
  job.json          机器可读：step / groupId / canvas / 输入绝对路径 / 输出 draft 路径 / 约束
  INSTRUCTIONS.md   完整正文（复用上游 prompts，含本次输入与操作约定）
  inputs/           参考图、父 SVG、候选 SVG、同级参考（只读）
  out/draft.svg     agent 的唯一可写产物
  observations.json 程序登记（由 preview 生成，agent 不能伪造）
  result.json       submit 通过后的事实（哈希、note、verdict）
```

三条不变量：

- **无状态**：返修 job 自带 candidate + feedback + 完整正文，不依赖 agent 会话或 thread。
- **只写草稿**：正式 SVG / groups.json / occlusion.json 只能由 `l2d submit` 发布。
- **证据先行**：`submit` 会核对观察记录（某文件某 mode 看过）与文件哈希是否仍匹配。

## 运行目录布局

```
<run>/part-layering/
  input/original.png              原图（参考准备输入）
  references/preparation.json     参考准备事实（画布、哈希、透明比例、note）
  groups.json                     组树（程序维护）
  references/base-subject.png     素体参考（画布尺寸来源）
  stages/outline/<id>.svg         正式轮廓（只有 submit 会发布）
  stages/review/<id>.review.json  审查记录（轮数、结论、候选哈希、返修次数）
  stages/outline-reduce/<id>.svg  去重稿（补全的只读底稿）
  stages/outline-reduce/layers/<depth>.json  整层去重批次记录
  stages/occlusion/candidate.svg  候选叠放预览（按提案深度排序）
  preview.svg                     整树合并结果（全树完成后程序生成）
  occlusion.json                  遮挡层级表 v3（back-to-front）

<task>/raster-layering/           栅格管线（--run 指向这里）
  raster.json                     步骤定义与上游路径
  step01/ …                       步骤产物（KRA / PNG / report.md）
  step01/.completed               完成标记（只有 submit 会写）
  jobs/<kind>-<slug>/             job 目录（同一节点同类 job 目录固定）
```

## CLI（agent 唯一接口）

| 命令 | 状态 | 作用 |
|---|---|---|
| `l2d next --run <dir> [--review-rounds 1..4] [--expand] [--json]` | ✅ | 目录含 `raster.json` 时按栅格步骤推进；否则参考准备 → 分层步骤 → 合并 → 遮挡 |
| `l2d preview --job <dir> [--svg <p>] [--mode svg\|blend\|edge] [--crop] [--scale]` | ✅ | 渲染并登记观测（`observations.json`） |
| `l2d submit --job <dir> [--svg <p>]` | ✅ | 轮廓：校验 + 发布正式 SVG；返修时累加返修计数 |
| `l2d submit --job <dir> --verdict pass\|revise\|blocked --feedback ...` | ✅ | review：哈希核对 + 追加结论 |
| `l2d submit --job <dir> --paths '<json>' \| --paths @f.json` | ✅ | 补全：从只读底稿重新合成草稿并清空旧观测 |
| `l2d submit --job <dir> --note "依据"` | ✅ | 补全：原形保留断言 + 独显/blend 双自检 + 发布 |
| `l2d submit --job <dir> --group <id> --svg <p>` | ✅ | 去重：提交本层单组改写，文件须在 job 目录内 |
| `l2d submit --job <dir> --note "依据"`（去重） | ✅ | 整层结论：未提交组逐字节复制，写批次记录 |
| `l2d submit --job <dir> --children '<json>' --note ...` | ✅ | 拆分：程序生成 ID、原子写入组树 |
| `l2d submit --job <dir> --levels '<json>'` | ✅ | 遮挡：覆盖性/唯一 level 校验，生成候选叠放预览并清空旧观测 |
| `l2d submit --job <dir> --checks '<json>' --note ...` | ✅ | 遮挡：逐件检查齐全后发布 `occlusion.json` v3 |
| `l2d status --run <dir> [--json]` | ✅ | 从文件推导事实并汇总 |
| `l2d validate --run <dir> [--stage ...]` | ✅ | 全量校验（含父范围与补全保留） |
| `l2d check --svg <p> --group <id> ...` | ✅ | 单文件校验 |
| `l2d merge --run <dir> --out <file> [--depth N] [--partial]` | ✅ | 整树合并出 preview.svg |
| `l2d occlusion` | ⬜ | 遮挡层级表（后续） |
| `l2d imagegen` / `l2d upscale` | ✅ | 可插拔后端：`L2D_IMAGE_BACKEND=api\|apiyi\|codex`、`L2D_UPSCALE_BACKEND=local\|codex` |

## 校验（与上游一致，不放宽）

- `validateGroupSvg`：`viewBox` 与画布一致、仅绑定当前 `data-group-path`、容器有 `id`、禁止 `image/script/foreignObject`、必须有可见 alpha。
- `checkParentBounds`：子父 SVG 各四倍渲染，先算 `max(子 alpha - 父 alpha, 0)`，再二值化；任一未覆盖采样即失败。
- `composeCompletion` + `assertCompletionPreserves`：只接受新增闭合路径，原正文逐字保留。
- `mergePartSvgs`：只画终止叶节点，按树序嵌套，资源 ID 隔离。
- 事实：SVG 哈希兼容 LF/CRLF；输入版本变化只失效真实引用者。

## 与上游的差异

| 上游 | 本实现 |
|---|---|
| `CodexAgents` + `@openai/codex-sdk` | 删除；改为 job + CLI |
| App Server `dynamicTools`（实验协议） | 删除；工具语义转成 CLI 参数与 job 约束 |
| 每组绘制 thread 复用 | 删除；返修 job 无状态 |
| `AgentRuntime` 按 Codex 错误码重试 | 删除；重试=未完成的 job 重新出现 |
| `AgentLog` 记录协议事件 | 改为 job 目录内 `result.json` + 可选原始 transcript |
| 生图/放大 | 保留为 L3 两个命令 |

## 迁移顺序

0. ✅ **参考准备 job**：简化判断 + 素体换装，程序校验尺寸/透明面积并写 `preparation.json`。
0b. ✅ **初始分组 job**：组树为空时派发，只收一层 `name/note`，程序写 `groups.json`。
1. ✅ **L0 core**：校验、父范围、补全合成、合并——已用现有 `parts/` 与 136 个真实文件回归。
2. ✅ **L1 job + `l2d next/submit/preview`**：轮廓绘制/返修/review 与遮挡补全已端到端跑通（含未自检拒绝、父级阻塞、审查轮数累积、补全原形保留、草稿篡改拒绝）。
3. ✅ **整层去重与直属拆分**：按层派发、批次记录、程序生成 ID 并写回组树（`--expand`）。
4. ✅ **遮挡层级规划**：`occlusion.json` v3（back-to-front，逐件 `level/note/check`，候选叠放核对）。
5. ✅ **L3 图片后端**：`local`、`api`、`apiyi`（API易图片编辑）、`codex`，按环境变量或模型选择；简化和素体交付带 Alpha 的 PNG：GPT 原生校验、Nano 双背景恢复；不做单背景去背。
6. ✅ **raster / clothing-raster**：`raster.json` 驱动步骤；绘制与 review/返修是独立 job（`.drawn` → review → 返修 → review，轮数用完按 repaired 定稿）。

## 风险与取舍

- **质量回归**：提示词按上游模型调优，换执行者后需要真实样本回归，模拟测试证明不了视觉质量。
- **无会话返修**：返修质量可能略降；换来的是任何 agent 可接手、可并行、可断电续跑。
- **review 轮数**：仍由程序计数（`stages/review/*.review.json`），不依赖 agent 自觉。
- **观测证据**：由 CLI 登记，agent 只拿到 PNG 路径；这一条是"任何 agent"方案能守住质量底线的关键。
