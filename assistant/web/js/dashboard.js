/**
 * Dashboard Module
 *
 * 仪表盘数据获取和渲染
 * - Token 消耗折线图
 * - 系统状态卡片
 * - 任务概览
 * - 实时日志
 */

// ========== 状态 ==========
let dashboardWs = null;
let isDashboardActive = false;
let logWs = null;
let currentLogCategory = 'all';
let currentLogSearch = '';
let logRefreshInterval = null;

// ========== 工具函数 ==========

function debounce(fn, delay) {
    let timer = null;
    return function (...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), delay);
    };
}

// ========== 初始化 ==========

function initDashboard() {
    // 监听视图切换
    window.addEventListener('view-change', (e) => {
        const view = e.detail;
        if (view === 'observability') {
            isDashboardActive = true;
            loadDashboardData();
        } else {
            isDashboardActive = false;
        }

        if (e.detail === 'logs') {
            loadLogsData();
            connectLogWebSocket();
        } else {
            disconnectLogWebSocket();
        }
    });

    // 绑定日志分类按钮事件
    document.querySelectorAll('#view-logs .space-y-1 button').forEach(btn => {
        btn.addEventListener('click', () => {
            // 高亮当前按钮
            document.querySelectorAll('#view-logs .space-y-1 button')
                .forEach(b => b.classList.remove('bg-oxygen-blue/10', 'text-oxygen-blue'));
            btn.classList.add('bg-oxygen-blue/10', 'text-oxygen-blue');

            // 获取分类
            const text = btn.textContent.trim();
            const categoryMap = {
                '全部日志': 'all',
                '系统日志': 'system',
                'SDK 调用': 'sdk',
                '任务执行': 'task',
                '终端记录': 'terminal'
            };
            currentLogCategory = categoryMap[text] ?? 'all';
            loadLogsData();
        });
    });

    // 绑定日志搜索框事件
    const searchInput = document.querySelector('#view-logs input[placeholder="搜索日志..."]');
    if (searchInput) {
        searchInput.addEventListener('input', debounce((e) => {
            currentLogSearch = e.target.value;
            loadLogsData();
        }, 300));
    }
}

// ========== 仪表盘数据 ==========

async function loadDashboardData() {
    try {
        await Promise.all([
            loadTokenStats(),
            loadSystemStatus(),
            loadTaskOverview(),
        ]);
    } catch (err) {
        console.error('[Dashboard] Failed to load data:', err);
    }
}

async function loadTokenStats() {
    try {
        const data = await api('/api/dashboard/stats');
        if (!data) return;

        // 更新今日概览数字
        const todayCalls = document.querySelector('#view-observability .grid-cols-3 > div:nth-child(1) p.text-2xl');
        const todayTokens = document.querySelector('#view-observability .grid-cols-3 > div:nth-child(2) p.text-2xl');
        const terminals = document.querySelector('#view-observability .grid-cols-3 > div:nth-child(3) p.text-2xl');

        if (todayCalls) todayCalls.textContent = data.today?.calls?.toLocaleString() || '0';
        if (todayTokens) {
            const totalTokens = (data.total?.inputTokens || 0) + (data.total?.outputTokens || 0);
            todayTokens.textContent = totalTokens > 1000 ? (totalTokens / 1000).toFixed(1) + 'k' : totalTokens.toString();
        }

        // 渲染折线图
        renderTokenChart(data.hourly || []);
    } catch (err) {
        console.error('[Dashboard] Failed to load token stats:', err);
    }
}

