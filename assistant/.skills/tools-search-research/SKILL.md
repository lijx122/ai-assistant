---
name: tools-search-research
description: web_search、web_fetch、deep_research 搜索研究工具完整参数与返回值说明
when_to_use: 需要搜索互联网信息、抓取网页全文，或对某主题进行深度研究时使用
allowed_tools: [web_search, web_fetch, deep_research]
---

# 搜索与研究工具

## 工具选择决策树

```
需要搜索信息？
  ├─ 简单事实/摘要查询 → web_search（快，5条结果）
  ├─ 需要全文内容      → web_fetch（抓取单个 URL 正文）
  └─ 深度研究/报告    → deep_research（多轮搜索+抓取，自动聚合）
```

---

## web_search

### 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| query | string | ✅ | — | 搜索关键词，建议 5-20 字精准描述 |
| num_results | number | ❌ | 5 | 返回结果数（最大 10） |

### 返回值

```typescript
{
  success: true,
  data: {
    query: string,           // 原搜索词
    results: Array<{         // 搜索结果列表
      title: string,        // 结果标题
      url: string,          // 链接
      content: string,      // 摘要/snippet
      engine: string,       // 来源引擎
    }>,
    total: number,          // 实际返回数量
  },
  elapsed_ms: number,
}
```

### 适用场景

- 时事查询、技术文档定位、人物/公司基础信息
- 需要全文时跟进 `web_fetch`

### 注意事项

- 依赖 SearXNG 配置（`tools.web_search.base_url`）
- 超时 10 秒，超时返回空结果
- 结果只有摘要，完整内容需跟进 `web_fetch`

---

## web_fetch

### 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| url | string | ✅ | — | 完整 URL，必须含 https:// |
| max_chars | number | ❌ | 3000 | 最大返回字符（最大 20000） |

### 返回值

```typescript
{
  success: true,
  data: {
    url: string,             // 原 URL
    title: string,           // 文章标题
    content: string,         // 正文（≤ max_chars）
    byline: string,          // 作者/来源（如有）
    publishedTime: string,   // 发布时间（如有）
    length: number,         // 实际返回字符数
  },
  truncated: boolean,         // 是否被截断
  elapsed_ms: number,
}
```

### 适用场景

- 读取文章全文、查看官方文档、获取 GitHub README
- 使用 Mozilla Readability 提取正文，自动过滤广告和导航

### 注意事项

- 不适用：需要登录的页面、纯 JavaScript 渲染的 SPA、PDF
- 超时 15 秒
- 非 HTML 内容类型返回错误

---

## deep_research

### 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| topic | string | ✅ | — | 研究主题，尽量具体明确 |
| depth | 'quick'\|'standard'\|'deep' | ❌ | 'standard' | quick=3次搜索；standard=5次+2篇全文；deep=8次+4篇全文 |
| mode | 'web'\|'codebase'\|'github' | ❌ | 'web' | web=网络研究；codebase=工作区代码分析；github=GitHub项目分析 |
| github_url | string | ❌ | — | GitHub URL，mode=github 时必填 |
| clone_depth | boolean | ❌ | false | 是否 clone 到本地做代码分析（仅 github 模式） |

### 返回值

```typescript
{
  success: true,
  data: {
    topic: string,
    depth: string,
    mode: string,
    research: string,         // 聚合研究数据（Markdown 格式）
                              // 包含执行统计、来源列表、后续任务指令
  },
  elapsed_ms: number,
}
```

### 适用场景

- 需要综合多来源信息的研究任务
- 市场调研、技术调查、竞品分析
- GitHub 项目选型评估

### 注意事项

- 超时 2 分钟（mode=web/github）
- mode=codebase 内部调用 `claude_code` 做架构分析
- mode=github 需要 SearXNG 配置

### 触发时机示例

```
用户："帮我深度研究一下 Rust 语言现状"
→ deep_research(topic: "Rust 语言 2026 年现状", depth: "standard", mode: "web")

用户："分析一下 React 生态的发展趋势"
→ deep_research(topic: "React 生态发展趋势", depth: "deep", mode: "web")

用户："帮我看看 GitHub 上这个项目怎么样：facebook/react"
→ deep_research(topic: "React 框架分析", mode: "github", github_url: "facebook/react")
```
