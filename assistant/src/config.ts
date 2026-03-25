import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { parse } from 'yaml';
import { z } from 'zod';
import { config as dotenvConfig } from 'dotenv';

// ========== 第一步：读取 config.yaml 获取基础配置 ==========
function loadYamlConfig(configPath: string = resolve(process.cwd(), 'config.yaml')): any {
    if (!existsSync(configPath)) {
        throw new Error(`Config file not found at ${configPath}`);
    }
    const fileContent = readFileSync(configPath, 'utf8');
    return parse(fileContent);
}

// 先获取 yaml 中的 dataDir（或默认 ./data）
const yamlConfig = loadYamlConfig();
const DATA_DIR_FROM_YAML = yamlConfig.dataDir || './data';
const DATA_DIR = resolve(DATA_DIR_FROM_YAML);

// ========== 第二步：从 data/.env 加载环境变量 ==========
const dataEnvPath = resolve(DATA_DIR, '.env');
if (existsSync(dataEnvPath)) {
    dotenvConfig({ path: dataEnvPath });
} else {
    // 尝试从项目根目录加载（兼容旧配置）
    dotenvConfig({ path: resolve(process.cwd(), '.env') });
}

// ========== 第三步：校验必填项 ==========
const requiredEnvVars = ['ANTHROPIC_API_KEY', 'JWT_SECRET', 'AUTH_USERNAME', 'AUTH_PASSWORD'];
const missingVars = requiredEnvVars.filter(key => !process.env[key]);

if (missingVars.length > 0) {
    console.error('[Config] 错误：以下必填环境变量未设置：');
    missingVars.forEach(key => console.error(`  - ${key}`));
    console.error(`[Config] 请在 ${DATA_DIR}/.env 或项目根目录 .env 中填写真实值`);
    console.error(`[Config] .env 文件预期位置: ${dataEnvPath}`);
    process.exit(1);
}

// 模型配置 - 统一从环境变量读取
export const MODELS = {
    chat: process.env.MODEL_CHAT || 'claude-sonnet-4-6',
    compact: process.env.MODEL_COMPACT || 'claude-haiku-4-5',
    agent: process.env.MODEL_AGENT || 'claude-sonnet-4-6',
};

