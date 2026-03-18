// ─────────────────────────────────────────────
// 定时任务管理
// ─────────────────────────────────────────────

let tasks = []
let selectedTaskId = null
let taskRuns = []
let defaultLarkChatId = null  // 默认飞书 Chat ID

// 加载默认配置
async function loadDefaultConfig() {
  try {
    const cached = window.__PUBLIC_CONFIG__
    const res = cached || await api('/api/config/public')
    if (res && res.larkDefaultChatId) {
      defaultLarkChatId = res.larkDefaultChatId
    }
  } catch (err) {
    console.error('Failed to load default config:', err)
  }
}

// 状态映射
const statusMap = {
  active: { label: '运行中', class: 'bg-green-100 text-green-700' },
  paused: { label: '已暂停', class: 'bg-amber-100 text-amber-700' },
  completed: { label: '已完成', class: 'bg-slate-100 text-slate-600' }
}

const typeMap = {
  cron: 'Cron',
  interval: '间隔',
  once: '一次性'
}

const commandTypeMap = {
  shell: 'Shell',
  assistant: 'AI',
  http: 'HTTP'
}

// 获取当前工作区
function getCurrentWorkspace() {
  return state.currentWs
}

// 加载任务列表
async function loadTasks() {
  const ws = getCurrentWorkspace()
  if (!ws) {
    renderTaskList()
    return
  }

  const res = await api(`/api/tasks?workspaceId=${ws.id}`)
  if (!res || res.error) {
    console.error('Failed to load tasks:', res?.error)
    return
  }

  tasks = res.tasks || []
  renderTaskList()
}

// 渲染任务列表
function renderTaskList() {
  const container = document.getElementById('task-list')
  if (!container) return

  if (tasks.length === 0) {
    container.innerHTML = `
      <div class="text-center opacity-30 py-8">
        <i data-lucide="calendar-clock" class="w-10 h-10 mx-auto mb-3"></i>
        <p class="text-[11px] font-mono">暂无定时任务</p>
        <p class="text-[10px] mt-2">点击 + 创建任务</p>
      </div>
    `
    lucide.createIcons()
    return
  }

  const html = tasks.map(task => {
    const status = statusMap[task.status] || statusMap.paused
    const type = typeMap[task.type] || task.type
    const commandType = commandTypeMap[task.command_type] || task.command_type
    const isSelected = task.id === selectedTaskId

    // 格式化下次执行时间
    let nextRunText = '-'
    if (task.next_run) {
      const next = new Date(task.next_run)
      nextRunText = formatTimeShort(next)
    }

    return `
      <div onclick="selectTask('${task.id}')"
           class="p-3 rounded-2xl cursor-pointer transition-colors ${isSelected ? 'bg-slate-100' : 'hover:bg-slate-50'}">
        <div class="flex items-center justify-between mb-2">
          <span class="font-medium text-sm truncate flex-1">${escapeHtml(task.name)}</span>
          <span class="px-2 py-0.5 rounded-lg text-[10px] font-bold ${status.class}">${status.label}</span>
        </div>
        <div class="flex items-center gap-2 text-[10px] text-slate-500">
          <span class="px-1.5 py-0.5 bg-slate-100 rounded">${type}</span>
          <span class="px-1.5 py-0.5 bg-slate-100 rounded">${commandType}</span>
          <span class="ml-auto">${nextRunText}</span>
        </div>
      </div>
    `
  }).join('')

  container.innerHTML = html
  lucide.createIcons()
}

// 选择任务
async function selectTask(id) {
  selectedTaskId = id
  renderTaskList()
  await loadTaskDetail(id)
  await loadTaskRuns(id)
}

