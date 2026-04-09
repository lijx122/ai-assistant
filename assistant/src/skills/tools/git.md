---
name: tools/git
description: git_history、git_revert Git 版本控制工具说明
---

# Git 工具

每次 write_file / file_delete / file_move 成功后，
系统自动执行 git commit，记录 AI 的每次改动。

## git_history

用途：查看 AI 对工作区的历史改动记录。

参数：
- limit: number（默认 20）

返回：commit 列表，含 hash、描述、时间、改动文件数

---

## git_revert

用途：回滚到某个历史版本。

参数：
- hash: string 目标 commit hash（从 git_history 获取）
- confirm: boolean 必须为 true 才执行

⚠️ 风险：high，目标版本之后的所有改动将丢失
执行前自动保存当前快照，方便反悔

流程：
1. 先调用 git_history 查看记录
2. 确认目标 hash
3. 调用 git_revert(hash, confirm:true)