// ========== Schema 定义 ==========
const ConfigSchema = z.object({
    dataDir: z.string().default(DATA_DIR),

    // 从环境变量读取的敏感配置
    anthropicApiKey: z.string().default(() => process.env.ANTHROPIC_API_KEY!),
    anthropicBaseUrl: z.string().default(() => process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'),
    jwtSecret: z.string().default(() => process.env.JWT_SECRET!),

    // 飞书配置（可选）
    larkAppId: z.string().default(() => process.env.LARK_APP_ID || ''),
    larkAppSecret: z.string().default(() => process.env.LARK_APP_SECRET || ''),
    larkVerificationToken: z.string().default(() => process.env.LARK_VERIFICATION_TOKEN || ''),
    larkDefaultChatId: z.string().default(() => process.env.LARK_DEFAULT_CHAT_ID || ''),

    server: z.object({
        port: z.number().default(8888),
        host: z.string().default('0.0.0.0'),
    }),

    auth: z.object({
        token_expire_days: z.number().default(7),
        login_rate_limit: z.number().default(5),
        // 登录账号（仅从环境变量读取）
        bootstrap_username: z.string().min(1).default(() => process.env.AUTH_USERNAME || ''),
        // 登录密码（仅从环境变量读取）
        bootstrap_password: z.string().min(1).default(() => process.env.AUTH_PASSWORD || ''),
        bootstrap_role: z.enum(['admin', 'member']).default(() =>
            process.env.AUTH_ROLE === 'member' ? 'member' : 'admin'
        ),
    }),

    claude: z.object({
        model: z.string().default(() => MODELS.chat),
        max_tokens: z.number().default(4096),
        count_tokens_enabled: z.boolean().default(false),
        count_tokens_fixed: z.number().default(2000),
        context_window_messages: z.number().default(0),
        compact: z.object({
            enabled: z.boolean().default(true),
            threshold_ratio: z.number().default(0.8),
            token_limit: z.number().default(60000),
            preserve_rounds: z.number().default(4),
            summary_model: z.string().default(() => MODELS.compact),
            max_summary_tokens: z.number().default(800),
        }).default({
            enabled: true,
            threshold_ratio: 0.8,
            token_limit: 60000,
            preserve_rounds: 4,
            summary_model: MODELS.compact,
            max_summary_tokens: 800,
        }),
    }),

    runner: z.object({
        idle_timeout_minutes: z.number().default(60),
        max_crash_retries: z.number().default(5),
        max_rounds: z.number().default(20),
    }),

    terminal: z.object({
        max_sessions: z.number().default(5),
        shell: z.string().optional(),
    }),

    files: z.object({
        allowed_roots: z.array(z.string()).default([]),
    }),

    lark: z.object({
        enabled: z.boolean().default(false),
    }),

    tasks: z.object({
        max_history_per_task: z.number().default(100),
    }),

    logs: z.object({
        retention_days: z.number().default(90),
        terminal_logging: z.boolean().default(false),
        // 后端控制台日志（console.*）总开关
        backend_console_enabled: z.boolean().default(true),
        // 后端控制台日志级别阈值：低于阈值的日志会被静默
        backend_console_level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
        // HTTP 访问日志（hono/logger）开关
        http_access_enabled: z.boolean().default(true),
        // 浏览器控制台日志总开关（前端）
        browser_console_enabled: z.boolean().default(true),
        // 浏览器调试日志开关（前端 [*-DEBUG] / devLog）
        browser_debug_enabled: z.boolean().default(false),
    }),

    ops: z.object({
        alert: z.object({
            max_fix_attempts: z.number().default(3),
            model: z.string().default(() => MODELS.compact),
        }),
    }).default({ alert: { max_fix_attempts: 3, model: MODELS.compact } }),

    memory: z.object({
        workspace: z.object({
            enabled: z.boolean().default(true),
            max_chars: z.number().default(300),
            todolist_filenames: z.array(z.string()).default(['todo.md', 'TODO.md', 'todolist.md']),
        }).default({ enabled: true, max_chars: 300, todolist_filenames: ['todo.md', 'TODO.md', 'todolist.md'] }),
        impression: z.object({
            enabled: z.boolean().default(true),
            min_confidence: z.number().default(0.7),
            max_chars: z.number().default(300),
        }).default({ enabled: true, min_confidence: 0.7, max_chars: 300 }),
        watcher: z.object({
            enabled: z.boolean().default(true),
            inactive_hours: z.number().default(1),
            scan_interval_minutes: z.number().default(5),
        }).default({ enabled: true, inactive_hours: 1, scan_interval_minutes: 5 }),
    }).default({
        workspace: { enabled: true, max_chars: 300, todolist_filenames: ['todo.md', 'TODO.md', 'todolist.md'] },
        impression: { enabled: true, min_confidence: 0.7, max_chars: 300 },
        watcher: { enabled: true, inactive_hours: 1, scan_interval_minutes: 5 },
    }),

    tools: z.object({
        web_search: z.object({
            base_url: z.string().optional(),
        }).default({}),
    }).default({ web_search: {} }),

    skills: z.object({
        // 工作区内技能目录（相对 workspace root）
        workspace_dirs: z.array(z.string()).default(['skills']),
        // 全局技能目录（相对项目根目录或绝对路径）
        global_dirs: z.array(z.string()).default(['scripts/skills', 'src/skills']),
        // Catalog 中摘要长度限制
        catalog_max_summary_chars: z.number().default(120),
    }).default({
        workspace_dirs: ['skills'],
        global_dirs: ['scripts/skills', 'src/skills'],
        catalog_max_summary_chars: 120,
    }),
});

export type Config = z.infer<typeof ConfigSchema>;

let configInstance: Config | null = null;

export function loadConfig(configPath?: string): Config {
    // 默认走启动时读取的配置；测试/多实例场景可显式传入路径覆盖
    const parsedYaml = configPath ? loadYamlConfig(configPath) : yamlConfig;
    const resolvedDataDir = resolve(parsedYaml.dataDir || DATA_DIR_FROM_YAML || './data');

    // 合并环境变量到配置对象（环境变量优先级更高）
    const mergedConfig = {
        dataDir: resolvedDataDir,
        anthropicApiKey: process.env.ANTHROPIC_API_KEY,
        anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
        jwtSecret: process.env.JWT_SECRET,
        larkAppId: process.env.LARK_APP_ID || '',
        larkAppSecret: process.env.LARK_APP_SECRET || '',
        larkVerificationToken: process.env.LARK_VERIFICATION_TOKEN || '',
        larkDefaultChatId: process.env.LARK_DEFAULT_CHAT_ID || '',
        ...parsedYaml,
        // 工具配置：环境变量优先，其次 config.yaml
        tools: {
            ...parsedYaml.tools,
            web_search: {
                ...parsedYaml.tools?.web_search,
                base_url: process.env.WEB_SEARCH_BASE_URL || parsedYaml.tools?.web_search?.base_url,
            },
        },
        skills: {
            ...parsedYaml.skills,
        },
    };

    configInstance = ConfigSchema.parse(mergedConfig);
    return configInstance;
}

export function getConfig(): Config {
    if (!configInstance) {
        return loadConfig();
    }
    return configInstance;
}

export function resetConfig(): void {
    configInstance = null;
}
