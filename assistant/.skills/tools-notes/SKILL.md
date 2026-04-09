---
name: tools-notes
description: note_write、note_read、note_search 笔记工具完整参数与返回值说明
when_to_use: 需要在工作区保存笔记、记录会议内容、搜索已有笔记时使用
allowed_tools: [note_write, note_read, note_search]
---

# 笔记工具

## 工具选择决策树

```
笔记操作？
  ├─ 写入/更新笔记
  │     → note_write（带 frontmatter，追加或覆盖模式）
  ├─ 读取单条笔记
  │     → note_read（按标题查找，保留 frontmatter）
  └─ 搜索所有笔记
        → note_search（全文搜索，支持标题/tags/内容）
```

---

## note_write

### 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| title | string | ✅ | — | 笔记标题（同时作为文件名） |
| content | string | ✅ | — | 笔记内容（Markdown 格式） |
| append | boolean | ❌ | false | true=追加到末尾，false=覆盖 |
| tags | string[] | ❌ | 保留已有 | 标签数组（会覆盖旧标签） |

### 返回值

```typescript
{
  success: true,
  data: {
    title: string,             // 笔记标题
    path: string,             // 完整文件路径
    action: 'created' | 'updated' | 'appended',
    content_length: number,    // 内容字节数
    updated_at: string,       // ISO 时间戳
  },
  elapsed_ms: number,
}
```

### 文件格式

笔记保存为 `.notes/{sanitized_title}.md`，包含 YAML frontmatter：

```markdown
---
title: 会议纪要 2026-04-09
tags: ['meeting', 'important']
created_at: 2026-04-09T10:00:00.000Z
updated_at: 2026-04-09T11:30:00.000Z
---

笔记正文内容...
```

### 注意事项

- 文件名自动清理（去除非法字符，空格转下划线）
- 超过 50KB 自动截断

---

## note_read

### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| title | string | ✅ | 笔记标题（模糊匹配） |

### 返回值

```typescript
{
  success: true,
  data: {
    title: string,         // 匹配到的标题
    content: string,      // 正文（超过 50KB 截断）
    updatedAt: string,    // 更新时间
  },
  truncated: boolean,
  elapsed_ms: number,
}
```

### 注意事项

- 标题精确匹配文件名（经过 sanitize 处理）
- frontmatter 不会出现在 content 中
- 找不到笔记返回错误

---

## note_search

### 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| query | string | ✅ | — | 搜索关键词 |
| limit | number | ❌ | 10 | 返回结果上限 |

### 返回值

```typescript
{
  success: true,
  data: {
    query: string,
    results: Array<{
      title: string,       // 笔记标题
      excerpt: string,     // 匹配位置附近的内容片段（~100字）
      path: string,        // 完整文件路径
    }>,
    total: number,
  },
  elapsed_ms: number,
}
```

### 匹配规则

- 标题匹配（高优先级）
- tags 匹配
- 正文内容匹配（支持显示匹配位置附近片段）
- 结果按更新时间倒序（最新在前）

### 注意事项

- 搜索 `.notes/` 目录下所有 `.md` 文件
- 正文字段返回最长 100 字符预览（显示关键词附近内容）
