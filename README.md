# live2d-portable

`live2d-maker` 的可移植复刻版：**由外部 agent 推进全部步骤，程序负责派发、校验与发布；图片生成通过 CLI 调用已配置的模型服务。**

上游快照见 [`vendor/live2d-maker`](vendor/live2d-maker)（AstraLayering `71140f3`，116 个 TS 文件 / 12519 行 / 70 份提示词 / 17 个工具）。本目录只保留源码，不含 `node_modules` 与运行数据。

Agent 首先阅读 [AGENTS.md](AGENTS.md)，完整操作协议见 [docs/AGENT-PROTOCOL.md](docs/AGENT-PROTOCOL.md)。没有全局 `l2d` 命令也可直接使用 `node src/cli/main.ts`。

## 目标

1. **零 Codex 依赖的管线核心**：编排、分组事实、SVG 校验、父范围、补全合成、整树合并、失效与恢复全部是纯程序。
2. **agent 无关的执行边界**：绘制/review/去重/补全/拆分/遮挡规划都由外部 agent 完成，agent 只需要三样能力——能执行 shell 命令、能读写文件、能看图。
3. **Codex 只保留两个能力**：`imagegen`（生图）与 `upscale`（放大），且都是可插拔后端——`local` / `api` / `apiyi` / `codex` 按操作选择。
4. **校验不放松**：可编辑矢量、画布一致、`data-group-path` 绑定、父范围四倍采样、补全保留原形、哈希事实与逐件失效全部沿用上游规则。

## 非目标

- 不追求与上游 API 兼容（`CodexAgents` / `AgentSession` / App Server 协议全部去掉）。
- 保留上游绘制要求；执行指令适配本仓库 CLI，移除不可用的上游工具调用。
- 不在本期实现 Cubism 绑定与动画。

## 目录

```
live2d-portable/
  ARCHITECTURE.md          分层、job 契约、CLI 命令、Codex 边界
  docs/AGENT-PROTOCOL.md   任何 agent 的执行协议（循环 + 规则 + 目录）
  prompts/                 从上游引入的提示词正文（准备 / 轮廓 / review / 返修 / 去重 / 补全 / 拆分 / 遮挡）
  resources/               简化画风参考、连体服款式参考
  templates/               raster.json 模板（raster-layering / clothing-raster-layering）
  src/
    core/svg/              validate / render / completion / merge
    core/facts/            groups（树、原子写）/ hash / review（轮数与结论）
    core/jobs/             plan（派发）/ materialize（job 物化）/ submit / observations
    cli/main.ts            l2d 命令入口
    agents/                image（选后端）/ local / api / apiyi / transparency / codex；只有 codex.ts 调用 Codex CLI
  vendor/live2d-maker/     上游只读快照（未纳入 git，可用下面的命令恢复）
```

## 状态：job 闭环已可跑通

| 能力 | 状态 | 说明 |
|---|---|---|
| SVG 校验（画布 / `data-group-path` / 无位图 / 可见 alpha） | ✅ | `src/core/svg/validate.ts` |
| 父范围四倍超采样 | ✅ | 同一函数，失败返回越界采样与包围盒 |
| 补全合成与原形保留断言 | ✅ | `src/core/svg/completion.ts` |
| 整树合并 + 命名空间隔离 | ✅ | `src/core/svg/merge.ts` |
| 预览渲染（svg / blend / edge + crop + scale） | ✅ | `src/core/svg/render.ts` |
| `l2d status / validate / check / preview / merge` | ✅ | 程序侧事实与校验 |
| **参考准备 job（简化 / 素体换装）** | ✅ | 缺 `references/base-subject.png` 时先派发；程序校验尺寸、透明面积并写 `preparation.json` |
| **job 物化 + `l2d next`** | ✅ | 准备 → 绘制/返修/review → 去重 → 补全 → 拆分 → 合并 → 遮挡，全程层屏障；job 无状态 |
| **`l2d submit` 发布事实** | ✅ | 校验 + 观测核对 + 审查轮数累积 + 返修计数 |
| **review → 返修 → review 闭环** | ✅ | 端到端测试覆盖，含拒绝未自检提交 |
| **遮挡补全 job（只收新增路径）** | ✅ | 程序从只读底稿合成、原形保留断言、独显+blend 双自检、发布 `parts/` 与自检记录 |
| **整层去重 job** | ✅ | 按层派发；单组层自动复制；未提交组逐字节复制；批次记录 `layers/<depth>.json` |
| **直属拆分 job（`--expand`）** | ✅ | 只收 `name/kind/note`，程序生成 ID、拒绝重复与单 part 包装、原子写入组树 |
| **遮挡层级规划 job（`occlusion.json` v3）** | ✅ | 全树完成后自动合并 `preview.svg`，程序生成候选叠放预览，逐件检查后才发布 |
| **`l2d imagegen / upscale`（可插拔后端）** | ✅ | `local`（Lanczos 放大）、`api`（Images API）、`apiyi`（API易图片编辑）、`codex`（CLI）；只有 `codex.ts` 调用 Codex |
| **raster / clothing-raster（Krita 位图）** | ✅ | `raster.json` 驱动步骤；绘制与 review/返修是独立 job；交付校验后写 `.drawn` / `.completed` |
| **初始分组 job** | ✅ | 组树为空时派发；只收 `name/note`，程序生成 id 并写 `groups.json` |

