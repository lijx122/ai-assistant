/**
 * Todo 面板管理逻辑
 * 处理任务列表渲染、状态同步和自动执行开关
 */

let currentTodos = [];
let isAutoExecuteEnabled = false;

/**
 * 状态枚举和UI映射
 */
const TODO_STATUS_MAP = {
  pending: { label: '待执行', icon: 'pause-circle', color: 'text-slate-400', bg: 'bg-slate-50' },
  running: { label: '执行中', icon: 'loader-2', color: 'text-oxygen-blue', bg: 'bg-blue-50', animate: 'animate-spin' },
  done:    { label: '已完成', icon: 'check-circle-2', color: 'text-green-500', bg: 'bg-green-50' },
  failed:  { label: '失败', icon: 'alert-circle', color: 'text-red-500', bg: 'bg-red-50' }
};

/**
 * 初始化 Todo 面板
 */
async function initTodos() {
  await fetchTodos();
  
  // 监听工作区切换事件
  window.addEventListener('workspace-change', () => {
    fetchTodos();
  });

  // 页面重新获焦时刷新兜底
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.currentWs) {
      fetchTodos();
    }
  });
}

/**
 * 拉取当前工作区的 Todo 数据
 */
async function fetchTodos() {
  if (!state.currentWs) {
    renderTodos([], false);
    return;
  }
  
  try {
    const res = await api(`/api/todos?workspaceId=${state.currentWs.id}`);
    if (res && !res.error) {
      currentTodos = res.items || [];
      isAutoExecuteEnabled = !!res.autoExecute;
      renderTodos(currentTodos, isAutoExecuteEnabled);
    }
  } catch (err) {
    console.error('[Todos] Failed to fetch:', err);
  }
}

/**
 * 处理 Todo WebSocket 事件推送
 */
function handleTodoWSMessage(msg) {
  if (msg.type === 'todo_updated') {
    // 后端写入更新
    currentTodos = msg.payload.items || [];
    renderTodos(currentTodos, isAutoExecuteEnabled);
  } else if (msg.type === 'auto_execute_changed') {
    // 自动执行开关改变（可能由后端自动关闭）
    isAutoExecuteEnabled = !!msg.payload.enabled;
    updateToggleUI(isAutoExecuteEnabled);
  }
}

/**
 * 切换自动执行状态
 */
async function toggleAutoExecute(checkbox) {
  if (!state.currentWs) {
    checkbox.checked = false;
    return;
  }
  
  const enabled = checkbox.checked;
  try {
    const res = await api('/api/todos/auto-execute', {
      method: 'POST',
      body: { workspaceId: state.currentWs.id, enabled }
    });
    
    if (res && res.success) {
      isAutoExecuteEnabled = res.enabled;
      updateToggleUI(isAutoExecuteEnabled);
    } else {
      // 恢复 UI 状态
      checkbox.checked = !enabled;
    }
  } catch (err) {
    console.error('[Todos] Failed to toggle auto execute:', err);
    checkbox.checked = !enabled;
  }
}

/**
 * 渲染 Todo 列表
 */
function renderTodos(items, autoExecute) {
  const container = document.getElementById('todo-list-container');
  if (!container) return;

  updateToggleUI(autoExecute);

  if (!items || items.length === 0) {
    container.innerHTML = `
      <div class="flex flex-col items-center justify-center opacity-30 py-10">
        <i data-lucide="list-todo" class="w-10 h-10 mb-3"></i>
        <p class="text-[11px] font-mono">暂无任务</p>
      </div>
    `;
    lucide.createIcons();
    return;
  }

  const html = items.map((item, index) => {
    const status = item.status || 'pending';
    const ui = TODO_STATUS_MAP[status] || TODO_STATUS_MAP.pending;
    
    // 生成错误或输出显示区域
    let extraHtml = '';
    if (status === 'failed' && item.error) {
      extraHtml = `<p class="text-[10px] text-red-500 mt-1 mt-1 bg-white/50 p-1.5 rounded">${escapeHtml(item.error)}</p>`;
    } else if (status === 'done' && item.output && item.output !== 'Success') {
      const shortOutput = item.output.length > 100 ? item.output.substring(0, 100) + '...' : item.output;
      extraHtml = `<p class="text-[10px] text-slate-500 mt-1 bg-white/50 p-1.5 rounded truncate" title="输出内容">${escapeHtml(shortOutput)}</p>`;
    }

    return `
      <div class="px-5 py-3 border-b border-slate-100/50 hover:bg-slate-50/50 transition-colors flex gap-3">
        <!-- 状态图标 -->
        <div class="shrink-0 mt-0.5" title="${ui.label}">
          <i data-lucide="${ui.icon}" class="w-4 h-4 ${ui.color} ${ui.animate || ''}"></i>
        </div>
        <!-- 任务内容 -->
        <div class="flex-1 min-w-0">
          <p class="text-[11px] text-slate-700 leading-snug ${status === 'done' ? 'line-through opacity-60' : ''}">${escapeHtml(item.text)}</p>
          ${extraHtml}
        </div>
      </div>
    `;
  }).join('');

  container.innerHTML = html;
  lucide.createIcons();
}

/**
 * 更新开关按钮 UI 状态
 */
function updateToggleUI(enabled) {
  const checkbox = document.getElementById('auto-execute-toggle');
  const statusText = document.getElementById('auto-execute-status-text');
  
  if (checkbox) checkbox.checked = enabled;
  
  if (statusText) {
    if (enabled) {
      statusText.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"></span><span class="text-green-600 font-bold">闭环运行中</span>';
    } else {
      statusText.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-slate-300"></span><span>未开启自动执行</span>';
    }
  }
}

// Ensure init is exported or called by app.js / UI logic
window.initTodos = initTodos;
window.handleTodoWSMessage = handleTodoWSMessage;
window.toggleAutoExecute = toggleAutoExecute;
