# 分组特化提示词

来源：AstraLayering `1cfcb924a3b5f590d06b2b71a377130da8e55218` 的 part-layering/prompts/groups；接入本项目 CLI 后保持“素体不含配饰”的本地规则。参考板来源说明仍保留在各 references/README.md。

每个完整 group/part ID 独立匹配 outline.md、review.md、completion.md、children.md；存在特化正文时替换该阶段通用正文，不继承祖先。没有对应文件则使用通用提示。任务包同时列出实际选中的提示词绝对路径、当前职责、画布、父 SVG 与参考图。

各阶段的 *.references.json 只对该完整 ID 生效。path 相对清单目录解析，任务包提供可查看的图片绝对路径和用途；文件缺失或无法解码时报错，不假装参考已提供。图片只作结构先验，不照搬第三方角色的形状、坐标、画风或拆分数量。

completion 的 sibling 声明引用当前父节点下同级的已去重底稿。程序从 stages/outline-reduce/<同级完整ID>.svg 生成保留原画布坐标的参考 PNG，列出只读源 SVG 路径；不使用同级正在修改的补全稿。手指的掌指连接参考包含同手实际 palm 与完整指体参考板。

任务包通过文件路径提供这些参考，执行者实际打开文件查看；不调用上游专用工具。提示词修改不会追溯重绘已有产物，重新执行相应步骤后才生效。
