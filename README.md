# ClaudeOS — Personal AI Assistant Runtime

**一个本地运行的个人 AI 助手，基于 Claude API，支持飞书/微信消息接入、文件操作、终端控制、Git 版本控制、任务自动化。**

> 不同于 ChatGPT 的单次对话，它是一个「会记忆、能操作、可长期运行」的个人 AI 工作台。

[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20+-green.svg)](https://nodejs.org/)

---

## 技术架构

```
┌─────────────────────────────────────────────────────────┐
│                      用户界面                            │
│   Web UI (Vue3)   │   飞书机器人   │   微信渠道            │
└────────┬──────────┴───────┬───────┴──────────┬──────────┘
         │                  │                   │
         │  WebSocket       │  Lark API         │  iLink API
         └──────────────────┼───────────────────┘
                            │
                    ┌────────▼────────┐
                    │  ChannelManager  │  ← 统一消息入口
                    │  (base.ts)       │
                    └────────┬────────┘
                             │
         ┌───────────────────┼───────────────────┐
         │                   │                   │
┌────────▼────────┐  ┌───────▼──────┐  ┌────────▼────────┐
│  指令解析        │  │  消息处理器   │  │  确认状态管理    │
│  /ws /recall 等 │  │  message-    │  │  confirmation   │
│                 │  │  processor   │  │  -state.ts      │
└─────────────────┘  └───────┬──────┘  └─────────────────┘
                             │  执行工具 / 构建 System Prompt
         ┌───────────────────┼───────────────────┐
         │                   │                   │
┌────────▼────────┐  ┌───────▼──────┐  ┌────────▼────────┐
│  AgentRunner    │  │  System      │  │  WorkspaceLock  │
│  多轮对话循环    │  │  Prompt 构建 │  │  (并发控制)      │
│  run() → 工具 → │  │  思维方法论  │  │                  │
│  run() → ...    │  │  工具索引    │  └─────────────────┘
└────────┬────────┘  └──────────────┘
         │
         │  getToolDefinitions()  ←── 18+ 工具注册
         │
┌────────▼──────────────────────────────────────────────┐
│                     Tool Registry                       │
│  bash │ file │ todo │ recall │ web_search │ deep_     │
│  research │ git │ claude_code │ note │ skill │ ...    │
│                                                        │
│  ┌────────────┐  ┌─────────────┐  ┌────────────────┐ │
│  │ danger-    │  │ HITL        │  │ timeout /      │ │
│  │ detector   │  │ confirmFlow │  │ error handling │ │
│  └────────────┘  └─────────────┘  └────────────────┘ │
└────────────────────────────────────────────────────────┘
         │
         │  历史检索
┌────────▼────────┐  ┌──────────────────────────────────┐
│  Recall (FTS5)  │  │  Embedder (本地 bge-small-zh)   │
│  关键词全文搜索   │  │  Float32 384维，cosine 相似度   │
└────────┬────────┘  └──────────────┬───────────────────┘
         │                           │
┌────────▼───────────────────────────▼───────────────────┐
│                   SQLite (better-sqlite3)               │
│  workspaces │ sessions │ messages │ tasks │ notes │ │
│  messages_fts │ embeddings │ cron_jobs              │
└─────────────────────────────────────────────────────────┘
```

**数据流**：用户消息 → ChannelManager → MessageProcessor → AgentRunner（多轮 Tool Call）→ 工具执行 → 回复推送

---

## 核心功能

### 对话与记忆

- **多工作区隔离**：每个项目独立上下文，切换互不影响
- **对话压缩（Compact）**：上下文超过 60k tokens 时自动压缩，保留最近 4 轮 + 摘要历史
- **FTS5 全文搜索**：关键词搜索历史对话，无需向量检索即可快速回溯
- **本地 Embedding**：使用 `bge-small-zh-v1.5` 在本地生成向量，cosine 相似度检索，30min 空闲自动卸载模型
- **工作区记忆**：AI 自动维护 IDENTITY.md / USER.md，支持自定义 TOOLS.md

### 工具系统（18+ 工具）

| 类别 | 工具 | 说明 |
|------|------|------|
| 文件 | `read_file` / `write_file` / `file_delete` / `file_move` | 带路径限制，危险操作需确认 |
| 终端 | `bash` | 带危险命令检测（rm/sudo/dd 等） |
| 搜索 | `web_search` / `web_fetch` / `deep_research` | 支持 Web/Codebase/GitHub 三种深度研究模式 |
| 记忆 | `recall` / `read_workspace_memory` / `read_impression` | 全文搜索 + 向量检索 |
| 笔记 | `note_write` / `note_read` / `note_search` | 结构化笔记管理 |
| 任务 | `create_task` / `reminder_set` | Cron 定时任务 + 提醒 |
| 代码 | `code_search` / `code_analyze` / `claude_code` | 代码库搜索 + Claude Code 调用 |
| Git | `git_history` / `git_revert` | 工作区文件 commit / 回滚 |

### 多渠道接入

- **Web UI**：Vue3 响应式界面，包含对话、文件管理、Web Terminal（node-pty + xterm.js）、Monaco Diff、Git 历史面板
- **飞书机器人**：多会话并行，消息可靠投递（delivery queue + 重试）
- **微信渠道**：通过 iLink API 接入，与飞书/Web 共用同一 Agent 引擎

### 工程化能力

- **HITL 安全机制**：所有写操作（bash / file_delete / file_move 等）经 danger-detector 检测，高危命令弹窗确认后才执行，超时自动取消
- **Git 版本控制**：AI 写文件自动 commit，支持历史查看与回滚
- **优雅关闭**：SIGTERM 时安全断开 WebSocket、停止定时任务、卸载 embedding 模型
- **JWT 鉴权**：基于 bcrypt 密码 hash 的登录认证，Cookie + Token 双模式

---

## 工程亮点

### 1. 为什么不用 LangChain

LangChain 的核心价值在于**链式组合**（Chain = LLM + 提示词 + 工具 + 记忆的统一抽象）。但当你的应用只有一个 Agent、工具是固定集、不需要链式编排时，LangChain 的抽象反而是负担：

- **版本不稳定**：LangChain 0.x → 0.2 → 0.3 每次升级都是破坏性变更
- **Bundle 过大**：import LangChain = 多 10MB，打包体积翻倍
- **调试困难**：链式调用隐藏了实际的数据流，出问题只能靠 LangChain 文档
- **定制受限**：tool_call 格式、HITL 流程、消息队列都是定制需求，LangChain 没有给足够的钩子

本项目用 **~400 行 TypeScript** 实现了完整的 Agent 循环：多轮 `run()` → `runOnce()` → `sanitizeMessages()` → 工具分发 → 结果聚合。没有抽象泄漏，每个决策都可直接修改。

```typescript
// 核心循环：极简，无依赖
for (let round = 1; round <= maxRounds; round++) {
    const result = await this.runOnce(messages, systemPrompt);
    messages.push({ role: 'assistant', content: result.blocks });
    const toolResults = await Promise.all(result.toolUses.map(handleToolCall));
    messages.push({ role: 'user', content: toolResults }); // 下一轮输入
}
```

### 2. HITL 机制怎么工作

HITL（Human-in-the-Loop）不是简单地在工具执行前加一个 `confirm()`，而是一套完整的**异步确认状态机**：

```
Claude 请求执行 bash rm -rf /tmp/*
       ↓
danger-detector.ts 检测到高危命令
       ↓
executeTool() 返回 { requiresConfirmation: true, confirmationId: "xxx" }
       ↓
AgentRunner 暂停执行，发送 'confirmation_requested' 事件给前端
       ↓
前端弹窗：⚠️ 高危操作确认 — rm -rf /tmp/*
用户点击「确认」→ POST /api/chat/confirm → executeConfirmedTool("xxx")
       ↓
工具真正执行，结果发回 Claude，Agent 继续
```

关键设计：

- **Promise 暂停**：工具执行函数返回后，AgentRunner 等待 `PendingConfirmation.resolve()`，Claude 不会收到错误消息
- **超时机制**：默认 5 分钟超时，超时自动取消，防止弹窗堆积
- **渠道无关**：确认机制由 `Channel.requestConfirmation()` 统一抽象，飞书/微信可以用按钮或文本回复确认
- **危险模式库**：`danger-detector.ts` 包含 12 种危险命令模式（rm / dd / mkfs / sudo / pipe_remote_script 等），正则驱动，可配置扩展

### 3. 向量检索怎么实现（无外部依赖）

很多项目引入 Pinecone / Qdrant / Milvus 来做向量检索，但个人项目这样做的代价是：额外的服务进程、API key 管理、网络延迟。本项目用**两层检索策略**完全本地化：

**第一层：FTS5 全文检索（SQLite 内置）**

```sql
-- messages_fts 是 messages 表的 FTS5 虚拟表
INSERT INTO messages_fts(content, message_id, session_id, workspace_id, role, created_at)
VALUES (?, ?, ?, ?, ?, ?);

-- 搜索：多词 AND 查询
SELECT mf.content, mf.role, mf.created_at
FROM messages_fts mf
WHERE messages_fts MATCH '考试 AND 地区' AND mf.workspace_id = ? AND mf.role = 'user'
ORDER BY rank LIMIT 2;
```

优势：SQLite 原生支持、无额外依赖、中英文分词由 FTS5 内置处理、ms 级响应。

**第二层：向量相似度（Transformers.js 本地模型）**

```typescript
// bge-small-zh-v1.5：384维向量，量化版 < 80MB
const extractor = await pipeline('feature-extraction', 'Xenova/bge-small-zh-v1.5', {
    quantized: true,  // INT8 量化，减少内存占用
});
const vector = await ext(text, { pooling: 'mean', normalize: true });
// cosineSimilarity(a, b) 手工实现，无外部依赖
```

设计决策：
- **按需加载**：对话时才加载模型，不占用启动时间
- **30min 空闲卸载**：自动释放内存，适合个人开发机
- **快速失败降级**：如果模型正在下载/加载中，Recall 降级到 FTS5，不阻塞对话

### 4. Context Compact 策略

Claude Opus 的上下文窗口是 200k tokens，看起来很大，但多轮对话 + 文件操作结果会快速耗尽。本项目的压缩策略：

```
原始消息列表（可能 80k tokens）
       ↓
1. 分离 System Prompt（不压缩）
2. 从后往前数最近 4 轮完整对话（保留）
3. 中间消息：
   - tool_result → 替换为 "[Compressed: Tool xxx execution completed]"
   - assistant（纯文本）→ 截断至 150 字
   - user → 截断至 100 字
4. 重组：[System] + [压缩历史] + [最近4轮]
       ↓
压缩后（~40k tokens）
通知前端：Context compacted: 80200 → 41200 tokens (-48.6%), 23 messages compressed
```

### 5. 多渠道统一架构

```
           ┌──────────────────┐
           │  ChannelManager  │  ← 唯一的消息入口
           │  broadcast()     │
           │  alert()        │
           └────┬─────────┬───┘
      WebSocket │         │ Lark SDK
               │         │
    ┌──────────▼──┐   ┌──▼──────────┐
    │ ws channel  │   │ lark channel │
    │              │   │              │
    │ sendMessage │   │ sendMessage  │
    │ waitReply() │   │ waitReply()  │
    └─────────────┘   └─────────────┘
               Weixin via iLink API
```

核心设计原则：**所有渠道共用同一 AgentRunner，同一工具集，同一 SQLite 数据库**。新增渠道只需要实现 `Channel` 抽象类（6 个方法），不需要修改任何业务逻辑。

---

## 技术栈

| 层级 | 技术选型 | 选型理由 |
|------|---------|---------|
| 前端框架 | Vue 3 + Vite + Tailwind CSS | 响应式组件，Tailwind 4 按需编译 |
| 编辑器 | Monaco Editor | VS Code 同款，代码高亮 / Diff 视图 |
| 终端 | node-pty + xterm.js | 真正的 PTY，支持 Bash / Zsh / Fish |
| 后端框架 | Hono | 轻量（~14kB），原生支持 WebSocket + 中间件 |
| 数据库 | SQLite（better-sqlite3）| 单文件、零配置、事务完整，FTS5 内置全文搜索 |
| AI SDK | @anthropic-ai/sdk | 官方 SDK，流式响应，TypeScript 完整类型 |
| 向量 | @xenova/transformers | WebAssembly 后端，CPU 可运行，无需 GPU |
| 鉴权 | bcrypt + jose | 密码 hash + JWT，零外部依赖 |
| 配置 | Zod + YAML | schema 校验 + YAML 配置，环境变量覆盖 |

---

## 快速开始

### 1. 克隆项目

```bash
git clone https://github.com/lijx122/ai-assistant.git
cd ai-assistant
```

### 2. 配置环境变量

```bash
cd assistant
cp .env.example data/.env
# 编辑 data/.env，填入必填项：
#   ANTHROPIC_API_KEY=sk-ant-...
#   JWT_SECRET=your_random_secret
#   AUTH_USERNAME=admin
#   AUTH_PASSWORD=your_password
```

### 3. 安装依赖并启动

```bash
cd assistant
npm install
npm run rebuild:pty          # 编译 node-pty 原生模块
npm run dev                    # 开发模式启动
```

访问 `http://localhost:8888`，登录后即可使用。

### 飞书接入（可选）

```bash
# 在 data/.env 中添加：
LARK_APP_ID=cli_xxx
LARK_APP_SECRET=xxx
LARK_DEFAULT_CHAT_ID=ou_xxx
```

### 微信接入（可选）

```bash
# 在 data/.env 中添加微信 iLink 配置
WEIXIN_ILINK_APP_ID=xxx
WEIXIN_ILINK_APP_SECRET=xxx
```

---

## 项目结构

```
ai-assistant/
├── assistant/
│   ├── src/
│   │   ├── server.ts                  # HTTP + WebSocket 服务入口
│   │   ├── config.ts                  # Zod 配置校验
│   │   ├── channels/                  # 消息渠道抽象
│   │   │   ├── base.ts                # Channel 基类 + ChannelManager
│   │   │   ├── websocket.ts           # Web UI WebSocket 接入
│   │   │   ├── lark.ts                # 飞书机器人
│   │   │   └── weixin.ts              # 微信渠道
│   │   ├── routes/                    # Hono 路由
│   │   │   ├── chat.ts               # 对话 + Agent 触发
│   │   │   ├── tasks.ts              # Cron 任务管理
│   │   │   ├── terminal.ts           # PTY 会话管理
│   │   │   └── ...
│   │   ├── services/
│   │   │   ├── agent-runner.ts       # Claude 多轮 Agent 循环
│   │   │   ├── message-processor.ts  # 统一消息处理入口
│   │   │   ├── context-compact.ts    # 上下文压缩
│   │   │   ├── recall.ts             # FTS5 全文搜索
│   │   │   ├── embedder.ts           # 本地 Transformer 向量生成
│   │   │   ├── workspace-config.ts  # 工作区配置 Prompt 构建
│   │   │   ├── skill-loader.ts       # .skills/ 动态加载
│   │   │   └── tools/
│   │   │       ├── registry.ts       # 工具注册与分发
│   │   │       ├── confirmation-state.ts  # HITL 确认状态机
│   │   │       ├── danger-detector.ts     # 危险命令检测
│   │   │       ├── bash.ts / file.ts / recall.ts ...
│   │   └── db/
│   │       ├── schema.sql            # SQLite 表结构 + FTS5
│   │       └── migrate.ts            # 增量迁移
│   ├── web-vue/                      # Vue3 前端源码
│   │   ├── views/                   # 对话 / 终端 / 文件管理等页面
│   │   ├── components/              # 可复用组件
│   │   └── ...
│   ├── data/                        # 数据目录（不提交 Git）
│   │   ├── .env                     # 密钥配置
│   │   └── *.db                     # SQLite 数据库
│   └── config.yaml                  # 主配置文件
├── .skills/                         # 工具技能说明（Claude 动态读取）
│   ├── git.md
│   └── ...
└── README.md
```

---

## 配置参考

### config.yaml 核心参数

```yaml
server:
  port: 8888

claude:
  model: "claude-sonnet-4-6"
  max_tokens: 4096
  compact:
    enabled: true
    token_limit: 60000      # 超过此值触发压缩
    preserve_rounds: 4     # 保留最近4轮
    summary_model: "claude-haiku-4-5-20251001"

runner:
  idle_timeout_minutes: 60  # 空闲1小时后销毁 Runner
  max_rounds: 20            # 单次对话最多20轮工具调用

files:
  allowed_roots: []         # 允许访问的目录，空=不限制
```

---

## License

ISC — 可免费用于个人项目，商用请注意 Claude API 使用条款。
