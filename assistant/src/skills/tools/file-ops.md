---
name: tools/file-ops
description: read_file、write_file、file_delete、file_move 文件操作工具完整说明
---

# 文件操作工具

## read_file

参数：
- path: string 工作区内相对路径

限制：500KB 以内，超出截断
适用：读取源代码、配置文件、文档

---

## write_file

参数：
- path: string 目标路径（自动创建目录）
- content: string 文件内容
- overwrite: boolean（默认 true）

⚠️ 风险：medium（会触发 git 自动提交）
写入后自动 git commit，可通过 git_history 查看并回滚

---

## file_delete

参数：
- path: string 文件路径

⚠️ 风险：high，触发 HITL 确认
执行前会弹出确认弹窗，用户确认后才删除

---

## file_move

参数：
- sourcePath: string
- targetPath: string

⚠️ 风险：medium，会覆盖目标文件（如存在）
