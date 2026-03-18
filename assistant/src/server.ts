import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { logger } from 'hono/logger';
import { cors } from 'hono/cors';
import { createNodeWebSocket } from '@hono/node-ws';
import { getConfig, loadConfig } from './config';
import { initDb } from './db';
import { authRouter } from './routes/auth';
import { workspaceRouter } from './routes/workspaces';
import { sessionRouter } from './routes/sessions';
import { dashboardRouter } from './routes/dashboard';
import { logsRouter } from './routes/logs';
import { terminalRouter } from './routes/terminal';
import { filesRouter } from './routes/files';
import { taskRouter } from './routes/tasks';
import { todoRouter } from './routes/todos';
import { internalRouter } from './routes/internal';
import { proxyRouter } from './services/proxy';
import { chatRouter, getStreamingMessageByWorkspace } from './routes/chat';
import { uploadRouter } from './routes/upload';
import { startLarkService } from './services/lark';
import { processChannelMessage } from './services/message-processor';
import { initCronEngine, shutdownCronEngine } from './services/cron';
import { startAutoArchive, stopAutoArchive } from './services/archiver';
import { startSessionWatcher, stopSessionWatcher } from './services/session-watcher';
import { channelManager, ChannelMessage } from './channels';
import { preload as preloadEmbedder } from './services/embedder';
import { backfillEmbeddings } from './services/message-indexer';
import { getTerminal, writeToTerminal, onTerminalData, touchTerminal, markTerminalConnected, markTerminalDisconnected, startStaleTerminalCleanup, getTerminalOutputBuffer } from './services/terminal';
import { larkChannel, webSocketChannel } from './channels';
import { getDb } from './db';
import { logger as appLogger } from './services/logger';

// ===== Graceful Shutdown 状态管理 =====
let isShuttingDown = false;
const activeConnections = new Set<any>(); // Store WSContext objects
const SHUTDOWN_TIMEOUT_MS = 5000;

const rawConsole = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
};

const LOG_LEVEL_RANK = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
} as const;

function applyServerConsoleLogging(logs: ReturnType<typeof getConfig>['logs']): void {
    const enabled = logs.backend_console_enabled;
    const threshold = LOG_LEVEL_RANK[logs.backend_console_level];
    const allowed = (level: keyof typeof LOG_LEVEL_RANK) =>
        enabled && LOG_LEVEL_RANK[level] >= threshold;

    console.debug = (...args: any[]) => {
        if (!allowed('debug')) return;
        rawConsole.debug(...args);
    };
    console.info = (...args: any[]) => {
        if (!allowed('info')) return;
        rawConsole.info(...args);
    };
    console.log = (...args: any[]) => {
        if (!allowed('info')) return;
        rawConsole.log(...args);
    };
    console.warn = (...args: any[]) => {
        if (!allowed('warn')) return;
        rawConsole.warn(...args);
    };
    console.error = (...args: any[]) => {
        if (!allowed('error')) return;
        rawConsole.error(...args);
    };
}

// Check if a specific config path is provided, otherwise fallback to default
loadConfig();
// Ensure DB is instantiated
initDb();
const config = getConfig();
applyServerConsoleLogging(config.logs);

/**
 * 根据消息解析工作区ID
 * - Lark：通过 chatId 查 chat_workspace_map 表或 sessions 表
 * - WebSocket：msg 本身携带 workspaceId
 */
function resolveWorkspaceId(msg: ChannelMessage): string | undefined {
    // WebSocket 渠道直接携带 workspaceId
    if (msg.workspaceId) {
        return msg.workspaceId;
    }

    // Lark 渠道通过 chatId 查找
    const chatId = msg.raw?.chatId;
    if (chatId) {
        const db = getDb();

        // 1. 先尝试查找已绑定的 session
        const session = db.prepare(
            'SELECT workspace_id FROM sessions WHERE lark_chat_id = ? ORDER BY last_active_at DESC LIMIT 1'
        ).get(chatId) as { workspace_id: string } | undefined;

        if (session) {
            return session.workspace_id;
        }

        // 2. 没有绑定 session，返回第一个 active 工作区
        const workspace = db.prepare(
            'SELECT id FROM workspaces WHERE status = ? LIMIT 1'
        ).get('active') as { id: string } | undefined;

        if (workspace) {
            return workspace.id;
        }
    }

    return undefined;
}

