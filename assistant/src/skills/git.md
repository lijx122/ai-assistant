# Git 操作最佳实践

## 常用命令速查

```bash
# 查看状态
git status

# 添加文件
git add <file>
git add -A  # 添加所有改动

# 提交更改
git commit -m "描述信息"

# 推送至远程
git push origin <branch>

# 拉取更新
git pull origin <branch>

# 查看日志
git log --oneline -10
```

## 分支管理

```bash
# 创建并切换分支
git checkout -b feature/new-feature

# 切换分支
git checkout main

# 合并分支
git merge feature/new-feature

# 删除本地分支
git branch -d feature/new-feature
```

## 常见场景

### 撤销未暂存的更改
```bash
git checkout -- <file>
```

### 修改最后一次提交
```bash
git commit --amend -m "新的提交信息"
```

### 查看文件历史
```bash
git log -p <file>
```

## 注意事项

1. 提交前务必运行 `git status` 检查改动
2. 写有意义的提交信息，遵循项目规范
3. 大文件不要提交到 git，使用 .gitignore
4. 敏感信息（密码、密钥）绝不要提交