参考准备要求交付真实透明 PNG（GPT 原生 / Nano 双背景恢复），随后 `next` 自动进入初始分组；栅格用现有 28 个 part 作为上游，`next` 直接派发 `step01`。

## 已知限制

- **没有 web 工作台与调度器**：只有 `l2d` CLI，进度靠 `l2d status`，恢复靠再跑一次 `next`。
- **遮挡层级只支持单深度 `level`**：v3 的 `levels: [{level, region}]` 多深度区域还没实现。
- **raster 未在本机跑真实 Krita 端到端**：流程与交付校验有测试覆盖，但真正的分层/补全质量取决于执行该步骤的 agent 与 Krita 环境。
- **图片生成依赖外部服务**：`apiyi` 需要 `APIYI_API_KEY`，`api` 需要兼容 Images API 的网关，`codex` 需要 Codex CLI；只有放大默认走本地。

## 上游快照

`vendor/live2d-maker` 只用于对照移植与回归，不随仓库提交。恢复方式：

```bash
git clone --depth 1 https://github.com/wu-tian807/AstraLayering.git /tmp/astra
git -C /tmp/astra fetch --depth 1 origin 71140f36f17d79b84b125b2ff8520cce7479afeb
git -C /tmp/astra checkout 71140f3
cp -a /tmp/astra/.agents/skills/live2d-maker vendor/live2d-maker
```

## 配置

项目根目录的 `.env` 会在 CLI 启动时自动加载（`src/config/env.ts`）：命令行已有的环境变量优先，`L2D_NO_DOTENV=1` 可关闭。`.env` 已加入 `.gitignore`，权限建议 600；模板见 `.env.example`。

```bash
L2D_IMAGE_BACKEND=apiyi           # apiyi | api | codex
L2D_IMAGE_MODEL=gemini-nano-banana-2.1
APIYI_API_KEY=...                 # apiyi 后端必填，只留在服务端 .env
L2D_UPSCALE_BACKEND=local         # local | codex
```

`l2d imagegen --task standardize|body_reference|fast_comparison` 分别对应 `gemini-nano-banana-2.1`、`gpt-image-2.5-sunburst`、`gpt-image-2.5-flare`，也可用 `--model` 指定。API易只做图生图，至少要一张 `--ref`。

简化和素体都使用 `--background transparent`，交付真实 Alpha 的 PNG（RGBA）。GPT 接口携带 `background=transparent`、`output_format=png`，返回不透明或全透明图片时拒绝交付；校验在缩放补边前完成。Nano Banana 的同名选项由工具处理，不透传到 Gemini API：按主体颜色选绿/蓝/红背景，原生 Alpha 优先，否则仅以第一张生图为参考换成黑/白背景，再用受约束最小二乘恢复 Alpha 与边缘 RGB。禁止单背景色键去背或 rematte。

Nano 透明恢复最多需要两次生图（网络重试另计）。要求边缘均匀背景 ≥60%、背景 RGB 距离 ≥64；第二张画布比例差 ≤2% 时等比适配，超过则失败。明显主体漂移或重绘造成的恢复残差会被拒绝；这不能保证两次主体逐像素一致，实际薄纱和细线仍需看样本。每次透明请求在 `<输出>.transparency-*` 目录保留原始响应、原图、第二张图、恢复结果、Alpha 蒙版与报告（按实际执行阶段生成），失败写 `error.json` 且不覆盖交付文件。`--dry-run` 可查看透明处理策略，不调用模型。

生图/下载对网络层失败会重试 3 次（代理环境下的长请求偶发被重置）。

## 回归证据

```bash
npm test                                               # 39 项
./node_modules/.bin/tsc -p tsconfig.json                  # 无错误
node src/cli/main.ts status   --run ../.run/my-character/part-layering   # 只读核对现有产物
node src/cli/main.ts validate --run ../.run/my-character/part-layering   # 136 个文件全过
```

- `validate`：136 个真实文件（54 轮廓 + 54 去重 + 28 补全）全部通过，约 17 秒。
- `merge --depth 1`：21 个终止叶子合并成功；渲染结果与上游 `mergePartSvgs` 输出**像素级一致**。
- 全量 **39 项**测试（管线闭环、图片后端与透明恢复）：轮廓 `next → 绘制 → review(revise) → 返修 → review(pass)`；补全"只收新增路径 + 原形保留 + 草稿篡改拒绝"；整层去重"变更组与复制组 + 批次记录"；直属拆分"程序生成 ID + 拒绝单 part 包装 + 子组进入下一层"；遮挡层级"覆盖/唯一 level/候选叠放/漏检拒绝 + v3 落盘"；参考准备"缺图时先派发、尺寸/透明校验、写 preparation.json"；栅格"按步推进、KRA/PNG 交付校验、review/返修、完成标记、上游缺失阻塞"；初始分组"空树派发、非法名称拒绝、写 groups.json"。
- 图片后端测试：local 放大尺寸正确；api 分别命中 `generations` 与 `edits`（校验 multipart 的 `image[]`）；codex 不可用与 local 不支持生图都给出明确提示。
- 管线测试数据写入 `.run/`，图片测试使用系统临时目录，结束即清理，不触碰工作区已有产物。