// T5: Clean up orphaned streaming messages on startup (mark as interrupted)
{
    const db = initDb();
    const result = db.prepare(
        `UPDATE messages SET status = 'interrupted', streaming_content = NULL
         WHERE status = 'streaming'`
    ).run();
    if (result.changes > 0) {
        console.log(`[Startup] Marked ${result.changes} orphaned streaming messages as interrupted`);
    }
}

// T4: Initialize cron engine (load active tasks)
initCronEngine();

// T-7-HITL-1: Initialize confirmation state cleanup
import { startCleanup } from './services/tools/confirmation-state';
startCleanup();

const app = new Hono();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

// Global Middlewares
if (config.logs.http_access_enabled) {
    app.use('*', logger());
}
app.use('*', cors({
    origin: ['http://localhost:5173', 'http://127.0.0.1:5173'], // Typical Vite dev ports
    credentials: true,
}));

// Global Error Handler
app.onError((err, c) => {
    console.error('[Error]:', err);
    return c.json({ error: 'Internal Server Error' }, 500);
});

// Routes
app.route('/api/auth', authRouter);
app.route('/api/workspaces', workspaceRouter);
app.route('/api/sessions', sessionRouter);
app.route('/api/dashboard', dashboardRouter);
app.route('/api/logs', logsRouter);
app.route('/api/terminal', terminalRouter);
app.route('/api/proxy', proxyRouter);
app.route('/api/chat', chatRouter);
app.route('/api/upload', uploadRouter);
app.route('/api/files', filesRouter);
app.route('/api/tasks', taskRouter);
app.route('/api/todos', todoRouter);
app.route('/api/internal', internalRouter);

// Public Config API - 返回非敏感的默认配置
app.get('/api/config/public', (c) => {
    return c.json({
        larkDefaultChatId: config.larkDefaultChatId || null,
        logs: {
            browser_console_enabled: config.logs.browser_console_enabled,
            browser_debug_enabled: config.logs.browser_debug_enabled,
        },
    });
});

// WebSocket Route - Chat
app.get('/ws/chat/:workspaceId', upgradeWebSocket((c) => {
    const workspaceId = c.req.param('workspaceId');
    if (!workspaceId) return {};
    return {
        onOpen(evt, ws) {
            // Track in global active connections
            activeConnections.add(ws);

            // 注册到 WebSocketChannel
            webSocketChannel.registerConnection(workspaceId, ws);

            // Bug Fix: Check for streaming message and notify frontend
            setTimeout(() => {
                try {
                    const streamingMsg = getStreamingMessageByWorkspace(workspaceId);
                    if (streamingMsg && ws.readyState === 1) {
                        ws.send(JSON.stringify({
                            type: 'task_running',
                            payload: {
                                msgId: streamingMsg.id,
                                startedAt: streamingMsg.created_at
                            }
                        }));
                        console.log(`[WS Chat] Task running notification: ${streamingMsg.id} for workspace ${workspaceId}`);
                    }
                } catch (err) {
                    console.error(`[WS Chat] Error checking streaming message for ${workspaceId}:`, err);
                }
            }, 50);
        },
        onMessage(evt, ws) {
            // 转发消息到 WebSocketChannel 处理
            try {
                const data = typeof evt.data === 'string' ? JSON.parse(evt.data) : evt.data;
                webSocketChannel.handleWebSocketMessage(workspaceId, data, ws);
            } catch (err) {
                // 非 JSON 消息或解析错误，忽略
            }
        },
        onClose(evt, ws) {
            // Remove from global active connections
            activeConnections.delete(ws);

            // 从 WebSocketChannel 注销
            webSocketChannel.unregisterConnection(workspaceId, ws);
        }
    };
}));

