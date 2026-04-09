---
name: claude-code
description: claude_code 工具规范——如何构造 task 描述以获得最佳修复效果
when_to_use: 运维告警自动修复、多文件重构、复杂代码分析等需要强 AI 能力介入的场景
allowed_tools: []
---

# Claude Code 工具使用规范

`claude_code` 工具是所有代码工具中**最强**的，但也是**最慢**和**最贵**的。
正确构造 task 描述是获得最佳修复效果的关键。

## 核心原则

1. **task 必须包含**：背景文件路径 + 具体要求 + 验证方式
2. **context 必须包含**：错误日志 + 相关代码片段
3. 复杂任务先用 `mode:'plan'` 看计划，确认后再执行
4. 只需搜索时用 `search_only:true`

## task 构造模板

```
## 背景
{项目/文件路径} 的 {功能模块} 出现问题

## 问题描述
{具体现象：如错误日志、崩溃信息、预期行为 vs 实际行为}

## 已知信息
{相关代码片段、配置文件内容、依赖版本等}

## 要求
{明确告诉 AI 要做什么，而不是让 AI 猜}

## 验证方式
{如何验证修复成功：如"运行 npm test"、"访问 http://localhost:3000/api/health"等}
```

## context 构造模板

```
错误日志：
{完整的错误堆栈或日志输出}

相关代码：
{相关文件的关键代码片段（不要粘贴整个文件）}
```

## 工具约束

- 允许工具：`Bash` · `Read` · `Edit` · `Write`（安全子集）
- 不允许：`claude_code` 自身嵌套调用
- 不允许：`rm -rf` 等危险操作

## 与其他工具的配合

```
复杂重构（多文件、大范围修改）
  → claude_code（最强，适合需要理解架构的任务）

搜索代码（只读）
  → code_search（快，无需 AI）

运行命令验证（构建、测试）
  → bash（直接执行）

简单分析（结构/安全/架构）
  → code_analyze（不修改，只读）
```

## 示例：告警自动修复

```typescript
// 差的 task（AI 无法执行）
task: "修复数据库问题"

// 好的 task（AI 可以直接执行）
task: `
修复数据库连接超时问题。

项目路径：/app
问题现象：每小时出现 1-2 次 "Connection timeout after 30000ms" 错误

相关代码（src/db/pool.ts）：
\`\`\`typescript
const pool = new Pool({
  connectionTimeoutMillis: 30000,
  idleTimeoutMillis: 30000,
  max: 20,
});
\`\`\`

要求：
1. 分析连接池配置是否合理
2. 添加连接健康检查和重试逻辑
3. 保持连接池 max=20 不变

验证方式：
运行 "npm test" 全部通过，并且观察 10 分钟内无超时日志
\`\`\``
```

## 超时与错误处理

- 超时 5 分钟，强制终止
- Claude CLI 未安装时返回错误，提示安装命令
- 退出码非 0 且未超时视为执行失败

## 不要滥用场景

- 简单搜索 → 用 `code_search`
- 简单命令 → 用 `bash`
- 只需分析 → 用 `code_analyze`
- 除非真的需要 AI 理解上下文、多文件协调修改，才用 `claude_code`
