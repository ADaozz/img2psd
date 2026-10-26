# Agent 审核闭环

所有读图、视觉比较、语义判断和审核都由现有具备识图能力的 Agent 完成。用户当前使用 DeepSeek Flash；GPT Image 2.5 Sunburst/Flare 只用于生图/改图。仓库不接 LangChain、不单独连接视觉审核模型，不需要审核模型 API 配置。

## 工作流程

绘制 Agent 写 SVG → 程序结构校验 → 独立 Agent 会话读图审核 → Agent 写证据与问题反馈 → 程序校验并发布结论 → 原绘制任务返修 → 独立 Agent 再审。

程序负责派发 job、生成预览、校验哈希/证据/结构并维护事实，不替 Agent 读图。审核者只读候选、写当前 job/out 中的报告，不直接修图；允许绘制和审核会话使用同一种模型。宿主负责会话隔离，绘制者自检不能冒充独立审核。证据 JSON 由 Agent 填写，用户不用手写。

## 审核门槛

- 默认三次审核、两次返修，可配置 1..3 次。最后一次 revise 直接 exhausted，不再派发没有验收机会的返修。
- 只有 pass 放行。blocked 不消耗质量轮次，排障后显式 reopen；exhausted 需要人工明确授权 retry 开新周期，所有旧记录保留。
- 未完成返修、blocked/exhausted、重复提交已通过版本均不能启动新质量结论。候选或参考变化后旧 pass 失效。
- SVG 轮廓和补全均须实际打开整图及全部局部视图，pass 要有六项检查、逐区证据和对应当前哈希的完整预览。补全额外核对原形保留、隐藏结构连续性和活动余量。
- 证据文件完整不证明 Agent 真正看过图。没有视觉通道或工具不能正确传图时必须 blocked，不能用颜色、掩膜或 IoU 代替。
- 栅格只在 pass 写 `.completed`，旧 repaired 不是质量通过。程序核对 KRA/PNG/报告及参考哈希；Agent 还须实际用 Krita 检查层结构。
- `submit --report @out/agent-review.json` 可提交结构化 Agent 报告，校验任务/候选/参考、缺陷类别/坐标/严重度；存在未解决严重缺陷不能 pass，Agent 不能自行接受差异。pass 的 --checks 仍必需。

## 恢复与交接

```bash
node src/cli/main.ts review history --job <当前review-job>
node src/cli/main.ts review reopen --job <当前review-job> --reason '排障依据'
# 只在人工明确授权后执行，不能自行增加周期：
node src/cli/main.ts review retry --job <当前review-job> --reason '人工授权原因'
node src/cli/main.ts handoff --job <当前job>
```

handoff 仅保存文件路径、版本哈希与恢复步骤到 job/out/handoff.json，不发送图片或模型请求，不携带聊天历史，不修改审核事实或预算。Agent 先把检查范围和缺陷写进 out/progress.md；新会话读交接文件和任务包，重新打开当前判断需要的图片，再 submit/next。

正式报告仍在 stages/review、stages/completion-review 或栅格步骤 review.json；报告旁 `.history/<attempt-id>/` 保留候选、参考和结论快照。返修历史保存修改前后哈希与说明。结构化报告是程序状态数据，Markdown 进度用于交接，不替代 pass 证据。

## 验收边界

本地测试验证状态门槛、证据绑定、Agent 提交、栅格错误放行防护及断点交接，不证明真实视觉质量。仍需在实际宿主中验证独立会话的读图、发现缺陷、返修和再审。

历史上尝试过可选独立视觉 API 客户端；现已按用户要求移除。此前 Sunburst 聊天请求返回 503 仅是该次探测结果，不影响现有 Agent 审核，也不能据此断定 Images API 故障。

上游依赖的最小范围重跑、回退派发、人工接受差异的专门记录和全角色/Krita 实机质量回归仍待验收；本轮不改绘制算法、多层 schema 或衣物专用模板。上下文根因、附件证据范围和宿主归因要求见 [Agent 图片上下文](AGENT-IMAGE-CONTEXT.md)。