// 加载任务详情
async function loadTaskDetail(id) {
  const task = tasks.find(t => t.id === id)
  if (!task) return

  document.getElementById('task-detail-empty').classList.add('hidden')
  const content = document.getElementById('task-detail-content')
  content.classList.remove('hidden')
  content.classList.add('flex')

  // 基本信息
  document.getElementById('detail-name').textContent = task.name
  document.getElementById('detail-schedule').textContent = formatSchedule(task)

  // 状态
  const statusEl = document.getElementById('detail-status')
  const status = statusMap[task.status] || statusMap.paused
  statusEl.textContent = status.label
  statusEl.className = `px-2 py-1 rounded-lg text-[10px] font-bold ${status.class}`

  // 统计数据
  document.getElementById('detail-run-count').textContent = task.run_count || 0
  document.getElementById('detail-last-run').textContent = task.last_run ? formatTime(new Date(task.last_run)) : '-'
  document.getElementById('detail-next-run').textContent = task.next_run ? formatTime(new Date(task.next_run)) : '-'

  document.getElementById('detail-command').textContent = task.command
  document.getElementById('detail-command-type').textContent = commandTypeMap[task.command_type] || task.command_type

  // 执行历史
  renderTaskRuns()
}

// 加载任务执行记录
async function loadTaskRuns(id) {
  const res = await api(`/api/tasks/${id}/runs`)
  if (!res || res.error) {
    taskRuns = []
    return
  }
  taskRuns = res.runs || []
}

// 渲染执行记录
function renderTaskRuns() {
  const container = document.getElementById('task-runs-list')
  if (!container) return

  if (taskRuns.length === 0) {
    container.innerHTML = '<p class="text-sm text-slate-400 text-center py-4">暂无执行记录</p>'
    return
  }

  const html = taskRuns.slice(0, 10).map(run => {
    const status = run.status === 'success' ? { icon: 'check-circle', color: 'text-green-500' }
      : run.status === 'error' ? { icon: 'x-circle', color: 'text-red-500' }
      : { icon: 'alert-circle', color: 'text-amber-500' }

    return `
      <div class="p-3 bg-slate-50 rounded-xl">
        <div class="flex items-center justify-between mb-1">
          <div class="flex items-center gap-2">
            <i data-lucide="${status.icon}" class="w-4 h-4 ${status.color}"></i>
            <span class="text-xs font-mono">${formatTime(new Date(run.started_at))}</span>
          </div>
          <span class="text-[10px] text-slate-400">
            ${run.ended_at ? Math.round((run.ended_at - run.started_at) / 1000) + 's' : '-'}
          </span>
        </div>
        ${run.output ? `<pre class="text-[10px] text-slate-600 mt-2 overflow-x-auto">${escapeHtml(run.output.substring(0, 200))}</pre>` : ''}
        ${run.error ? `<p class="text-[10px] text-red-500 mt-1">${escapeHtml(run.error)}</p>` : ''}
      </div>
    `
  }).join('')

  container.innerHTML = html
  lucide.createIcons()
}

// 打开任务模态框
function openTaskModal(taskId = null) {
  const modal = document.getElementById('task-modal')
  const title = document.getElementById('task-modal-title')
  const errorEl = document.getElementById('task-modal-error')

  // 清空表单
  document.getElementById('task-id').value = taskId || ''
  document.getElementById('task-name').value = ''
  document.getElementById('task-type').value = 'cron'
  document.getElementById('task-command-type').value = 'shell'
  document.getElementById('task-schedule').value = ''
  document.getElementById('task-command').value = ''
  document.getElementById('task-notify').value = ''
  document.getElementById('task-notify-lark-config').classList.add('hidden')
  document.getElementById('task-alert-on-error').checked = false
  errorEl.classList.add('hidden')
  errorEl.textContent = ''

  // 填充工作区选择
  const wsSelect = document.getElementById('task-workspace')
  if (wsSelect) {
    wsSelect.innerHTML = state.workspaces.map(ws =>
      `<option value="${ws.id}" ${state.currentWs?.id === ws.id ? 'selected' : ''}>${escapeHtml(ws.name)}</option>`
    ).join('')
  }

  // 如果是编辑模式，填充数据
  if (taskId) {
    const task = tasks.find(t => t.id === taskId)
    if (task) {
      title.textContent = '编辑任务'
      document.getElementById('task-name').value = task.name
      document.getElementById('task-type').value = task.type
      document.getElementById('task-command-type').value = task.command_type
      document.getElementById('task-schedule').value = task.schedule
      document.getElementById('task-command').value = task.command
      if (wsSelect) wsSelect.value = task.workspace_id

      if (task.notify_target) {
        const notify = task.notify_target
        if (notify.channel === 'lark') {
          document.getElementById('task-notify').value = 'lark'
          document.getElementById('task-notify-lark-config').classList.remove('hidden')
          document.getElementById('task-notify-chat-id').value = notify.chat_id || ''
        } else {
          document.getElementById('task-notify').value = 'web'
        }
      }

      // 填充告警设置
      document.getElementById('task-alert-on-error').checked = task.alert_on_error === 1 || task.alert_on_error === true
    }
  } else {
    title.textContent = '新建定时任务'
  }

  onTaskTypeChange()
  onTaskCommandTypeChange()
  modal.classList.add('open')
}

