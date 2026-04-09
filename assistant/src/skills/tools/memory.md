---
name: tools/memory
description: recall、read_workspace_memory、read_impression 记忆工具说明
---

# 记忆工具

## recall（语义检索）

用途：从历史对话中检索相关内容（向量相似度）。

参数：
- query: string 检索关键词或问题

适用：「我之前说过什么关于 X 的事」「上次那个 XXX 怎么做的」
返回：最相关的历史消息片段，附相似度分数

---

## read_workspace_memory（工作区记忆）

用途：读取当前工作区的结构化长期记忆。

无参数，直接调用。

包含：项目技术栈、已知约定、重要决策记录、用户偏好
适用：开始新任务前，了解项目背景

---

## read_impression（用户印象）

用途：读取对当前用户的长期印象记录。

无参数，直接调用。

包含：用户习惯、偏好、历史上下文
适用：个性化回复时参考
