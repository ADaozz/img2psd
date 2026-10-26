# Agent 执行入口

先读 `docs/AGENT-PROTOCOL.md`。使用 Node.js >=22.18，在项目目录安装 package.json 的依赖；已有依赖时直接执行。命令入口是 `node src/cli/main.ts`，没有全局 `l2d` 也能工作。

没有视觉通道或环境禁止图片读入上下文时，必须报告 blocked；颜色分类、掩膜、IoU 和格式校验不能代替视觉 review，也不能据此提交 pass。

## 工作循环

1. 由执行者调用 `node src/cli/main.ts next --run <运行目录> --json`，逐个读取返回的 `instructions` 路径。需要直属拆分时使用 `--expand`；后续 next 保留最初的 `--expand` 和 `--review-rounds` 设置。
2. 按当前 job 的 `INSTRUCTIONS.md` 主动读图、判断、写草稿或操作 Krita。程序不会替你绘制、生图、拼装 KRA，也不会自动调度下一步。任务包已给出带实际绝对路径的 CLI 命令；逐步执行并检查输出，不把所有分支整段粘贴执行。
3. 实际打开 preview 生成的图片；修改草稿后重新 preview。通过 submit 提交路径、名字、草稿或结论。仅最终提交成功后继续 next，中间的 --paths、--levels、--group 不是本 job 完成。
4. 无待办时检查 blocked 和 status；有阻塞、没有所需能力、缺密钥或无法核对时停止并报告具体路径及原因。SVG 及栅格审批遇到 blocked 或 exhausted 会阻塞，不能以已返修作为通过。SVG review 与 completion-review 的 pass 都须按任务包提交 --checks 证据，补全审查通过后才能继续拆层。区分 part 阶段完成与整个 Krita 交付完成。

默认三审两修，最后一次 revise 直接 exhausted；blocked 不计质量轮数。默认由现有具备识图能力的 Agent（用户当前使用 DeepSeek Flash）在独立审核会话中看图并提交证据，无需另配 L2D_REVIEW_MODEL，JSON 由 Agent 填写。GPT Image 2.5 负责生图/改图。审核者只读候选，不能由绘制者在原会话自审代替。`review run` 是显式选择、另配模型的可选 API 审核入口。故障排除后 `review reopen --reason ...`；开启新周期的 `review retry` 必须有人工明确授权，agent 不得自己编造授权或自动扩大预算。用 `review history` 查看现场。独立审核配置与实机验收限制见 `docs/REVIEW-WORKFLOW.md`。

## 约定

- 素体不包含任何穿戴配饰；头饰、发饰、耳饰及身体首饰、挂件、装饰飘带等统一归衣物绘制管线。素体分组、拆分、绘制和审查均不得补回配饰；移除后补全皮肤与头发，天然身体结构保留。简化穿衣参考仍保留原有衣物与配饰，用于后续衣物绘制核对。

- 新建任务的最小输入是 `input/original.png` 和 `groups.json`（空树为 `{"version":1,"groups":[]}`）。仅初始化新的运行目录，续跑不得覆盖已有组树。栅格任务需要模板对应的 `raster.json` 及已完成的上游 parts/occlusion。
- 简化/素体用 `imagegen --task standardize|body_reference --background transparent`，补齐 prompt/ref/out，先 dry-run 再真实调用。第一张 ref 是编辑对象，其余为风格或控制参考。
- GPT 请求原生 Alpha；Nano 的双背景恢复由工具内部完成。不要手动二次请求，不做单背景色键去背或 rematte。失败查看 stderr 指向的诊断目录；没有明确修正办法时不反复付费重试。
- `groups.json`、上游 occlusion、正式 SVG、job.json、观测和完成标记由程序维护。只写当前 job/out 和明确指定的参考/栅格交付目录。不要调用上游才有的工具或另起嵌套 Codex。
- 当前 CLI 的 occlusion 每个 part 仅支持一个 level；实际多深度需求写入 note/report.md 并报告限制，不能声称已回写多深度 schema。
- KRA 检查须实际使用 Krita；文件格式校验与 PNG 预览不能证明层结构正确。没有该能力时报告阻塞，不能伪造产物。

修改代码后运行 `npm run check` 和与改动相关的测试；发布前运行 `npm test`。
