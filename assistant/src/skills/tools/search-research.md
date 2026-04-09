---
name: tools/search-research
description: web_search、web_fetch、deep_research 三个搜索研究工具的完整用法说明
---

# 搜索与研究工具

## web_search

用途：搜索互联网获取信息摘要。

参数：
- query: string（必填）搜索词，建议 5-20 字，精准描述
- num_results: number（可选，默认 5，最多 8）

适用：时事查询、技术文档定位、人物/公司基础信息
不适用：需要全文内容（用 web_fetch）、需要深度分析（用 deep_research）

最佳实践：
- 搜索词用关键词，不要用完整句子
- 中文内容用中文搜索词，英文技术文档用英文
- 结果只有摘要，需要原文内容要跟进 web_fetch

---

## web_fetch

用途：抓取单个网页正文内容。

参数：
- url: string（必填）完整 URL 含 https://
- max_tokens: number（可选，默认 2000，最大 4000）

适用：读取文章全文、查看官方文档、获取 GitHub README
不适用：需要登录的页面、纯 JavaScript 渲染的 SPA、PDF 文件

返回：{ title, byline, content, truncated }
注意：content 超过 max_tokens 时自动截断并标注 truncated: true

---

## deep_research

用途：对某个主题执行多轮搜索+抓取，返回聚合研究数据。

参数：
- topic: string（必填）研究主题
- depth: 'quick'|'standard'|'deep'（默认 standard）
  - quick：3次搜索，适合快速了解
  - standard：5次搜索+2篇全文，适合一般研究
  - deep：8次搜索+4篇全文，适合深度报告
- mode: 'web'|'codebase'|'github'（默认 web）
  - web：网络研究
  - codebase：分析工作区代码
  - github：分析 GitHub 项目（需提供 github_url）
- github_url: string（mode=github 时必填）
- clone_depth: boolean（是否 clone 到本地分析，默认 false）

适用：需要综合多来源信息的研究任务
耗时：quick ~15s，standard ~30s，deep ~60s+
