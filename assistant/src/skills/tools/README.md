# 工具 Skill 维护指南

## 目录结构

```
skills/
├── tools/
│   ├── search-research.md   # web_search / web_fetch / deep_research
│   ├── file-ops.md          # read_file / write_file / file_delete / file_move
│   ├── memory.md            # recall / read_workspace_memory / read_impression
│   ├── notes.md             # note_write / note_read / note_search
│   ├── code.md              # bash / code_search / code_analyze / claude_code
│   ├── automation.md        # create_task / reminder_set
│   └── git.md               # git_history / git_revert
└── README.md
```

## 新增工具时

1. 在对应类别的 .md 文件中追加说明（已有分类时）
2. 如是新类别，创建 `skills/tools/<新类别>.md`，在 `message-processor.ts` 的工具索引表中添加该类别
3. 不需要修改 system prompt 其他内容

## 修改工具行为时

1. 只改对应 .md 文件
2. system prompt 不需要动
3. AI 下次调用 read_skill 会自动获取最新说明

## 子目录支持

read_skill 支持 `tools/类别` 格式的路径。例如：
- `read_skill("tools/search-research")` → 读取 `skills/tools/search-research.md`
- `read_skill("git")` → 读取 `skills/git.md`（根目录优先）
