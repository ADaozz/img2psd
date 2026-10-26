# 执行者协议（任何 agent）

本项目不假设执行者会调用模型 API、也不要求 MCP 或特定 SDK。只要能做到三件事，就能接手任意 job：

1. 能执行 shell 命令；
2. 能读写文件；
3. 能查看图片（用于自检）。

## 启动与职责

以下相对路径示例从项目根目录执行，尖括号内容须替换为实际路径。`l2d` 只是接口简称，无需安装同名全局命令；生成的任务包使用带引号的绝对路径命令，可从任意目录执行。

外部 agent 负责实际执行循环、查看图片、调用图片 CLI、绘制 SVG 和操作 Krita。程序只做 next 派发、preview 渲染、submit 校验/发布，不自动绘图、不自动开始下一步。图片 CLI 内部负责模型请求与 Nano 双背景恢复，agent 不手动拆这两次请求。

新 part 任务先在新的运行目录放置 `input/original.png` 和空的 `groups.json`：`{"version":1,"groups":[]}`。已有任务直接 next 续跑，不重建或覆盖组树。参考准备通过后，空组树会派发 grouping。

## 循环

```bash
node src/cli/main.ts next --run <part-layering 目录>        # 1. 领取 job（可 --json）
cat <job>/INSTRUCTIONS.md                                    # 2. 读正文、本次输入与操作约定
#    … 按正文把 SVG 写到 <job>/out/draft.svg …
node src/cli/main.ts preview --job <job> --mode svg          # 3. 生成并实际打开独显
node src/cli/main.ts preview --job <job> --mode blend        #    打开叠加图，按需 edge/crop
node src/cli/main.ts submit  --job <job>                     # 4. 提交，程序校验后发布
```

上面是 SVG 绘制 job 的流程骨架，其他种类按本次 INSTRUCTIONS.md 操作。preview 只生成 PNG 并登记当前文件哈希，执行者仍须实际打开图片检查；改稿后重新预览。完成后主动再次 next，保留启动时的 `--expand`（需要直属拆分时）和 `--review-rounds` 参数。

| job | 执行者交付 | 最终提交 |
|---|---|---|
| preparation | 需要时简化，再生成素体 PNG | `submit --note ...` |
| grouping | 当前一层的 name/note 数组 | `submit --groups @file --subject character或other` |
| outline / repair | job/out/draft.svg | 预览后 `submit` |
| review / raster-review | 逐项核对反馈，不改候选 | `submit --verdict ... --feedback ...` |
| reduction | 实际改动的各组 SVG | 先逐组 `--group --svg`，最后 `--note` |
| completion | 新增闭合 paths 数组，或 [] | `--paths @file` 后重看 svg/blend，再 `--note` |
| children | 当前直属 name/kind/note 数组，或 [] | `--children @file --note ...` |
| occlusion | 全部 part 的单 level 提案与逐件 checks | `--levels @file` 后看候选，再 `--checks @file --note ...` |
| raster | 本步指定 KRA/PNG/report.md | `submit --note ...` |

JSON 文件由执行者写在当前 job/out 中。表中的示意字段按当前素材填写；中间的 --paths、--levels、--group 不表示任务已完成。任务正文里的“只返回 JSON/结束”仅指当前判断或绘制环节，不能替代 CLI 最终提交。

有报错先按原因修正当前 job，不能跳过校验或编辑观测/标记。next 没有 job 时检查 blocked 和 status；有阻塞或任何无法核对的结果就停止并报告。当前 blocked 审查结论会被程序计入该轮结束，执行者不能把它当作质量通过继续推进。完成 part 阶段也不等于已完成 Krita 位图交付。

review 类 job 不做修改，只给结论：

```bash
node src/cli/main.ts preview --job <job> --mode blend        # 看候选与参考
node src/cli/main.ts submit  --job <job> --verdict pass|revise|blocked --feedback "具体意见"
```

遮挡补全类 job 只提供新增闭合路径，原形由程序保留：

```bash
node src/cli/main.ts submit --job <job> --paths '[{"d":"M 0 0 C ... Z","fillRule":"nonzero"}]'
node src/cli/main.ts preview --job <job> --mode svg          # 独显
node src/cli/main.ts preview --job <job> --mode blend        # 与参考叠加
node src/cli/main.ts submit --job <job> --note "补全依据"
```

每次 `--paths` 都会从只读底稿重建草稿并清空旧观测，因此改过路径后必须重新预览。

