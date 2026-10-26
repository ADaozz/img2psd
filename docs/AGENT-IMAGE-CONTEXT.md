# Agent 图片上下文与溢出排查

所有图片阅读、比较、语义判断及审核由现有 Agent 完成。本仓库只生成 PNG 预览、提供任务包、校验证据和保存状态，不接 LangChain、不包装宿主模型客户端、不单独调用视觉审核 API。GPT Image 2.5 的 API 只用于生成或编辑图片。

## 已确认的用户侧诊断

用户实测：宿主 `ChatDeepSeek._get_request_payload` 会把 tool 消息内的图片 list 通过 `json.dumps` 变成字符串。Base64 因此以普通文本进入请求，而不是多模态图片块；`chars/4` 只能用作这种文本的粗略 token 估算，不是图片视觉 token 的计算方式。

一条约 80KB 的 thumb 工具结果可形成约十万字符、约 2.7 万个估算文本 token。用户报告在当时会话中约 24 次 read_file 后总输入接近 110 万；这包含原有会话和其他工具内容，不能直接把 24×单图估算当作完整请求归因。根因应表述为图片工具结果被当作文本及历史累积，不能仅归为分辨率过大。

磁盘 observations 没有重复 path，只说明该文件列表没有路径重复。宿主若反复携带历史 tool 图片，仍会重复占用上下文；缩略图减少字节量不能修复传输类型错误。

出错请求当时没有保存逐条消息归因，无法事后准确拆分各消息占比。不能据 PNG 文件大小、路径去重或当前历史猜出当时的精确账单。

## 当前附件的证据范围

`img2psd-overflow-bundle.tar.gz` 只有日志与 PNG。日志确认 `ContextOverflowError: Model input still does not fit after recovery`，并保留了准备/分组视图与缩略图。包中不含 `run_deepagent_pipeline.py`、`last-request-attribution.json` 或 `overflow-diagnostics.json`，本仓库未改写或验证用户本机 runner 的补丁。

用户说明其宿主已把 tool JSON 改为短 stub、图片移到下一条 user 多模态消息，并在每次请求写 `.run/logs/last-request-attribution.json`；本仓库把它作为宿主修复信息记录，不声称已复现实机结果。

## Agent 执行要求

1. 使用宿主原生图片工具查看图片，确认工具实际交付图片块；不能将 Base64/图片 JSON 打印成普通文本或让 Agent“阅读”编码。
2. 当前批次只打开本轮需要的整图或局部视图，及时在 job/out/progress.md 写候选/参考哈希、检查区域、缺陷坐标及依据。不得为了省上下文跳过 review-plan 的必查区域。
3. 同一候选版本避免重复打开未变的图；候选或参考变化后，旧视觉结论失效。进度摘要用于交接，不能替代新候选的实际读图。
4. 上下文不足时保存草稿和进度，执行 `handoff --job <目录>`。由宿主开启新 Agent 会话，只读取当前 job 的任务包、交接清单、必要上游文件和审查反馈，不重放整段历史图片。
5. 新会话仍须通过原 submit 校验；交接不意味着通过，不重置质量审核轮数，也不将 blocked 改成 pass。审核 job 因宿主故障无法读图时，提交带具体原因的 blocked；排障后显式 reopen。

## 宿主归因日志应说明的事实

这部分由既有 Agent 宿主负责，不在本仓库引入模型 SDK。发送前的最终 payload 统计应区分每条消息的 role、tool_call_id、普通文本字符数/估算 token、原生图片块数量及实际图片字节数；同时记录工具 schema 和预留输出预算。记录 Base64 的长度/哈希即可，不保存编码正文、认证头或密钥。

应把同图多次出现与磁盘路径重复分开统计，明确 `chars/4` 是文本启发式估算；原生图片成本不能按 Base64 长度算。日志应在失败请求之前落盘，区分预检、已发送及服务端实际 usage，不能把预估值当成计费 token。

在缺少逐条归因时，overflow implication 应写“图片工具结果文本化及会话历史累积需要排查；无法还原该次消息占比”，不能改写成“缩略图分辨率本身导致溢出”。反复发送完全相同的超限请求不是有效恢复；先保存当前 job 并重建有界上下文。
