# live2d-portable

`live2d-maker` 的可移植复刻版：**除「图片生成 / 图片放大」外，任何 agent 都能执行全部步骤。**

上游快照见 [`vendor/live2d-maker`](vendor/live2d-maker)（AstraLayering `71140f3`，116 个 TS 文件 / 12519 行 / 70 份提示词 / 17 个工具）。本目录只保留源码，不含 `node_modules` 与运行数据。

## 目标

1. **零 Codex 依赖的管线核心**：编排、分组事实、SVG 校验、父范围、补全合成、整树合并、失效与恢复全部是纯程序。
2. **agent 无关的执行边界**：绘制/review/去重/补全/拆分/遮挡规划都由外部 agent 完成，agent 只需要三样能力——能执行 shell 命令、能读写文件、能看图。
3. **Codex 只保留两个能力**：`imagegen`（生图）与 `upscale`（放大），且都是可插拔后端——`local` / `api` / `codex` 任选。
4. **校验不放松**：可编辑矢量、画布一致、`data-group-path` 绑定、父范围四倍采样、补全保留原形、哈希事实与逐件失效全部沿用上游规则。

## 非目标

- 不追求与上游 API 兼容（`CodexAgents` / `AgentSession` / App Server 协议全部去掉）。
- 不重写提示词正文与工具语义（70 份 prompts、17 个工具 schema 直接复用，转成 job 约束）。
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
    agents/                image（选后端）/ local / api / codex；只有 codex.ts 调用 Codex CLI
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
| **`l2d imagegen / upscale`（可插拔后端）** | ✅ | `local`（Lanczos 放大）、`api`（Images API）、`qwen`（千问多模态，多图入参）、`apiyi`（API易图片编辑，与 qwen-image-3 按模型分流）、`codex`（CLI）；只有 `codex.ts` 调用 Codex |
| **`l2d matte`（确定性去背）** | ✅ | 四边灌水去连通纯色背景，保留内部同色区域（白色服装不会被误删），1–2px 软边 |
| **raster / clothing-raster（Krita 位图）** | ✅ | `raster.json` 驱动步骤；绘制与 review/返修是独立 job；交付校验后写 `.drawn` / `.completed` |
| **初始分组 job** | ✅ | 组树为空时派发；只收 `name/note`，程序生成 id 并写 `groups.json` |

参考准备与栅格都已用真实产物跑过：素体换装走 `qwen` 后端（26 秒，1024×1536，去背后透明 77.5%），随后 `next` 自动进入初始分组；栅格用现有 28 个 part 作为上游，`next` 直接派发 `step01`。

## 已知限制

- **没有 web 工作台与调度器**：只有 `l2d` CLI，进度靠 `l2d status`，恢复靠再跑一次 `next`。
- **遮挡层级只支持单深度 `level`**：v3 的 `levels: [{level, region}]` 多深度区域还没实现。
- **`matte` 只适合纯色背景**：渐变、场景背景需要换方案（分割/抠图模型）。
- **raster 未在本机跑真实 Krita 端到端**：流程与交付校验有测试覆盖，但真正的分层/补全质量取决于执行该步骤的 agent 与 Krita 环境。
- **图片生成依赖外部服务**：`qwen` 需要 `DASHSCOPE_API_KEY`，`apiyi` 需要 `APIYI_API_KEY`，`api` 需要兼容 Images API 的网关，`codex` 需要 Codex CLI；只有放大默认走本地。

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
L2D_IMAGE_BACKEND=qwen            # qwen | apiyi | api | codex
DASHSCOPE_API_KEY=...             # qwen 后端必填
L2D_IMAGE_BASE_URL=...            # qwen 默认北京端点
L2D_IMAGE_MODEL=qwen-image-3.0-pro
APIYI_API_KEY=...                 # apiyi 后端必填，只留在服务端 .env
L2D_UPSCALE_BACKEND=local         # local | codex
```

`l2d imagegen` 同时接受千问和 API易：`--model qwenimage3`（即 `qwen-image-3.0-pro`），或 `--task standardize|body_reference|fast_comparison`（分别对应 `gemini-nano-banana-2.1`、`gpt-image-2.5-sunburst`、`gpt-image-2.5-flare`）。API易只做图生图，至少要一张 `--ref`。

生图/下载对网络层失败会重试 3 次（代理环境下的长请求偶发被重置）。

## 回归证据

```bash
node --test src/core/core.test.ts src/core/jobs.test.ts   # 6 项
./node_modules/.bin/tsc -p tsconfig.json                  # 无错误
node src/cli/main.ts status   --run ../.run/my-character/part-layering   # 只读核对现有产物
node src/cli/main.ts validate --run ../.run/my-character/part-layering   # 136 个文件全过
```

- `validate`：136 个真实文件（54 轮廓 + 54 去重 + 28 补全）全部通过，约 17 秒。
- `merge --depth 1`：21 个终止叶子合并成功；渲染结果与上游 `mergePartSvgs` 输出**像素级一致**。
- 全量 **22 项**测试（job 闭环 17 + 图片后端 4 + 去背 1）：轮廓 `next → 绘制 → review(revise) → 返修 → review(pass)`；补全"只收新增路径 + 原形保留 + 草稿篡改拒绝"；整层去重"变更组与复制组 + 批次记录"；直属拆分"程序生成 ID + 拒绝单 part 包装 + 子组进入下一层"；遮挡层级"覆盖/唯一 level/候选叠放/漏检拒绝 + v3 落盘"；参考准备"缺图时先派发、尺寸/透明校验、写 preparation.json"；栅格"按步推进、KRA/PNG 交付校验、review/返修、完成标记、上游缺失阻塞"；初始分组"空树派发、非法名称拒绝、写 groups.json"。
- 图片后端测试：local 放大尺寸正确；api 分别命中 `generations` 与 `edits`（校验 multipart 的 `image[]`）；codex 不可用与 local 不支持生图都给出明确提示。
- 去背测试：白底 + 环内白色孤岛，背景透明、孤岛保留、边缘有半透明像素。
- 真实联调：`qwen` 后端用素体换装提示词 + 两张参考图生成 1024×1536 PNG；模型只返回白底 RGB，`l2d matte` 后透明背景 77%、软边 1.3%。
- 测试产生的运行数据都在本包 `.run/` 内，结束即清理，不触碰工作区已有产物。