整层去重类 job 按层派发，只提交实际改动的组：

```bash
node src/cli/main.ts preview --job <job> --svg <job>/inputs/merged.svg --mode blend   # 看整层合成
node src/cli/main.ts submit  --job <job> --group face --svg <job>/out/face.svg       # 单组改写
node src/cli/main.ts submit  --job <job> --note "去重依据"                            # 整层结论
```

直属拆分类 job（`l2d next --expand`）只提交名字与职责，程序生成完整 ID：

```bash
node src/cli/main.ts preview --job <job> --mode blend
node src/cli/main.ts submit  --job <job> \
  --children '[{"name":"eye_left","kind":"group","note":"左右眼独立控制"}]' --note "拆分依据"
```

提交空数组表示当前节点终止；单个 part 包装会被拒绝。

遮挡层级规划（全树完成后自动派发，`preview.svg` 由程序合并）：

```bash
node src/cli/main.ts preview --job <job> --svg <run>/preview.svg --mode blend      # 先看整树
node src/cli/main.ts submit  --job <job> --levels '[{"id":"hair","level":1,"note":"后发最靠后"}]'
node src/cli/main.ts preview --job <job> --svg <run>/stages/occlusion/candidate.svg --mode blend
node src/cli/main.ts submit  --job <job> --checks '{"hair":"贴边正确"}' --note "逐件核对"
```

`--levels` 必须覆盖全部终止 part、level 唯一且为非负整数；`--checks` 必须逐件给出依据，否则拒绝发布。

## 规则

- **只写草稿**：`submit` 之外的任何写入都不会被当作事实；正式 SVG 由程序发布。
- **观测由程序登记**：`preview --job` 会写 `observations.json`，`submit` 会核对；agent 无法口头声明「我看过了」。
- **失败可重试**：校验不通过时 `submit` 返回具体原因，job 保持 pending，改完再提交即可。
- **无状态**：job 自带参考、候选、返修意见与完整正文；换一个 agent、换一台机器、断电重来都能接手。
- **不要改**：`groups.json`、`stages/`、`parts/` 下的正式文件，以及 `job.json` 的字段。

## 参考准备（新任务的第一步）

素体不包含任何穿戴配饰；头饰、发饰、耳饰及身体首饰、挂件、装饰飘带等统一归衣物绘制管线。素体分组、拆分、绘制和审查均不得补回配饰；移除后补全皮肤与头发，天然身体结构保留。简化穿衣参考仍保留原有衣物与配饰，用于后续衣物绘制核对。

缺 `references/base-subject.png` 时 `l2d next` 先派发 preparation job：

```bash
# 1) 看原图与画风参考，决定是否需要简化
# 2a) 需要简化：
node src/cli/main.ts imagegen --task standardize --background transparent --prompt-file prompts/2-简化图片.md \
  --ref <run>/input/original.png --ref resources/简化参考图片.png \
  --out <run>/references/simplified-subject.png --size <WxH>
# 2b) 不需要：直接复制原图
# 3) 素体换装
node src/cli/main.ts imagegen --task body_reference --background transparent --prompt-file prompts/3-素体参考.md \
  --ref <run>/references/simplified-subject.png --ref resources/连体服参考.jpg \
  --out <run>/references/base-subject.png --size <WxH>
# 4) 提交
node src/cli/main.ts submit --job <job> --note "是否需要简化及生成情况"
```

简化判断由执行者看图完成；判断 JSON 及理由写入提交 note，不在判断后结束 job。不需要简化时原样复制，允许复制图保留原有背景。每次生图先用同样参数加 `--dry-run` 核对，再去掉该参数调用；成功后实际查看最终 PNG 与原图是否保持角色和姿态。

失败先读 stderr 指向的 `<输出>.transparency-*/error.json` 和原图/第二张图/恢复报告。诊断图不是交付，不靠改尺寸、补透明边框或单背景去背凑校验。无明确参数修正办法时停止并报告，不能反复付费重试；尺寸不支持时不擅自加 --loose。

程序校验：两张 PNG 尺寸与原图一致、素体参考透明面积 ≥5%、PNG 签名；通过后写 `references/preparation.json`。

## 初始分组

组树为空时 `l2d next` 派发 `grouping`：

```bash
node src/cli/main.ts preview --job <job> --mode view        # 看素体参考
node src/cli/main.ts submit  --job <job> --groups '[{"name":"face","note":"脸型与五官"}]' --subject character
```

