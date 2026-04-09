---
name: tools-file-ops
description: read_file、write_file、file_delete、file_move 文件操作工具完整参数与返回值说明
when_to_use: 需要读取、创建、删除或移动工作区内的文件时使用
allowed_tools: [read_file, write_file, file_delete, file_move]
---

# 文件操作工具

## 工具选择决策树

```
文件操作？
  ├─ 读取文件内容         → read_file（无需确认）
  ├─ 创建/覆盖文件       → write_file（自动创建目录，触发 git commit）
  ├─ 删除文件或目录       → file_delete（触发确认弹窗）
  └─ 移动/重命名文件     → file_move（覆盖时触发确认）
```

---

## read_file

### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| path | string | ✅ | 工作区内相对路径（如 `src/index.ts`） |

### 返回值

```typescript
{
  success: true,
  data: {
    content: string,   // 文件内容（超过 50KB 自动截断）
    size: number,      // 原文件字节数
    truncated: boolean,// 是否截断
    path: string,     // 原相对路径
  },
  truncated: boolean,
  elapsed_ms: number,
}
```

### 注意事项

- 超过 50KB 截断并附加 `[文件内容已截断，超过 50KB]`
- 路径穿越检测：禁止 `../` 等路径逃逸工作区

---

## write_file

### 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| path | string | ✅ | — | 目标路径（相对工作区，自动创建父目录） |
| content | string | ✅ | — | 文件内容 |
| overwrite | boolean | ❌ | true | 是否覆盖已有文件 |

### 返回值

```typescript
{
  success: true,
  data: {
    path: string,           // 写入路径
    bytesWritten: number,   // 写入字节数
    created: boolean,      // true=新建，false=覆盖
  },
  elapsed_ms: number,
}
```

### 注意事项

- 自动创建父目录
- 写入后自动 git commit（由 `git-tracker.ts` 触发）
- 风险等级：medium（可回滚）

---

## file_delete

### 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| path | string | ✅ | — | 要删除的文件或目录路径 |
| recursive | boolean | ❌ | false | 是否递归删除（目录时需设置为 true） |

### 返回值（首次调用需确认）

```typescript
// 需要确认时返回：
{
  success: false,
  requiresConfirmation: true,
  confirmationId: string,
  confirmationTitle: "⚠️ 删除文件确认" | "⚠️ 删除目录确认",
  confirmationDescription: "即将删除文件: xxx\n\n此操作不可撤销，确认继续吗？",
  riskLevel: "medium" | "high",  // 目录+recursive=high
}

// 确认后执行成功返回：
{
  success: true,
  data: {
    path: string,
    isDirectory: boolean,
    recursive: boolean,
  },
  elapsed_ms: number,
}
```

### 注意事项

- 总是触发确认弹窗
- 目录删除默认不递归（需 `recursive: true`）
- 风险等级：high（不可逆）

---

## file_move

### 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| source | string | ✅ | — | 源文件路径（相对工作区） |
| destination | string | ✅ | — | 目标路径（相对工作区） |
| overwrite | boolean | ❌ | false | 覆盖已存在的目标文件 |

### 返回值

```typescript
// 成功（无需确认）：
{
  success: true,
  data: {
    source: string,
    destination: string,
    overwritten: false,
  },
}

// 需要覆盖确认时（overwrite=true 且目标存在）：
{
  success: false,
  requiresConfirmation: true,
  confirmationTitle: "⚠️ 覆盖文件确认",
  confirmationDescription: "移动操作将覆盖已存在的目标: xxx\n\n源文件: xxx\n目标文件: xxx\n\n此操作不可撤销，确认继续吗？",
}

// 覆盖确认后：
{
  success: true,
  data: {
    source: string,
    destination: string,
    overwritten: true,
  },
}
```

### 注意事项

- 不覆盖时无需确认（直接执行）
- 覆盖时触发确认弹窗
- 路径穿越检测：禁止源/目标逃逸工作区