// 关闭任务模态框
function closeTaskModal() {
  document.getElementById('task-modal').classList.remove('open')
}

// 任务类型变化
function onTaskTypeChange() {
  const type = document.getElementById('task-type').value
  const label = document.getElementById('task-schedule-label')
  const hint = document.getElementById('task-schedule-hint')
  const input = document.getElementById('task-schedule')

  switch (type) {
    case 'cron':
      label.textContent = 'Cron 表达式 *'
      hint.textContent = '例: 0 2 * * * (每天2点)'
      input.placeholder = '0 2 * * *'
      break
    case 'interval':
      label.textContent = '间隔时间 *'
      hint.textContent = '例: 30m, 2h, 1d'
      input.placeholder = '30m'
      break
    case 'once':
      label.textContent = '执行时间 *'
      hint.textContent = '例: 2026-03-10T14:00:00'
      input.placeholder = '2026-03-10T14:00:00'
      break
  }
}

// 命令类型变化
function onTaskCommandTypeChange() {
  const commandType = document.getElementById('task-command-type').value
  const alertContainer = document.getElementById('task-alert-on-error-container')
  if (commandType === 'shell') {
    alertContainer.classList.remove('hidden')
  } else {
    alertContainer.classList.add('hidden')
  }
}

// 通知类型变化
document.addEventListener('DOMContentLoaded', () => {
  // 加载默认配置
  loadDefaultConfig()

  const notifySelect = document.getElementById('task-notify')
  if (notifySelect) {
    notifySelect.addEventListener('change', (e) => {
      const config = document.getElementById('task-notify-lark-config')
      const chatIdInput = document.getElementById('task-notify-chat-id')
      if (e.target.value === 'lark') {
        config.classList.remove('hidden')
        // 自动填充默认 Chat ID
        if (defaultLarkChatId && chatIdInput && !chatIdInput.value) {
          chatIdInput.value = defaultLarkChatId
        }
      } else {
        config.classList.add('hidden')
      }
    })
  }
})

// 保存任务
async function saveTask() {
  const taskId = document.getElementById('task-id').value
  const errorEl = document.getElementById('task-modal-error')

  const name = document.getElementById('task-name').value.trim()
  const type = document.getElementById('task-type').value
  const commandType = document.getElementById('task-command-type').value
  const schedule = document.getElementById('task-schedule').value.trim()
  const command = document.getElementById('task-command').value.trim()
  const notifyType = document.getElementById('task-notify').value

  // 验证
  if (!name) { errorEl.textContent = '请输入任务名称'; errorEl.classList.remove('hidden'); return }
  if (!schedule) { errorEl.textContent = '请输入调度规则'; errorEl.classList.remove('hidden'); return }
  if (!command) { errorEl.textContent = '请输入命令内容'; errorEl.classList.remove('hidden'); return }

  const workspaceId = document.getElementById('task-workspace').value
  if (!workspaceId) { errorEl.textContent = '请选择工作区'; errorEl.classList.remove('hidden'); return }

  // 构建 notify_target
  let notifyTarget = null
  if (notifyType === 'lark') {
    let chatId = document.getElementById('task-notify-chat-id').value.trim()
    // 如果未填写但有默认值，使用默认 Chat ID
    if (!chatId && defaultLarkChatId) {
      chatId = defaultLarkChatId
      document.getElementById('task-notify-chat-id').value = chatId
    }
    if (!chatId) { errorEl.textContent = '请输入飞书 Chat ID'; errorEl.classList.remove('hidden'); return }
    notifyTarget = { channel: 'lark', chat_id: chatId, is_group: true }
  } else if (notifyType === 'web') {
    notifyTarget = { channel: 'web' }
  }

  const body = {
    workspaceId,
    name,
    type,
    schedule,
    command,
    commandType,
    notifyTarget,
    alertOnError: commandType === 'shell' ? document.getElementById('task-alert-on-error').checked : false
  }

  const path = taskId ? `/api/tasks/${taskId}` : '/api/tasks'
  const method = taskId ? 'PUT' : 'POST'

  const res = await api(path, { method, body })
  if (!res || res.error) {
    errorEl.textContent = res?.error || '保存失败'
    errorEl.classList.remove('hidden')
    return
  }

  closeTaskModal()
  await loadTasks()
  if (taskId) {
    selectTask(taskId)
  }
}

