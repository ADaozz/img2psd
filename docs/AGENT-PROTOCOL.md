# 执行者协议（任何 agent）

本项目不假设执行者会调用模型 API、也不要求 MCP 或特定 SDK。只要能做到三件事，就能接手任意 job：

1. 能执行 shell 命令；
2. 能读写文件；
3. 能查看图片（用于自检）。

## 循环

```bash
node src/cli/main.ts next --run <part-layering 目录>        # 1. 领取 job（可 --json）
cat <job>/INSTRUCTIONS.md                                    # 2. 读正文、本次输入与操作约定
#    … 按正文把 SVG 写到 <job>/out/draft.svg …
node src/cli/main.ts preview --job <job> --mode blend        # 3. 自检（必须至少一次 blend）
node src/cli/main.ts submit  --job <job>                     # 4. 提交，程序校验后发布
```

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

缺 `references/base-subject.png` 时 `l2d next` 先派发 preparation job：

```bash
# 1) 看原图与画风参考，决定是否需要简化
# 2a) 需要简化：
node src/cli/main.ts imagegen --prompt-file prompts/2-简化图片.md \
  --ref <run>/input/original.png --ref resources/简化参考图片.png \
  --out <run>/references/simplified-subject.png --matte --size <WxH>
# 2b) 不需要：直接复制原图
# 3) 素体换装
node src/cli/main.ts imagegen --prompt-file prompts/3-素体参考.md \
  --ref <run>/references/simplified-subject.png --ref resources/连体服参考.jpg \
  --out <run>/references/base-subject.png --matte --size <WxH>
# 4) 提交
node src/cli/main.ts submit --job <job> --note "是否需要简化及生成情况"
```

程序校验：两张 PNG 尺寸与原图一致、素体参考透明面积 ≥5%、PNG 签名；通过后写 `references/preparation.json`。

## 初始分组

组树为空时 `l2d next` 派发 `grouping`：

```bash
node src/cli/main.ts preview --job <job> --mode view        # 看素体参考
node src/cli/main.ts submit  --job <job> --groups '[{"name":"face","note":"脸型与五官"}]' --subject character
```

只提交一层 `name/note`；程序生成 `id`、写入 `groups.json`，已存在非空组时拒绝。

## 栅格（Krita）步骤

`--run` 指向含 `raster.json` 的目录（模板见 `templates/`）：

```bash
node src/cli/main.ts next --run <task>/raster-layering
cat <job>/INSTRUCTIONS.md          # 本步正文 + 上游产物路径 + 交付清单
#   用 Krita 产出到 <run>/<step>/：KRA / PNG / report.md
node src/cli/main.ts submit --job <job> --note "完成情况、偏差与遗留问题"
node src/cli/main.ts status --run <task>/raster-layering
```

程序校验：交付清单逐项存在且非空、KRA 是 zip、PNG 魔数正确。

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

后端由环境变量选择：`L2D_IMAGE_BACKEND=api|qwen|apiyi|codex`（生图）、`L2D_UPSCALE_BACKEND=local|codex`（放大）。同一次 `imagegen` 也可以用 `--model` 在 qwen-image-3 和 API易之间切换。

- `api`：`L2D_IMAGE_BASE_URL`、`L2D_IMAGE_API_KEY`、可选 `L2D_IMAGE_MODEL`
- `qwen`：`DASHSCOPE_API_KEY`（必填）、`L2D_IMAGE_BASE_URL`（默认千问北京端点）、`L2D_IMAGE_MODEL`（默认 `qwen-image-3.0-pro`，别名 `qwenimage3`）
- `apiyi`：`APIYI_API_KEY`（必填，不可下发到浏览器）、可选 `APIYI_BASE_URL`（默认 `https://api.apiyi.com`）、`APIYI_TIMEOUT_MS`（默认 300000）
- 这些变量可写在项目根目录 `.env`（自动加载，已 gitignore）；命令行同名变量优先
- API易模型与任务：`--task standardize` → `gemini-nano-banana-2.1`；`--task body_reference` → `gpt-image-2.5-sunburst`；`--task fast_comparison` → `gpt-image-2.5-flare`。这三条都是图生图，必须有 `--ref`。默认严格保持原图画布；比例接近但像素不同、且允许补边时加 `--loose`
- 有白底但要求透明时加 `--matte`：`l2d imagegen ... --matte`，或单独 `l2d matte --in a.png --out b.png`

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