function renderTokenChart(hourlyData) {
    const container = document.querySelector('#view-observability .h-64.tactile-container .flex-1');
    if (!container) return;

    // 检查是否有数据
    const hasData = hourlyData.length > 0 && hourlyData.some(d => d.inputTokens > 0 || d.outputTokens > 0);

    if (!hasData) {
        container.innerHTML = `
            <div class="flex flex-col items-center justify-center h-full text-slate-400">
                <i data-lucide="bar-chart-2" class="w-10 h-10 mb-2 opacity-50"></i>
                <p class="text-[11px] font-mono">暂无 Token 消耗数据</p>
                <p class="text-[10px] opacity-60 mt-1">开始对话后将显示统计图表</p>
            </div>
        `;
        if (window.lucide) lucide.createIcons();
        return;
    }

    // 准备数据
    const labels = hourlyData.map(d => d.hour);
    const inputData = hourlyData.map(d => d.inputTokens);
    const outputData = hourlyData.map(d => d.outputTokens);

    // 计算最大值用于缩放
    const maxValue = Math.max(...inputData, ...outputData, 1);

    // 生成 SVG 路径
    const width = container.clientWidth || 600;
    const height = container.clientHeight || 200;
    const padding = { top: 20, right: 20, bottom: 30, left: 50 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;

    // 简单的折线路径生成
    function generatePath(data) {
        if (data.length === 0) return '';
        const points = data.map((value, index) => {
            const x = padding.left + (index / (data.length - 1 || 1)) * chartWidth;
            const y = padding.top + chartHeight - (value / maxValue) * chartHeight;
            return `${x},${y}`;
        });
        return `M${points.join(' L')}`;
    }

    // 生成区域填充路径
    function generateAreaPath(data) {
        if (data.length === 0) return '';
        const linePath = generatePath(data);
        const lastX = padding.left + chartWidth;
        const bottomY = padding.top + chartHeight;
        const firstX = padding.left;
        return `${linePath} L${lastX},${bottomY} L${firstX},${bottomY} Z`;
    }

    // 生成 Y 轴刻度
    function generateYAxis() {
        const ticks = 5;
        let html = '';
        for (let i = 0; i <= ticks; i++) {
            const value = Math.round((maxValue / ticks) * i);
            const y = padding.top + chartHeight - (i / ticks) * chartHeight;
            html += `<text x="${padding.left - 10}" y="${y + 4}" text-anchor="end" font-size="10" fill="#94a3b8">${value > 1000 ? (value/1000).toFixed(1) + 'k' : value}</text>`;
            if (i > 0) {
                html += `<line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" stroke="#e2e8f0" stroke-dasharray="2,2"/>`;
            }
        }
        return html;
    }

    // 生成 X 轴标签
    function generateXAxis() {
        let html = '';
        const step = Math.ceil(labels.length / 6);
        labels.forEach((label, index) => {
            if (index % step === 0) {
                const x = padding.left + (index / (labels.length - 1 || 1)) * chartWidth;
                html += `<text x="${x}" y="${height - 5}" text-anchor="middle" font-size="10" fill="#94a3b8">${label}</text>`;
            }
        });
        return html;
    }

    // 构建 SVG
    const svg = `
        <svg width="100%" height="100%" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
            <defs>
                <linearGradient id="inputGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="#7091F5" stop-opacity="0.3"/>
                    <stop offset="100%" stop-color="#7091F5" stop-opacity="0"/>
                </linearGradient>
                <linearGradient id="outputGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="#22c55e" stop-opacity="0.3"/>
                    <stop offset="100%" stop-color="#22c55e" stop-opacity="0"/>
                </linearGradient>
            </defs>
            ${generateYAxis()}
            ${generateXAxis()}
            <path d="${generateAreaPath(inputData)}" fill="url(#inputGradient)"/>
            <path d="${generatePath(inputData)}" fill="none" stroke="#7091F5" stroke-width="2"/>
            <path d="${generateAreaPath(outputData)}" fill="url(#outputGradient)"/>
            <path d="${generatePath(outputData)}" fill="none" stroke="#22c55e" stroke-width="2"/>
        </svg>
    `;

    container.innerHTML = svg;
}

async function loadSystemStatus() {
    try {
        const data = await api('/api/dashboard/system');
        if (!data) return;

        // 更新系统状态卡片
        const runnerStatus = document.querySelector('#view-observability .space-y-3 > div:nth-child(1) span.rounded-full');
        const memoryStatus = document.querySelector('#view-observability .space-y-3 > div:nth-child(2) span.rounded-full');
        const larkStatus = document.querySelector('#view-observability .space-y-3 > div:nth-child(3) span.rounded-full');

        if (runnerStatus && data.runner) {
            // runner.status: 'ok' | 'warn' | 'error'
            // runner.detail: 'idle' | 'X active'
            const isHealthy = data.runner.status === 'ok';
            const statusText = isHealthy ? '正常' : data.runner.status === 'warn' ? '警告' : '异常';
            const colorClass = isHealthy ? 'text-green-600 bg-green-100' :
                              data.runner.status === 'warn' ? 'text-amber-600 bg-amber-100' : 'text-red-600 bg-red-100';
            runnerStatus.textContent = statusText;
            runnerStatus.className = `text-[10px] font-mono ${colorClass} px-2 py-1 rounded-full`;
        }

        if (memoryStatus) {
            memoryStatus.textContent = '正常';
        }

        if (larkStatus && data.lark) {
            const isConnected = data.lark.status === 'ok';
            larkStatus.textContent = isConnected ? '已连接' : '未配置';
            larkStatus.className = isConnected
                ? 'text-[10px] font-mono text-purple-600 bg-purple-100 px-2 py-1 rounded-full'
                : 'text-[10px] font-mono text-slate-400 bg-slate-100 px-2 py-1 rounded-full';
        }

        // 更新终端数
        const terminalCount = document.querySelector('#view-observability .grid-cols-3 > div:nth-child(3) p.text-2xl');
        if (terminalCount && data.terminal) {
            terminalCount.textContent = data.terminal.connected?.toString() || '0';
        }

    } catch (err) {
        console.error('[Dashboard] Failed to load system status:', err);
    }
}

async function loadTaskOverview() {
    try {
        const data = await api('/api/dashboard/tasks');
        if (!data) return;

        // 更新失败列表（如果有的话）
        // 这里可以扩展显示最近失败的任务
    } catch (err) {
        console.error('[Dashboard] Failed to load task overview:', err);
    }
}

// ========== 日志功能 ==========

async function loadLogsData() {
    try {
        const params = new URLSearchParams();
        params.set('limit', '100');
        if (currentLogCategory !== 'all') {
            params.set('category', currentLogCategory);
        }
        if (currentLogSearch) {
            params.set('keyword', currentLogSearch);
        }
        const data = await api(`/api/logs?${params.toString()}`);
        if (!data || !data.success) return;

        renderLogs(data.data || []);
    } catch (err) {
        console.error('[Dashboard] Failed to load logs:', err);
    }
}

function renderLogs(logs) {
    const container = document.querySelector('#view-logs .font-mono');
    if (!container) return;

    if (logs.length === 0) {
        container.innerHTML = `
            <div class="text-center opacity-30 py-8">
                <i data-lucide="scroll-text" class="w-10 h-10 mx-auto mb-3"></i>
                <p class="text-[11px]">暂无日志</p>
            </div>
        `;
        return;
    }

    const html = logs.map(log => {
        const time = new Date(log.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const levelColor = {
            debug: 'text-slate-400',
            info: 'text-blue-500',
            warn: 'text-amber-500',
            error: 'text-red-500',
        }[log.level] || 'text-slate-500';

        return `
            <div class="flex items-start gap-2 py-1 hover:bg-white/50 rounded px-2 -mx-2 transition-colors">
                <span class="text-slate-400 shrink-0">${time}</span>
                <span class="${levelColor} shrink-0 font-bold w-10">${log.level.toUpperCase().slice(0, 4)}</span>
                <span class="text-slate-500 shrink-0 w-16">[${log.category}]</span>
                <span class="text-slate-600 shrink-0 w-24">${log.module}</span>
                <span class="text-slate-700 truncate flex-1">${escapeHtml(log.message)}</span>
            </div>
        `;
    }).join('');

    container.innerHTML = html;
}

function connectLogWebSocket() {
    if (logWs) return;

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const wsUrl = `${proto}://${location.host}/ws/logs`;
    logWs = new WebSocket(wsUrl);

    logWs.onopen = () => {
        console.log('[Dashboard] Log WebSocket connected');
        // 订阅所有分类
        logWs.send(JSON.stringify({
            action: 'subscribe',
            categories: ['system', 'sdk', 'task', 'terminal']
        }));
    };

    logWs.onmessage = (evt) => {
        try {
            const data = JSON.parse(evt.data);
            if (data.type === 'log') {
                appendLog(data.log);
            }
        } catch (err) {
            // 忽略解析错误
        }
    };

    logWs.onerror = (err) => {
        console.error('[Dashboard] Log WebSocket error:', err);
    };

    logWs.onclose = () => {
        logWs = null;
        // 5秒后重连
        setTimeout(() => {
            if (document.querySelector('#view-logs')?.classList.contains('active')) {
                connectLogWebSocket();
            }
        }, 5000);
    };
}

function disconnectLogWebSocket() {
    if (logWs) {
        logWs.close();
        logWs = null;
    }
}

function appendLog(log) {
    const container = document.querySelector('#view-logs .font-mono');
    if (!container) return;

    // 如果不是全部分类，检查过滤
    if (currentLogCategory !== 'all' && log.category !== currentLogCategory) {
        return;
    }

    const time = new Date(log.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const levelColor = {
        debug: 'text-slate-400',
        info: 'text-blue-500',
        warn: 'text-amber-500',
        error: 'text-red-500',
    }[log.level] || 'text-slate-500';

    const logHtml = `
        <div class="flex items-start gap-2 py-1 hover:bg-white/50 rounded px-2 -mx-2 transition-colors animate-fade-in">
            <span class="text-slate-400 shrink-0">${time}</span>
            <span class="${levelColor} shrink-0 font-bold w-10">${log.level.toUpperCase().slice(0, 4)}</span>
            <span class="text-slate-500 shrink-0 w-16">[${log.category}]</span>
            <span class="text-slate-600 shrink-0 w-24">${log.module}</span>
            <span class="text-slate-700 truncate flex-1">${escapeHtml(log.message)}</span>
        </div>
    `;

    // 插入到顶部
    const existing = container.querySelector('.animate-fade-in');
    if (existing) {
        existing.insertAdjacentHTML('beforebegin', logHtml);
    } else {
        container.innerHTML = logHtml + container.innerHTML;
    }

    // 限制数量
    const logs = container.querySelectorAll('.flex.items-start');
    if (logs.length > 500) {
        for (let i = 500; i < logs.length; i++) {
            logs[i].remove();
        }
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ========== 自动刷新 ==========

function startAutoRefresh() {
    if (logRefreshInterval) return;
    logRefreshInterval = setInterval(() => {
        if (document.querySelector('#view-logs')?.classList.contains('active')) {
            loadLogsData();
        }
    }, 5000);
}

function stopAutoRefresh() {
    if (logRefreshInterval) {
        clearInterval(logRefreshInterval);
        logRefreshInterval = null;
    }
}

// ========== 导出 ==========

initDashboard();
