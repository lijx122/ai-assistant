---
name: tools-code
description: bash、code_search、code_analyze、claude_code 代码工具完整参数与返回值说明
when_to_use: 需要搜索代码、运行命令、或调用 Claude CLI 执行复杂编程任务时使用
allowed_tools: [bash, code_search, code_analyze, claude_code]
---

# 代码工具

## 工具选择决策树

```
需要处理代码？
  ├─ 搜索工作区代码内容
  │     → code_search（快速，纯 Node.js，无需 AI 调用）
  ├─ 分析代码结构/安全/架构
  │     → code_analyze（只读分析，不修改文件）
  ├─ 执行系统命令
  │     → bash（直接执行，有危险命令检测）
  └─ 复杂编程任务（多文件修改/架构重构）
        → claude_code（最强，但最慢最贵）
```

---

## code_search

### 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| query | string | ✅ | — | 搜索关键词（支持正则表达式） |
| file_pattern | string | ❌ | — | 文件类型过滤（如 `*.ts`、`*.js`） |
| include_context | boolean | ❌ | true | 是否包含上下文行（前后 3 行） |

### 返回值

```typescript
{
  success: true,
  data: {
    result: string,  // Markdown 格式搜索结果
                     // 含文件路径、行号、匹配行（带 → 标记）
  },
  elapsed_ms: number,
}
```

### 示例输出

```
找到 3 处匹配：

📄 src/utils/helper.ts:42
→ 42: const result = await fetchData(query)
    43: function formatOutput(data) { ... }
    44: }

📄 src/api/client.ts:18
...
```

### 注意事项

- 纯 Node.js 实现，不调用 AI，速度快
- 最多返回 50 个匹配结果
- 跳过 `node_modules`、`dist`、`.git` 等目录
- 正则不区分大小写

---

## code_analyze

### 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| focus | string | ✅ | — | 分析重点：`security` \| `architecture` \| `full` |
| target | string | ❌ | — | 分析特定文件或目录路径 |

### 返回值

```typescript
{
  success: true,
  data: {
    result: string,  // Markdown 格式分析报告
                     // 包含目录结构、依赖信息、安全/架构分析
  },
  elapsed_ms: number,
}
```

### focus 说明

- **security**：敏感模式扫描（环境变量、密码关键词、eval、Function 构造）、安全文件内容摘要
- **architecture**：核心文件内容摘要（server.ts、db/migrate.ts、channels/base.ts 等）
- **full**：包含 security + architecture

### 注意事项

- 不调用外部 AI，直接文件系统分析
- 敏感内容（如密钥）被标记但不展示具体值
- 最多读取文件前 3000-5000 字符

---

## bash

### 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| command | string | ✅ | — | 要执行的 shell 命令 |
| cwd | string | ❌ | — | 工作目录（相对工作区 root_path） |

### 返回值

```typescript
// 成功：
{
  success: true,
  data: {
    output: string,      // stdout + stderr（合并，超 8000 字符截断）
    exit_code: number,  // 进程退出码
    truncated: boolean, // 是否截断
  },
  elapsed_ms: number,
}

// 需要确认的危险命令：
{
  success: false,
  requiresConfirmation: true,
  confirmationId: string,
  confirmationTitle: string,
  confirmationDescription: string,
  riskLevel: "high",
}
```

### 平台检测

- macOS：提示 `vm_stat`、`ps aux` 等 macOS 兼容命令
- Linux：提示 `free -h`、`ps aux` 等 Linux 命令
- 避免使用跨平台不兼容的命令（如 Linux 特有参数）

### 注意事项

- 超时 30 秒，超时发送 SIGTERM，5 秒后 SIGKILL
- 危险命令（`rm -rf /`、`sudo`、`dd` 等）触发确认弹窗
- 路径穿越检测：cwd 参数禁止逃逸工作区
- 输出超过 8000 字符自动截断

---

## claude_code

### 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| task | string | ✅ | — | 任务描述（越详细越好，包含背景+要求+验证方式） |
| context | string | ✅ | — | 上下文信息（如错误日志、相关代码片段） |
| workdir | string | ❌ | — | 工作目录（默认使用工作区路径） |

### 返回值

```typescript
{
  success: true,
  data: {
    output: string,     // Claude CLI 输出（超过 10000 字符截断）
    exit_code: number,  // 退出码
    task: string,       // 原任务描述（最多 100 字符）
  },
  elapsed_ms: number,
}

// CLI 未安装时：
{
  success: false,
  error: "Claude CLI 未安装或未在 PATH 中。请运行: npm install -g @anthropic-ai/claude-code",
}
```

### 执行命令

```
claude -p "{task}\n\n上下文：\n{context}" \
  --allowedTools "Bash,Read,Edit,Write" \
  --output-format text
```

### 注意事项

- 超时 5 分钟
- 仅允许 Bash、Read、Edit、Write 工具（安全子集）
- 依赖系统已安装 Claude CLI
- 用于运维告警自动修复场景

### 触发时机示例

```
用户："告警显示数据库连接超时，帮我自动修复"
→ claude_code(
    task: "修复数据库连接超时问题",
    context: "错误日志：Connection timeout after 30000ms...",
    workdir: "/path/to/project"
  )
```