// 触发当前任务
async function triggerCurrentTask() {
  if (!selectedTaskId) return
  const res = await api(`/api/tasks/${selectedTaskId}/trigger`, { method: 'POST' })
  if (res?.success) {
    showToast('任务已触发')
  }
}

// 暂停/恢复当前任务
async function togglePauseCurrentTask() {
  if (!selectedTaskId) return
  const task = tasks.find(t => t.id === selectedTaskId)
  if (!task) return

  const action = task.status === 'active' ? 'pause' : 'resume'
  const res = await api(`/api/tasks/${selectedTaskId}/${action}`, { method: 'POST' })

  if (res?.success) {
    await loadTasks()
    selectTask(selectedTaskId)
  }
}

// 编辑当前任务
function editCurrentTask() {
  if (!selectedTaskId) return
  openTaskModal(selectedTaskId)
}

// 删除当前任务
async function deleteCurrentTask() {
  if (!selectedTaskId) return
  if (!confirm('确定要删除这个任务吗？')) return

  const res = await api(`/api/tasks/${selectedTaskId}`, { method: 'DELETE' })

  // 成功或 404 都从列表移除（404 表示任务已不存在，静默处理）
  const isNotFound = res?.error && (
    res.error.includes('not found') ||
    res.error.includes('不存在') ||
    res.error.includes('404')
  )

  if (res?.success || isNotFound) {
    selectedTaskId = null
    document.getElementById('task-detail-empty').classList.remove('hidden')
    document.getElementById('task-detail-content').classList.add('hidden')
    document.getElementById('task-detail-content').classList.remove('flex')
  } else if (res?.error) {
    // 非 404 错误显示提示
    showToast(res.error)
  }

  // 始终刷新列表，避免显示已删除的任务
  await loadTasks()
}

// 格式化时间
function formatTime(date) {
  return date.toLocaleString('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

// 格式化短时间
function formatTimeShort(date) {
  return date.toLocaleString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit'
  })
}

// 格式化调度规则
function formatSchedule(task) {
  switch (task.type) {
    case 'cron':
      return `Cron: ${task.schedule}`
    case 'interval':
      return `间隔: ${task.schedule}`
    case 'once':
      return `一次性: ${formatTime(new Date(task.schedule))}`
    default:
      return task.schedule
  }
}

// HTML 转义
function escapeHtml(text) {
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}

// Toast 提示（简单实现）
function showToast(msg) {
  const toast = document.createElement('div')
  toast.className = 'fixed bottom-4 right-4 bg-deep-charcoal text-white px-4 py-2 rounded-xl text-sm z-50'
  toast.textContent = msg
  document.body.appendChild(toast)
  setTimeout(() => toast.remove(), 2000)
}

// 切换到定时任务视图时加载
window.addEventListener('view-change', (e) => {
  if (e.detail === 'automation') {
    loadTasks()
  }
})

// 监听工作区变化
window.addEventListener('workspace-change', () => {
  selectedTaskId = null
  loadTasks()
})
