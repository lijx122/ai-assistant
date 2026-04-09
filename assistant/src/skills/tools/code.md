---
name: tools/code
description: bash、code_search、code_analyze、claude_code 代码工具完整说明及选择指南
---

# 代码工具

## 工具选择指南
需要搜索/查找代码？
→ code_search（快速，只读，不消耗额外 AI 调用）
需要分析架构/质量？
→ code_analyze（生成分析报告，只读）
需要执行系统命令？
→ bash（直接执行，有 HITL 保护）
需要修改多个文件/复杂编程任务？
→ claude_code（最强，但最慢最贵）

---

## code_search

参数：
- query: string 搜索内容（支持正则）
- file_pattern: string（可选）如 "**/*.ts"
- include_context: boolean（默认 true）包含前后5行

特点：纯 Node.js 实现，不调用 AI，速度快
返回：匹配位置列表 + 代码片段

---

## code_analyze

参数：
- focus: 'architecture'|'dependencies'|'quality'|'security'|'performance'|'specific'
- target: string（可选）具体文件路径
- question: string（focus=specific 时填写）

特点：只读分析，不修改文件，生成结构化报告

---

## bash

参数：
- command: string shell 命令

⚠️ 风险：high（含 rm/sudo/dd 等触发 HITL）

适用：查看系统信息、运行构建命令、git 操作
安全：低权限用户运行，无法操作系统目录

---

## claude_code

参数：
- task: string 详细任务描述（越详细越好）
- allowed_tools: string[]（可选）限制可用工具
- mode: 'auto'|'plan'|'execute'（默认 auto）
- search_only: boolean 只读模式（默认 false）

⚠️ 风险：high，消耗额外 API token

使用规范（重要，参考 claude-code skill）：
1. task 描述必须包含：背景文件路径 + 具体要求 + 验证方式
2. 复杂任务先 mode:'plan' 看计划，确认后再执行
3. 只需搜索时用 search_only:true
