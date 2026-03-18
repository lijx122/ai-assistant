# 个人智能工作台（练手项目）

这是一个偏工程化的练手作品，主项目是 `assistant/`，`searxng/` 作为可选搜索能力。

## 思路

这个项目核心是把一个“能聊天”的应用，往“能干活”的方向推进：

- 前端：提供聊天、文件管理、终端、任务面板这些基础操作入口
- 后端：统一接收请求，组织上下文，调用模型和工具，再把结果流式返回前端
- 工具化：不仅输出文字，还能读写文件、执行命令、搜索网页、操作待办
- 可配置：通过 `config.yaml` + `data/.env` 控制端口、鉴权、日志、模型、工具开关
- 可拆分：主能力在 `assistant/`，联网搜索交给 `searxng/`，降低耦合

目录关系：

```text
.
├── assistant/   # 主项目（Web + API + Agent + Tools）
└── searxng/     # 搜索服务（可选）
```

## 用法

### 1. 启动搜索服务（可选）

```bash
cd searxng
docker compose up -d
```

默认地址：`http://127.0.0.1:8887`

### 2. 配置主项目环境变量

```bash
cd ../assistant
cp .env.example data/.env
```

至少填写这些：

- `ANTHROPIC_API_KEY`
- `JWT_SECRET`
- `AUTH_USERNAME`
- `AUTH_PASSWORD`

如果你启用了 `searxng`，再加：

```bash
WEB_SEARCH_BASE_URL=http://127.0.0.1:8887
```

### 3. 安装并启动

```bash
cd assistant
npm install
npm run rebuild:pty
npm run dev
```

访问：`http://0.0.0.0:8888`

### 4. 常用命令

```bash
npm run build        # 构建
npm run dev          # 开发启动（build 后启动）
npm run test         # 测试
npm run rebuild:pty  # 迁移机器后重编译 node-pty
```

### 5. 源码打包（用于开源）

打包时建议排除：

- `assistant/data/`
- `assistant/data/.env`
- `assistant/node_modules/`
- `assistant/dist/`
- `assistant/coverage/`
- `assistant/logs/`
