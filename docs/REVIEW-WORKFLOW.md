# 审核闭环实现与验收记录

默认复用现有 Agent 的视觉能力：用户当前使用 DeepSeek Flash，宿主把审核任务包交给独立会话，Agent 看图后填写证据并 submit；GPT Image 2.5 负责生图/改图。无需额外审核模型 API，用户不用手工写 JSON。程序不自动创建宿主会话。另提供可选的 API 自动审查入口。没有将接口模拟测试视为真实模型质量验收；M2/M3 的实机验收尚未完成。

## 已落地

- SVG 轮廓、补全、栅格共同采用三次质量审核、两次返修的默认预算，可配置 1..3 次。最后一次 revise 直接 exhausted；返修后必须由下一轮明确 pass 放行。
- blocked 不消耗质量轮次，可在没有预览或候选丢失时记录具体故障。临时故障只能 reopen 恢复；exhausted 开新周期必须由人工明确授权 retry，事件、原因、旧结论和计数保留。
- 未完成返修、blocked、exhausted 不能提交新质量结论。重复提交已通过版本被拒绝。候选或参考变化后旧 pass 失效，剩余预算用尽时仍须人工处理。
- 栅格仅 pass 写 `.completed`，不再写 repaired 或把 blocked 当完成。计划器对历史标记重新核对审核事实及全部交付文件哈希，包括 KRA 和报告，不能凭旧标记放行。
- 独立 APIYi Chat Completions 客户端发送实际 PNG 多图输入，解析文本 JSON 并严格校验候选/参考/任务/attempt/model、六项证据、缺陷类别、严重程度和原图坐标。未解决严重问题不能 pass；模型不能自行 accepted；上游缺陷必须 blocked。
- HTTP 408/429/5xx、网络超时、输出截断或 JSON/schema 错误最多重试两次；401/不支持等错误直接失败。每次 HTTP 请求保留状态、请求 ID 和用量；不会将错误伪造成画面缺陷。
- `review run` 先整图审核，再合并基础分区、整图缺陷和历史缺陷区域生成 2 倍 blend/edge 放大图，由独立模型复核。两阶段共用一轮质量预算，局部结论须包含历史缺陷 ID 和全部必查区域。
- 审查包记录候选、参考、补全前 SVG、父组、可用同层邻组、group 职责、原图坐标/倍率/尺寸、图片实际字节哈希、专用提示词及历史报告。提交还会重新核对当前文件与证据。
- 正式审核记录保留候选/参考快照、结构化问题报告；返修任务带完整问题清单，记录修改前后哈希和说明。同一 job 的 run 互斥；本机崩溃后无存活 owner 的锁可以恢复，跨机器锁需核对原进程。
- standardize 和 body_reference 默认 Sunburst；fast_comparison 默认 Flare；显式 Nano 仍可用。图片生成请求和响应解析没有改为审核接口。

## 操作

```bash
node src/cli/main.ts review run --job <当前review-job>
node src/cli/main.ts review history --job <当前review-job>
node src/cli/main.ts review reopen --job <当前review-job> --reason '故障已解决的具体依据'
# 以下只能在人工明确授权新周期后执行，agent 不得自行授权：
node src/cli/main.ts review retry --job <当前review-job> --reason '人工授权的新周期原因'
```

`run` 提交审核后，由外部执行者继续 `next → 返修/绘制 → submit → next`。不增加常驻调度器、不自动绘制 SVG、不生成 KRA。手工独立视觉审核接口仍保留。

仅显式选择 `review run` 的 API 模式需要配置，见 `.env.example`：该模式使用 `APIYI_API_KEY` 和独立 `L2D_REVIEW_MODEL`，后者必须是图片理解和文本输出模型。默认 `/v1/chat/completions` 与 `response_format: json_object`；服务不支持该格式参数时，可以显式选择 `L2D_REVIEW_JSON_MODE=prompt`，仍须通过相同本地 JSON 校验。显式调用该可选命令却没有配置时写 blocked 并返回失败；默认 Agent 审核不调用它，不能因未配可选 API 而阻塞。

产物：

- `jobs/<review-id>/attempts/<attempt-id>/packet.json` 及实际图片，原始候选和上下文快照。
- 同目录 `model-result.json` 保存最终建议、整图/局部调用信息与用量。
- `last-review-attempt.json` 保存最近成功或故障信息，包括有界重试记录。
- `stages/review/<id>.review.json`、`stages/completion-review/<id>.review.json` 或栅格步骤 `review.json` 保存程序发布的事实、恢复事件及返修记录。
- 审核事实旁的 `.history/<attempt-id>/` 保存该次候选、参考、报告。

图片数量超过 64 或总图片超过 30 MiB 时明确阻塞，不静默省略选框或证据。

## 2026-10-26 实机探测

用户指定 `gpt-image-2.5-sunburst`。对 APIYi `/v1/chat/completions` 发送一张 16×16 红色 PNG，要求只输出颜色文本 JSON，单次请求返回 HTTP 503、`shell_api_error`、`No available capacity was found for the model`。未获得有效文本审核结果，无法据此确认该模型的多模态文本能力；不宣称 M1 实机冒烟成功。密钥未写入仓库、配置或日志。

用户后续明确现有 DeepSeek Flash Agent 已具备识图能力，因此默认审核直接复用它的独立会话；上述可选 API 探测失败不阻塞默认 Agent 流程。Sunburst 继续用于生图，Images API 返回图片不能解释为审核报告。APIYi 模型注册表同时为 Sunburst 标注 chat/images 端点；支持 chat 格式本身也不能证明其支持通用文本审核。参见 [注册表](https://docs.apiyi.com/model-registry.json)、[识图文档](https://docs.apiyi.com/api-capabilities/vision-understanding) 和 [文本与出图能力说明](https://docs.apiyi.com/faq/text-and-image-in-one-api)。

## 后续关卡与限制

- 自动 SVG 审查、blocked 恢复、revise/repair/pass 的本地接口契约测试已实现；它们验证程序调度和证据校验，不衡量真实视觉漏检率或误报率。
- 默认 Agent 流程仍需实际宿主中独立审核会话的真实 SVG 多图证据；可选 API 模式另需可用模型的接口验收。M2 尚需用户缺陷样本的真实发现/返修/复审。当前未重绘用户原始 run。
- M3 尚需全角色与 Krita 实机回归、依赖树最小范围失效和完整回退派发、逐条返修交付声明/预算及人工接受差异的独立记录机制。当前模型 accepted 一律拒绝，避免没有接受记录就放行。
- 自动 `review run` 不替代 KRA 图层检查。栅格状态门槛已修正，实际视觉与 Krita 检查仍由具备该能力的独立审核者完成，自动调用栅格 review 会 blocked。
- 既有多层 schema 限制、SVG 绘制算法、Krita 编辑方式、衣物专用提示词及模板扩展本轮未改。
- 同一运行目录的控制命令应按协议顺序执行；没有引入支持多控制器并发事务的数据库。Reviewer API 无文件写入权限；宿主 Agent 的目录权限仍依赖执行环境遵守协议。
