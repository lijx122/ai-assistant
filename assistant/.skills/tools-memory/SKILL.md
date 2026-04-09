---
name: tools-memory
description: recall、read_workspace_memory、read_impression 记忆工具完整参数与返回值说明
when_to_use: 用户提到"之前"、"上次"等回溯词，或需要了解项目背景、用户偏好时使用
allowed_tools: [recall, read_workspace_memory, read_impression]
---

# 记忆工具

## 工具选择决策树

```
需要使用记忆？
  ├─ 搜索历史对话语义相关内容
  │     → recall（向量相似度搜索，支持时间衰减）
  ├─ 读取项目技术栈/架构决策
  │     → read_workspace_memory（无参数）
  └─ 读取用户偏好/习惯
        → read_impression（无参数）
```

---

## recall（语义检索）

### 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| query | string | ✅ | — | 搜索意图描述（如"我们聊过的考试"或"Python异步相关讨论"） |
| limit | number | ❌ | 2 | 返回条数（最大 5） |

### 返回值

```typescript
{
  success: true,
  data: {
    found: number,        // 找到的结果数量
    message: string,      // 状态描述，如"找到 2 条语义相关历史对话"
    results: Array<{
      date: string,       // 对话日期，如 "3/27 14:30"
      content: string,    // 匹配内容（最多 300 字）
      sessionId: string,  // 所属会话 ID
      score: string,     // 相似度分数（0-1，3位小数）
      windowSize: number, // 关联的消息窗口大小
    }>,
  },
}
```

### 算法说明

- **向量语义搜索**：将 query 转为 embedding，与历史消息 embedding 做余弦相似度
- **时间衰减**：近期对话权重更高（30 天半衰期）
- **相似度阈值**：低于 0.45 的结果不返回，自动降级到 LIKE 关键词搜索
- **向量失败时**：自动降级到 LIKE 全文搜索（无需配置 embedding 服务）

### 注意事项

- 只在当前对话上下文**没有**相关信息时调用
- 如果用户的问题在当前会话中已讨论过，**直接回答，不要调用 recall**
- 适合调用：用户明确说"之前"、"上次"、"你还记得吗"
- 不适合调用：当前对话已有足够上下文、用户只是继续当前话题

---

## read_workspace_memory

### 参数

无参数，直接调用。

### 返回值

```typescript
{
  success: true,
  data: {
    content: string,   // 工作区记忆内容（如无内容则返回"暂无工作区记忆"）
  },
}
```

### 内容包含

- 项目技术栈、已知约定
- 重要决策记录、用户偏好
- 由 `post-session.ts` 在会话结束后自动写入

### 注意事项

- 功能可关闭（`config.memory.workspace.enabled`）
- 建议在开始新任务前调用一次了解项目背景

---

## read_impression

### 参数

无参数，直接调用。

### 返回值

```typescript
{
  success: true,
  data: {
    content: string,   // 用户印象内容（如无内容则返回"暂无用户偏好记录"）
  },
}
```

### 内容包含

- 用户习惯、偏好
- 历史上下文
- 由 `post-session.ts` 在会话结束后自动生成

### 注意事项

- 功能可关闭（`config.memory.impression.enabled`）
- 用于个性化回复参考
