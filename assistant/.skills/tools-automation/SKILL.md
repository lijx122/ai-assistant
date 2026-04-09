---
name: tools-automation
description: create_task、reminder_set 自动化工具完整参数与返回值说明
when_to_use: 需要创建定时任务或在指定时间发送提醒通知时使用
allowed_tools: [create_task, reminder_set]
---

# 自动化工具

## 工具选择决策树

```
需要自动化？
  ├─ 创建定时任务（cron/间隔/一次性）
  │     → create_task（完整的任务管理）
  └─ 简单一次性提醒
        → reminder_set（自然语言时间，自动转为一次性任务）
```

---

## create_task

### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| name | string | ✅ | 任务名称（如"每日数据备份"） |
| type | string | ✅ | 调度类型：`cron` \| `interval` \| `once` |
| schedule | string | ✅ | 调度表达式（见下表） |
| command | string | ✅ | 命令内容 |
| command_type | string | ✅ | 执行类型：`shell` \| `assistant` \| `http` |
| notify_target | object | ❌ | 通知目标：`{ channel: 'lark' \| 'web' }` |

### schedule 说明（按 type）

| type | 示例 | 说明 |
|------|------|------|
| cron | `0 2 * * *` | 标准 5 段 cron 表达式 |
| interval | `30m` / `2h` / `1d` | 固定间隔（分钟/小时/天） |
| once | `2026-04-01T10:00:00Z` | ISO 时间字符串（一次性执行） |

### command_type 说明

| 值 | 说明 |
|----|------|
| shell | 执行 shell 命令（在工作区目录下） |
| assistant | 发送 AI 对话消息（创建新会话） |
| http | 发起 HTTP GET 请求（URL 需以 http:// 或 https:// 开头） |

### 返回值

```typescript
{
  success: true,
  data: {
    id: string,           // 任务 ID
    name: string,
    type: string,
    schedule: string,
    command_type: string,
    status: 'active',
    next_run: number,     // 下次执行时间（毫秒戳）
    message: string,      // 成功描述
  },
  elapsed_ms: number,
}
```

### 注意事项

- shell 和 assistant 类型任务需要 workspaceId
- once 类型执行后自动标记为 completed
- 连续失败 3 次自动暂停任务
- Shell 任务失败时可设置 alert_on_error 自动创建告警

---

## reminder_set

### 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| message | string | ✅ | — | 提醒内容（如"开会"、"喝水"） |
| time | string | ✅ | — | 自然语言时间（支持中文，如"30分钟后"、"明天下午3点"） |
| notify | string | ❌ | 'both' | 通知渠道：`web` \| `lark` \| `both` |

### 返回值

```typescript
{
  success: true,
  data: {
    message: string,          // 提醒内容
    scheduledAt: string,      // ISO 时间戳
    humanReadable: string,    // 人类可读时间（中文格式）
    taskId: string,          // 底层创建的定时任务 ID
    notifyRequested: string, // 请求的通知渠道
  },
  elapsed_ms: number,
}
```

### 内部实现

底层调用 `create_task`，创建 `type='once'` 的一次性任务。

### 注意事项

- 支持 chrono-node 自然语言解析（中文优先）
- 提醒时间必须晚于当前时间
- 底层通过 `executeCreateTask` 实现，复用任务管理能力

### 触发时机示例

```
用户："30 分钟后提醒我开会"
→ reminder_set(message: "开会", time: "30分钟后")

用户："明天上午 9 点提醒我提交日报"
→ reminder_set(message: "提交日报", time: "明天上午9点")
```