只提交一层 `name/note`；程序生成 `id`、写入 `groups.json`，已存在非空组时拒绝。

## 栅格（Krita）步骤

`--run` 指向含 `raster.json` 的目录（模板见 `templates/`）。完整任务需要进入栅格阶段时，由执行者在新的 `raster-layering` 或 `clothing-raster-layering` 目录复制对应模板为 raster.json，并核对 upstream 指向已完成的 part 管线；没有自动切换阶段的调度器。已有目录使用现有配置续跑。

配置的 inputs 相对于 raster 运行目录；正文中的上游路径按任务包给出的绝对路径映射。程序不会生成 RGB 控制图、逐部件生图或拼装 KRA，这些都由执行者完成。透明部件输出加 --background transparent；RGB 控制图保持不透明。

```bash
node src/cli/main.ts next --run <task>/raster-layering
cat <job>/INSTRUCTIONS.md          # 本步正文 + 上游产物路径 + 交付清单
#   用 Krita 产出到 <run>/<step>/：KRA / PNG / report.md
node src/cli/main.ts submit --job <job> --note "完成情况、偏差与遗留问题"
node src/cli/main.ts status --run <task>/raster-layering
```

程序校验：交付清单逐项存在且非空、KRA 是 zip、PNG 魔数正确。执行者还必须在 Krita 中实际打开 KRA 查看层结构；PNG 预览不能替代这项检查。没有 Krita 操作能力时报告阻塞，不伪造 KRA。

上游 occlusion.json 保持只读；本仓库没有多深度修改工具。每个 part 的当前提案仅支持一个 level，多深度区域与实际 KRA 层的对应关系写入本步 report.md，不能声称已回写上游。

带 review 的步骤分两段：绘制提交写 `.drawn`；随后派发 `raster-review`：

```bash
node src/cli/main.ts preview --job <review job> --mode blend
node src/cli/main.ts submit  --job <review job> --verdict pass|revise|blocked --feedback "..."
```

`revise` 会派发返修 job（同一交付清单，附 review 意见）；`pass` 才写 `.completed`，轮数用完按 `repaired` 定稿。
下一步骤的 `inputs` 未就绪时只报阻塞，不提前派发。

## 图片生成与放大（可选）

```bash
node src/cli/main.ts upscale  --in <png> --out <png> [--scale 2..8]     # 默认 local，不联网
node src/cli/main.ts imagegen --prompt "..." --out <png> [--ref <png> ...]
```

后端由环境变量选择：`L2D_IMAGE_BACKEND=api|apiyi|codex`（生图）、`L2D_UPSCALE_BACKEND=local|codex`（放大）。API易模型通过 `--model` 或 `--task` 选择。

- `api`：`L2D_IMAGE_BASE_URL`、`L2D_IMAGE_API_KEY`、可选 `L2D_IMAGE_MODEL`
- `apiyi`：`APIYI_API_KEY`（必填，不可下发到浏览器）、可选 `APIYI_BASE_URL`（默认 `https://api.apiyi.com`）、`APIYI_TIMEOUT_MS`（默认 300000）
- 这些变量可写在项目根目录 `.env`（自动加载，已 gitignore）；命令行同名变量优先
- API易模型与任务：`--task standardize` → `gemini-nano-banana-2.1`；`--task body_reference` → `gpt-image-2.5-sunburst`；`--task fast_comparison` → `gpt-image-2.5-flare`。这三条都是图生图，必须有 `--ref`。默认严格保持原图画布；比例接近但像素不同、且允许补边时加 `--loose`
- 简化与素体都加 `--background transparent`，必须交付带真实 Alpha 的透明 PNG。GPT 请求原生透明并校验返回像素；Nano Banana 使用工具层双背景恢复（最多两次生图，网络重试另计），原生 Alpha 优先。禁止单背景色键去背或 rematte。每次透明请求在输出旁保留独立诊断目录，失败不覆盖交付文件。

## 目录

```
<run>/part-layering/
  groups.json                  组树（程序维护）
  references/base-subject.png  素体参考
  stages/outline/<id>.svg      正式轮廓（submit 发布）
  stages/review/<id>.review.json  审查记录（轮数、结论、候选哈希）
  jobs/<kind>-<slug>/          job 目录
    job.json                   机器可读
    INSTRUCTIONS.md            人类/agent 可读
    out/draft.svg              你的草稿
    observations.json          程序登记的观测
    result.json                提交后的事实
```
