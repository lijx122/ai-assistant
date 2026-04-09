---
name: tools-git
description: git_history、git_revert Git 版本控制工具（内部实现）完整说明
when_to_use: 查看 AI 历史改动记录，或需要回滚到某个历史版本时使用
allowed_tools: []
---

# Git 工具（内部版本控制）

> 注意：`git_history` 和 `git_revert` 目前是**内部工具**，不作为 AI 可直接调用的工具暴露，
> 而是在 `write_file` / `file_delete` / `file_move` 成功后**自动触发 commit**。
> 下面的说明供参考，未来可能将这两个工具暴露给 AI 直接调用。

## 自动 commit 机制

每次 AI 通过 `write_file` / `file_delete` / `file_move` 修改文件后，
`git-tracker.ts` 自动执行 commit，格式为：

```
[AI] {操作描述}
```

---

## GitTracker 类（内部实现）

位于 `src/services/git-tracker.ts`，由文件操作工具内部调用。

### 主要方法

| 方法 | 说明 | 返回值 |
|------|------|--------|
| `commit(desc)` | 创建 commit（无改动返回 null） | `string \| null`（commit hash） |
| `commitWithTag(msg, tag)` | 带标签 commit | `string \| null`（commit hash） |
| `getLog(limit)` | 获取最近 N 条 commit | `GitCommit[]` |
| `revertTo(hash)` | 回滚到指定 commit | `{ success, message }` |
| `hasChanges()` | 检查是否有未提交改动 | `boolean` |
| `getStatus()` | 获取当前改动统计 | `{ files, insertions, deletions }` |

### GitCommit 结构

```typescript
interface GitCommit {
  hash: string        // 短 hash（如 "a1b2c3d"）
  message: string     // 提交描述
  date: string        // ISO 日期时间
  filesChanged: number // 该 commit 改动文件数
}
```

### 回滚安全机制

`revertTo()` 执行前会自动将当前状态保存为 `[AI] snapshot before revert` commit，
方便反悔。

---

## 未来计划

如果需要将 `git_history` 和 `git_revert` 暴露为 AI 可调用工具，
需要新增 `src/services/tools/git-tools.ts`，参考以下接口：

```typescript
// git_history 参数
{ limit?: number }  // 默认 20

// git_revert 参数
{ hash: string, confirm: boolean }  // confirm 必须为 true 才执行
```

### 触发时机示例（未来）

```
用户："查看最近的改动"
→ 内部调用 GitTracker.getLog()，展示 commit 列表

用户："回滚到刚才的版本"
→ 调用 git_revert(hash: "a1b2c3d", confirm: true)
```
