/**
 * 危险命令检测模块
 *
 * 检测需要人工确认的 bash 命令模式
 */

/**
 * 危险命令模式定义
 */
interface DangerPattern {
    /** 模式名称 */
    name: string;
    /** 检测正则 */
    pattern: RegExp;
    /** 风险等级 */
    risk: 'high' | 'medium';
    /** 描述信息 */
    description: string;
}

/**
 * 危险命令模式列表
 */
const DANGER_PATTERNS: DangerPattern[] = [
    // 文件删除类（高危）
    {
        name: 'rm_command',
        pattern: /(?:^|\s|;|\||&&)rm\s+(?:-[a-zA-Z]*\s+)?(?:\S+)/,
        risk: 'high',
        description: '删除文件/目录操作',
    },
    {
        name: 'rmdir_command',
        pattern: /(?:^|\s|;|\||&&)rmdir\s+(?:-[a-zA-Z]*\s+)?(?:\S+)/,
        risk: 'high',
        description: '删除目录操作',
    },

    // 磁盘操作类（高危）
    {
        name: 'dd_command',
        pattern: /(?:^|\s|;|\||&&)dd\s+/,
        risk: 'high',
        description: 'dd 磁盘操作（可能覆盖数据）',
    },
    {
        name: 'mkfs_command',
        pattern: /(?:^|\s|;|\||&&)mkfs\.[a-z]+\s+/,
        risk: 'high',
        description: '格式化文件系统',
    },
    {
        name: 'fdisk_command',
        pattern: /(?:^|\s|;|\||&&)fdisk\s+/,
        risk: 'high',
        description: '磁盘分区操作',
    },

    // 权限提升类（高危）
    {
        name: 'sudo_command',
        pattern: /(?:^|\s|;|\||&&)sudo\s+/,
        risk: 'high',
        description: 'sudo 提权执行',
    },

    // 管道执行远程脚本（高危）
    {
        name: 'pipe_remote_script',
        pattern: /(?:curl|wget).*[|>].*\s*(?:bash|sh|zsh)\s*(?:-c)?/i,
        risk: 'high',
        description: '下载并执行远程脚本（管道执行）',
    },

    // 工作区外写入（高危）
    {
        name: 'outside_workspace_redirect',
        pattern: /[>][^>|&]*\/\s*(?:bin|etc|usr|var|opt|home|root|tmp)\//,
        risk: 'high',
        description: '重定向写入系统目录',
    },

    // 递归删除（高危）
    {
        name: 'recursive_remove',
        pattern: /rm\s+-[a-zA-Z]*r[a-zA-Z]*\s+/,
        risk: 'high',
        description: '递归删除操作',
    },

    // 通配符删除（中危）
    {
        name: 'wildcard_remove',
        pattern: /rm\s+.*\*+/,
        risk: 'medium',
        description: '使用通配符的删除操作',
    },
];

/**
 * 危险命令检测结果
 */
export interface DangerCheckResult {
    /** 是否危险 */
    isDangerous: boolean;
    /** 风险等级 */
    risk?: 'high' | 'medium';
    /** 检测到的模式列表 */
    matchedPatterns: DangerPattern[];
    /** 用户友好的描述 */
    description: string;
    /** 原始命令 */
    command: string;
}

/**
 * 检测命令是否危险
 *
 * @param command 要检测的命令
 * @returns 检测结果
 */
export function isDangerousCommand(command: string): DangerCheckResult {
    const matchedPatterns: DangerPattern[] = [];

    for (const pattern of DANGER_PATTERNS) {
        if (pattern.pattern.test(command)) {
            matchedPatterns.push(pattern);
        }
    }

    if (matchedPatterns.length === 0) {
        return {
            isDangerous: false,
            matchedPatterns: [],
            description: '',
            command,
        };
    }

    // 确定最高风险等级
    const hasHighRisk = matchedPatterns.some(p => p.risk === 'high');
    const risk = hasHighRisk ? 'high' : 'medium';

    // 生成描述
    const descriptions = matchedPatterns.map(p => `• ${p.description}`);

    return {
        isDangerous: true,
        risk,
        matchedPatterns,
        description: descriptions.join('\n'),
        command,
    };
}

/**
 * 生成确认请求预览内容
 *
 * @param result 危险检测结果
 * @returns 预览文本（限制长度）
 */
export function generateConfirmationPreview(result: DangerCheckResult): string {
    const maxLen = 200;
    let preview = result.command;

    if (preview.length > maxLen) {
        preview = preview.slice(0, maxLen) + '...';
    }

    return preview;
}

/**
 * 生成完整的确认请求信息
 *
 * @param result 危险检测结果
 * @returns 确认请求对象
 */
export function buildConfirmationRequest(result: DangerCheckResult): {
    title: string;
    description: string;
    preview: string;
    risk: 'high' | 'medium';
} {
    const title = result.risk === 'high'
        ? '⚠️ 高危操作确认'
        : '⚡ 中危操作确认';

    const description = `检测到以下风险操作：\n${result.description}\n\n确认执行吗？`;
    const preview = generateConfirmationPreview(result);

    return {
        title,
        description,
        preview,
        risk: result.risk!,
    };
}
