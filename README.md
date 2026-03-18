# AI Assistant - Personal Agent Runtime

一个面向个人开发者的 **AI Agent 运行时系统**，支持：

- 多工作区上下文记忆
- 工具调用（文件 / 终端 / 网络 / 任务调度）
- 自动化运维（任务失败分析 + 自修复）
- Web / 飞书 多渠道统一接入

> ⚠️ 当前仅支持 Anthropic Claude API

---

## ✨ What makes this different?

它更像一个：

> 🧠 **“会记忆、能操作、可长期运行的个人 AI 工作台”**

---

## 🧩 Core Capabilities

- 🧠 **Workspace-aware memory**  
  AI 能记住每个项目的上下文、技术选型和历史决策

- 🛠 **Tool-driven execution**  
  支持 Shell / 文件 / 网络 / 任务调度等 18+ 工具

- 🔁 **Autonomous operations**  
  定时任务失败 → AI 自动分析 → 提供修复方案

- 🌐 **Multi-channel interface**  
  Web UI + 飞书机器人共用同一套 Agent

---

## 核心特性

### 1. AI 对话与工具调用
- **流式对话**：基于 WebSocket 的实时消息流
- **工具系统**：Claude 可调用多种工具完成任务
- **人机确认**：危险操作（删除文件、执行命令等）需人工确认
- **上下文管理**：自动 compact 超长对话，保持上下文窗口健康

### 2. 内置工具集（Tools）

| 工具 | 功能描述 |
|------|----------|
| `bash` | 执行 Shell 命令，支持超时和危险命令检测 |
| `read_file` | 读取文件内容 |
| `write_file` | 写入文件（覆盖/追加） |
| `delete_file` | 删除文件（需确认） |
| `move_file` | 移动/重命名文件（需确认） |
| `todo_read` / `todo_write` | 读写工作区待办事项 |
| `create_task` | 创建定时任务（Cron 表达式） |
| `web_search` | 网页搜索（需配置 SearXNG） |
| `web_fetch` | 抓取网页内容 |
| `read_skill` | 读取 Skill 技能定义 |
| `claude_code` | 调用 Claude Code CLI |
| `recall` | 向量检索历史对话 |
| `read_workspace_memory` | 读取工作区记忆 |
| `read_impression` | 读取用户印象记忆 |
| `note_write` / `note_read` / `note_search` | 笔记管理 |

### 3. Web 界面功能
- **对话面板**：多工作区隔离，Markdown 渲染
- **文件管理器**：树形浏览、编辑、上传下载
- **终端**：多会话 Web Terminal（基于 node-pty + xterm.js）
- **任务面板**：Cron 定时任务管理
- **仪表盘**：系统状态、运行器状态、日志流
- **记忆面板**：工作区记忆、用户印象管理

### 4. 工程化特性
- **工作区隔离**：多项目并行，数据互不影响
- **JWT 认证**：基于 JWT 的登录鉴权
- **飞书集成**：支持 Lark 机器人接入（可选）
- **自动归档**：定期归档历史消息
- **向量化检索**：基于 Transformers.js 的本地 Embedding
- **优雅关闭**：SIGTERM 时安全断开 WebSocket、停止定时任务

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | 原生 JS + Tailwind CSS + Monaco Editor + Xterm.js |
| 后端 | Node.js + TypeScript + Hono |
| 数据库 | SQLite (better-sqlite3) |
| AI | Anthropic Claude API (@anthropic-ai/sdk) |
| 终端 | node-pty |
| 向量 | @xenova/transformers |

---

## 快速开始

### 1. 克隆与进入目录

```bash
git clone https://github.com/lijx122/ai-assistant.git
cd ai-assistant
```

### 2. 配置环境变量

```bash
cd assistant
cp .env.example data/.env
```

编辑 `data/.env`，填入以下**必填项**：

```bash
# Claude API 密钥（必需）
ANTHROPIC_API_KEY=your_api_key_here

# JWT 密钥（生产环境请使用强随机字符串）
JWT_SECRET=your_random_secret

# 登录账号
AUTH_USERNAME=admin
AUTH_PASSWORD=your_password
```

可选配置：
```bash
# 如果启用 SearXNG 搜索
WEB_SEARCH_BASE_URL=http://127.0.0.1:8887

# 飞书集成（可选）
LARK_APP_ID=xxx
LARK_APP_SECRET=xxx
LARK_DEFAULT_CHAT_ID=xxx
```

### 3. 启动搜索服务（可选）

如需网页搜索功能：

```bash
cd ../searxng
docker compose up -d
```

默认地址：`http://127.0.0.1:8887`

### 4. 安装依赖并启动

```bash
cd ../assistant
npm install
npm run rebuild:pty  # 编译 node-pty 原生模块
npm run dev          # 开发模式启动
```

访问：`http://localhost:8888`

---

## 常用命令

```bash
npm run build        # 构建 TypeScript
npm run dev          # 开发启动（build + 启动）
npm run dev:watch    # 热重载模式
npm run test         # 运行测试（Vitest）
npm run rebuild:pty  # 迁移机器后重编译 node-pty
```

---

## 配置说明

### config.yaml

主配置文件，控制端口、模型参数、日志等：

```yaml
server:
  port: 8888
  host: 0.0.0.0

claude:
  model: "claude-opus-4-6"      # 主模型
  max_tokens: 4096              # 最大输出 Token
  context_window_messages: 0    # 0 = 不限制轮次
  compact:
    enabled: true               # 超长对话自动压缩
    token_limit: 40000
    preserve_rounds: 4
    summary_model: "claude-haiku-4-5-20251001"
```

### .env 模型配置

```bash
# 主对话模型
MODEL_CHAT=claude-sonnet-4-6

# Compact 摘要模型
MODEL_COMPACT=claude-haiku-4-5-20251001

# 任务/Agent 模型
MODEL_AGENT=claude-sonnet-4-6
```

---

## 项目结构

```
.
├── assistant/           # 主项目
│   ├── src/
│   │   ├── server.ts           # HTTP + WebSocket 服务
│   │   ├── routes/             # API 路由
│   │   ├── services/           # 业务逻辑
│   │   │   ├── tools/          # 工具实现
│   │   │   ├── agent-runner.ts # Claude 运行器
│   │   │   └── ...
│   │   ├── db/                 # SQLite 数据库
│   │   └── config.ts           # 配置管理
│   ├── web/              # 前端静态文件
│   ├── data/             # 数据目录（含 .env）
│   └── config.yaml       # 主配置
│
└── searxng/             # 搜索服务（可选）
    └── docker-compose.yml
```

---

## 安全注意事项

1. **不要将 `data/.env` 提交到 Git**，已包含在 `.gitignore` 中
2. **危险操作确认**：删除、移动、某些 bash 命令需要人工确认
3. **文件访问限制**：通过 `config.yaml` 的 `files.allowed_roots` 控制可访问路径
4. **JWT 密钥**：生产环境请使用强随机字符串

---

## License

ISC

---