// WebSocket Route - Terminal
app.get('/ws/terminal/:terminalId', upgradeWebSocket((c) => {
    const terminalId = c.req.param('terminalId');
    if (!terminalId) return {};

    let unsubscribe: (() => void) | null = null;

    return {
        onOpen(evt, ws) {
            // Track in global active connections
            activeConnections.add(ws);

            const session = getTerminal(terminalId);
            if (!session) {
                console.error(`[WS Terminal] Session ${terminalId} not found`);
                ws.close();
                return;
            }

            console.log(`[WS Terminal] Client connected to session ${terminalId}`);

            // 标记终端为已连接
            markTerminalConnected(terminalId);

            // 先发送缓冲区内容（重连时回放历史输出）
            try {
                const buffer = getTerminalOutputBuffer(terminalId);
                if (buffer && ws.readyState === 1) {
                    ws.send(buffer);
                    console.log(`[WS Terminal] Replayed ${buffer.length} bytes from buffer for ${terminalId}`);
                }
            } catch (err) {
                console.error(`[WS Terminal] Error replaying buffer for ${terminalId}:`, err);
            }

            // 订阅 PTY 实时数据输出
            try {
                unsubscribe = onTerminalData(terminalId, (data) => {
                    if (ws.readyState === 1) { // WebSocket.OPEN
                        ws.send(data);
                    }
                });
            } catch (err) {
                console.error(`[WS Terminal] Error subscribing to data:`, err);
                ws.close();
            }
        },
        onMessage(evt, ws) {
            // 将客户端输入写入 PTY
            try {
                const data = typeof evt.data === 'string' ? evt.data : evt.data.toString();

                // 支持 resize 控制消息（JSON 格式）
                if (data.startsWith('{')) {
                    try {
                        const msg = JSON.parse(data);
                        if (msg.type === 'resize' && typeof msg.cols === 'number' && typeof msg.rows === 'number') {
                            const session = getTerminal(terminalId);
                            if (session) {
                                session.pty.resize(msg.cols, msg.rows);
                                console.log(`[WS Terminal] Resized ${terminalId} to ${msg.cols}x${msg.rows}`);
                            }
                            return;
                        }
                    } catch {
                        // 不是有效的 resize 消息，作为普通输入处理
                    }
                }

                // 普通输入
                writeToTerminal(terminalId, data);
            } catch (err) {
                console.error(`[WS Terminal] Error writing to terminal:`, err);
            }
        },
        onClose(evt, ws) {
            // Remove from global active connections
            activeConnections.delete(ws);

            console.log(`[WS Terminal] Client disconnected from session ${terminalId}`);
            // 标记终端为已断开（PTY 保持运行以便重连）
            markTerminalDisconnected(terminalId);
            if (unsubscribe) {
                unsubscribe();
            }
        }
    };
}));

// WebSocket Route - Logs (实时日志流)
app.get('/ws/logs', upgradeWebSocket((c) => {
    let subscribedCategories: Set<string> = new Set();

    return {
        onOpen(evt, ws) {
            activeConnections.add(ws);
            console.log('[WS Logs] Client connected');

            // 发送欢迎消息
            ws.send(JSON.stringify({
                type: 'connected',
                message: 'Logs WebSocket connected. Send {"action":"subscribe","categories":["system","sdk"]} to subscribe.',
                timestamp: Date.now()
            }));
        },
        onMessage(evt, ws) {
            try {
                const data = JSON.parse(typeof evt.data === 'string' ? evt.data : evt.data.toString());

                if (data.action === 'subscribe' && Array.isArray(data.categories)) {
                    subscribedCategories = new Set(data.categories);
                    ws.send(JSON.stringify({
                        type: 'subscribed',
                        categories: Array.from(subscribedCategories),
                        timestamp: Date.now()
                    }));
                } else if (data.action === 'unsubscribe') {
                    subscribedCategories.clear();
                    ws.send(JSON.stringify({
                        type: 'unsubscribed',
                        timestamp: Date.now()
                    }));
                }
            } catch (err) {
                // 忽略无效消息
            }
        },
        onClose(evt, ws) {
            activeConnections.delete(ws);
            console.log('[WS Logs] Client disconnected');
        }
    };
}));

