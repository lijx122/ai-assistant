---
name: tools/notes
description: note_write、note_read、note_search 笔记工具说明
---

# 笔记工具

## note_write

用途：写入或追加笔记到工作区。

参数：
- key: string 笔记唯一标识（如 "meeting-2024-03"）
- content: string 笔记内容
- append: boolean（可选，默认 false）true 时追加到现有内容末尾

适用：记录会议纪要、临时想法、项目笔记
存储：SQLite 数据库，与工作区关联

---

## note_read

用途：读取单条笔记。

参数：
- key: string 笔记标识

---

## note_search

用途：全文搜索笔记。

参数：
- query: string 搜索关键词

返回：匹配的笔记列表，含 key、snippet、时间
