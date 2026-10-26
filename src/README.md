# 源码布局（移植映射）

上游代码在 `vendor/live2d-maker`，只读对照。新实现按职责拆分，**任何模块都不 import Codex**，除了 `src/agents/codex.ts`。

## 计划结构

```
src/
  core/
    svg/       validate.ts   ← shared/part/svg-tools.ts（画布/绑定/无位图/可见性 + 父范围）
               render.ts     ← createSvgPreviewTool 的渲染部分（svg/blend/edge + crop/scale）
               completion.ts ← shared/part/completion-svg.ts
               merge.ts      ← shared/part/merge-svg.ts
               merged-preview.ts ← shared/part/outline-reduce.ts 的整层合成预览
               candidate.ts  ← shared/part/occlusion-plan.ts 的候选叠放预览
    facts/     groups.ts     ← shared/part/groups.ts（树、原子写）
               hash.ts       ← svgHash / matchesHash
               review.ts     ← 新：审查轮数、结论、候选哈希、返修计数
    image/     matte.ts       ← 新：四边灌水去背（保留内部同色区域 + 软边）
    raster/    config.ts      ← 新：raster.json 步骤定义与上游校验
    jobs/      plan.ts       ← 新：按父级屏障决定下一步派发
               materialize.ts← 新：job.json + INSTRUCTIONS.md 物化
               submit.ts     ← 新：校验 + 观测核对 + 发布事实
               observations.ts ← 新：由 CLI 登记的观测证据
  config/      env.ts        ← 新：项目 .env 加载（环境变量优先）
  cli/         main.ts       ← l2d 命令入口
  agents/      image.ts      ← 后端选择与对外签名（imageGenerate / upscale）
               local.ts      ← Lanczos 放大（默认放大后端）
               api.ts        ← 兼容 Images API（generations / edits multipart）
               qwen.ts       ← 千问多模态生图（多图 + 不扩写提示词）
               apiyi.ts      ← API易图片编辑（Nano Banana / GPT-Image-2.5，与 qwen-image-3 分流）
               codex.ts      ← Codex CLI（**唯一调用 Codex 的模块**）
               types.ts      ← PNG 校验与原子落盘
prompts/raster/ 01-分层与补全 / 02-边缘柔化 / 02-review / 02-repair / 03-去除连体服 /
               01-衣服分层与补全 / 02-边缘柔化（衣服）
prompts/       5-组轮廓 / 6-轮廓review / 7-轮廓返修 / 8-同层轮廓去重 /
               9-正面遮挡补全 / 9-补全操作约定 / 10-直属结构拆分 / 10-拆分操作约定 /
               11-遮挡层级规划（来自上游正文）
```

## 删除项（相对上游）

- `shared/codex/{agents,tool-agent,environment,agent-runtime,agent-log,function-tools,tool-config}.ts`
- `shared/part/layering-steps.ts`、`outline-agent.ts`、`outline-reduce.ts`、`completion-agent.ts`、`children-agent.ts`、`occlusion-agent.ts`、`initial-groups.ts` 中一切 agent 调用与会话逻辑（只保留其中被 core 复用的纯函数）
- `part-layering/preparation-agents.ts` 的 prompt 拼装 → 变为 job；生图调用 → `agents/image.ts`

## 保留项

- 70 份提示词正文（`prompts/`）
- 17 个工具 schema 的字段语义（转成 job 约束与 `submit` 参数校验）
- 全部校验算法与事实/失效规则