// Base heartbeat
app.get('/health', (c) => c.json({ status: 'ok', timestamp: Date.now() }));

// Static files - serve index.html for root path
app.use('/*', serveStatic({ root: './web', index: 'index.html' }));

const port = config.server.port;
const hostname = config.server.host;

if (process.env.NODE_ENV !== 'test') {
    // 异步启动
    (async () => {
        // 注册所有渠道
        channelManager.register(webSocketChannel);
        channelManager.register(larkChannel);

        // 初始化所有渠道
        await channelManager.initializeAll();

        // 注册全局消息处理器
        channelManager.onMessage(async (msg: ChannelMessage) => {
            const workspaceId = resolveWorkspaceId(msg);
            if (!workspaceId) {
                // 无法解析工作区，回复用户提示
                if (msg.raw?.chatId) {
                    await larkChannel.sendMessage('无法确定工作区，请先绑定工作区', {
                        target: { channel: 'lark', chat_id: msg.raw.chatId }
                    });
                } else {
                    await webSocketChannel.sendMessage('无法确定工作区，请先绑定工作区', {
                        target: msg.workspaceId || 'unknown'
                    });
                }
                return;
            }
            await processChannelMessage(msg, workspaceId);
        });

        // 启动旧版飞书服务（兼容层，逐步迁移）
        startLarkService();

        // 启动终端超时清理定时器
        startStaleTerminalCleanup();

        // 启动自动归档服务
        startAutoArchive();

        // 启动 Session Watcher（记忆模块）
        startSessionWatcher();

        // 预加载向量模型并回填历史消息（异步，不阻塞启动）
        preloadEmbedder()
            .then(() => backfillEmbeddings())
            .catch(err => console.warn('[Embedder] Init failed:', err));

        const server = serve({
            fetch: app.fetch,
            port: port,
            hostname: hostname
        }, (info) => {
            console.log(`🚀 Assistant Server is running on http://${info.address}:${info.port}`);
            appLogger.system.info('server', 'Server started', { port: info.port, hostname: info.address });
        });
        injectWebSocket(server);

        // Graceful shutdown
        const gracefulShutdown = async (signal: string) => {
            // Prevent duplicate shutdown execution
            if (isShuttingDown) {
                console.log(`[Shutdown] Already shutting down, ignoring ${signal}`);
                return;
            }
            isShuttingDown = true;

            console.log(`[Shutdown] Received ${signal}, shutting down gracefully...`);

            // Step 1: Close all active WebSocket connections
            const wsCount = activeConnections.size;
            if (wsCount > 0) {
                console.log(`[Shutdown] Terminating ${wsCount} active WebSocket connections...`);
                for (const ws of activeConnections) {
                    try {
                        ws.close();
                    } catch (err) {
                        // Ignore errors during close
                    }
                }
                activeConnections.clear();
            }

            // Step 2: Stop cron engine
            shutdownCronEngine();

            // Step 3: Stop archiver
            stopAutoArchive();

            // Step 4: Stop session watcher
            stopSessionWatcher();

            // T-7-HITL-1: Stop confirmation state cleanup
            const { stopCleanup } = await import('./services/tools/confirmation-state');
            stopCleanup();

            // Step 4: Shutdown channels
            await channelManager.shutdownAll();

            // Step 4: Close HTTP server with timeout fallback
            const forceExit = () => {
                console.log('[Shutdown] Force exit after timeout');
                process.exit(1);
            };

            const timeoutId = setTimeout(forceExit, SHUTDOWN_TIMEOUT_MS);

            server.close(() => {
                console.log('[Shutdown] Server closed');
                clearTimeout(timeoutId);
                process.exit(0);
            });
        };

        process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
        process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    })();
}

export default app;
