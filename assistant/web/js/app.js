// ─────────────────────────────────────────────
// 初始化
// ─────────────────────────────────────────────
async function loadPublicConfig() {
  try {
    const res = await fetch('/api/config/public', { credentials: 'include' })
    if (!res.ok) return null
    const cfg = await res.json()
    if (typeof window.applyPublicConfig === 'function') {
      window.applyPublicConfig(cfg)
    } else if (cfg?.logs && typeof window.applyLoggingConfig === 'function') {
      window.applyLoggingConfig(cfg.logs)
    }
    return cfg
  } catch (e) {
    return null
  }
}

async function init() {
  // 先加载公共配置（包含前端日志开关）
  await loadPublicConfig()

  const { success } = await safeExecute(async () => {
    devLog('APP', 'init() called')
    // Bug 3 修复：先验证 cookie 是否有效
    try {
      const res = await fetch('/api/auth/me', { credentials: 'include' })
      devLog('APP', 'auth check:', res.status, res.ok)
      if (res.ok) {
        const data = await res.json()
        const user = data.user || data
        devLog('APP', 'user:', user.userId || user.username)
        if (user && (user.userId || user.username)) {
          // cookie 有效，隐藏登录框，加载应用
          $('login-screen').classList.add('hidden')
          $('avatar').textContent = (user.userId || user.username || 'AD').slice(0,2).toUpperCase()
          await loadApp()
          return
        }
      }
    } catch (e) {
      devError('APP', 'Auth check failed:', e)
    }

    // cookie 无效或请求失败，显示登录框
    devLog('APP', 'showing login')
    $('login-screen').classList.remove('hidden')
  }, { context: '初始化失败' })

  if (!success) {
    // 初始化失败也显示登录框
    $('login-screen').classList.remove('hidden')
  }
}

// Bug 3 修复：抽取 loadApp 函数复用
async function loadApp() {
  await loadWorkspaces()
  startStatusPoll()

  // 初始化 todos
  if (typeof initTodos === 'function') {
    initTodos()
  }

  // 恢复上次访问的视图
  const lastView = localStorage.getItem('lastView')
  if (lastView && ['intelligence', 'engineering', 'automation', 'observability', 'logs'].includes(lastView)) {
    sw(lastView)
  }
}

// ─────────────────────────────────────────────
// 登录 / 登出
// ─────────────────────────────────────────────
function showLogin() {
  $('login-screen').classList.remove('hidden')
}

async function doLogin() {
  const user = $('login-user').value.trim()
  const pass = $('login-pass').value
  const err  = $('login-err')
  err.classList.add('hidden')

  const { success } = await safeExecute(async () => {
    await api('/api/auth/login', { method:'POST', body:{ username:user, password:pass } })
    $('login-screen').classList.add('hidden')
    // Bug 3 修复：登录成功后调用 loadApp
    await loadApp()
  }, { context: '登录失败', silent: true }) // silent 因为下面有自定义错误显示

  if (!success) {
    err.textContent = '用户名或密码错误'
    err.classList.remove('hidden')
  }
}

async function doLogout() {
  await api('/api/auth/logout', { method:'POST' })
  // 清理状态
  state.workspaces = []
  state.currentWs = null
  state.sessions = []
  state.currentSession = null
  if (state.ws) {
    state.wsManualClose = true
    state.ws.close()
    state.ws = null
  }
  showLogin()
}

// ─────────────────────────────────────────────
// 工作区
// ─────────────────────────────────────────────
async function loadWorkspaces() {
  await safeExecute(async () => {
    const data = await api('/api/workspaces')
    if (!data) return

    // 字段映射: API 返回 { workspaces: [...] }，每个 workspace 有 id, name, status, created_at, last_active_at
    state.workspaces = data.workspaces || []
    renderWsList()
    const first = state.workspaces.find(w => w.status === 'active') || state.workspaces[0]
    if (first) await selectWorkspace(first)
  }, { context: '加载工作区失败' })
}

function renderWsList() {
  const el = $('ws-list')
  el.innerHTML = state.workspaces.map((w, i) => `
    <div class="ws-item relative group" data-index="${i}">
      <button onclick="selectWorkspaceByIndex(this.closest('.ws-item').dataset.index)" class="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-slate-50 text-left transition-colors ${state.currentWs?.id===w.id?'text-oxygen-blue font-semibold':'opacity-60'}">
        <span class="w-1.5 h-1.5 rounded-full ${w.status==='active'?'bg-green-500':'bg-slate-300'} shrink-0"></span>
        <span class="text-[11px] font-mono truncate flex-1">${w.name}</span>
      </button>
      <button onclick="toggleWsMenu(event, ${i})" class="menu-btn absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-lg hover:bg-slate-100 opacity-0 group-hover:opacity-100 transition-opacity">
        <i data-lucide="more-horizontal" class="w-3.5 h-3.5 opacity-50"></i>
      </button>
      <div id="ws-menu-${i}" class="dropdown-menu">
        <div class="dropdown-item" onclick="renameWorkspace(${i})"><i data-lucide="pencil" class="w-3 h-3"></i>重命名</div>
        <div class="dropdown-item delete" onclick="deleteWorkspace(${i})"><i data-lucide="trash-2" class="w-3 h-3"></i>删除</div>
      </div>
    </div>`).join('')
  lucide.createIcons({ nodes: [el] })
}

function selectWorkspaceByIndex(index) {
  const ws = state.workspaces[parseInt(index)]
  if (ws) checkTerminalsBeforeSwitch(ws)
}

// 工作区切换前检查终端状态
async function checkTerminalsBeforeSwitch(targetWs) {
  // 如果没有当前工作区，直接切换
  if (!state.currentWs) {
    await executeWorkspaceSwitch(targetWs)
    return
  }

  // 获取当前工作区的终端
  const currentTerminals = state.terminals.filter(t => t.workspaceId === state.currentWs.id)

  // 无终端，直接切换
  if (currentTerminals.length === 0) {
    await executeWorkspaceSwitch(targetWs)
    return
  }

  // 检查是否有活跃终端（10分钟内有活动）
  const TEN_MINUTES = 10 * 60 * 1000
  const now = Date.now()
  const hasActiveTerminals = currentTerminals.some(t => {
    const lastActive = t.lastActiveAt || t.createdAt || 0
    return (now - lastActive) < TEN_MINUTES
  })

  // 如果没有活跃终端（全部超过10分钟无活动），直接切换（后台保留）
  if (!hasActiveTerminals) {
    // 标记这些终端为断开状态（后台保留）
    currentTerminals.forEach(t => {
      if (t.ws) {
        t.ws.close()
        t.disconnectedAt = now
      }
    })
    await executeWorkspaceSwitch(targetWs)
    return
  }

  // 有活跃终端，弹窗询问
  pendingWorkspaceSwitch = targetWs
  $('terminal-switch-count').textContent = currentTerminals.length
  $('terminal-switch-msg').innerHTML = `当前工作区有 <span class="font-bold text-amber-600">${currentTerminals.length}</span> 个活跃终端，切换后如何处理？`
  $('terminal-switch-modal').classList.add('open')
  lucide.createIcons()
}

// 取消切换
function cancelTerminalSwitch() {
  $('terminal-switch-modal').classList.remove('open')
  pendingWorkspaceSwitch = null
}

// 后台保留并切换
async function keepTerminalsAndSwitch() {
  const targetWs = pendingWorkspaceSwitch
  if (!targetWs) return

  // 关闭当前工作区的 WebSocket 连接（但保留 PTY 进程）
  const currentTerminals = state.terminals.filter(t => t.workspaceId === state.currentWs?.id)
  currentTerminals.forEach(t => {
    if (t.ws) {
      t.ws.close()
      t.disconnectedAt = Date.now()
    }
  })

  $('terminal-switch-modal').classList.remove('open')
  pendingWorkspaceSwitch = null
  await executeWorkspaceSwitch(targetWs)
}

// 关闭全部终端并切换
async function closeAllTerminalsAndSwitch() {
  const targetWs = pendingWorkspaceSwitch
  if (!targetWs) return

  // 关闭当前工作区的所有终端
  const currentTerminals = state.terminals.filter(t => t.workspaceId === state.currentWs?.id)
  for (const t of currentTerminals) {
    await safeExecute(() => closeTerminal(t.id), { silent: true })
  }

  $('terminal-switch-modal').classList.remove('open')
  pendingWorkspaceSwitch = null
  await executeWorkspaceSwitch(targetWs)
}

// 执行实际的工作区切换
async function executeWorkspaceSwitch(ws) {
  await safeExecute(async () => {
    devLog('APP', 'switchWorkspace', ws.id, ws.name)
    state.currentWs = ws
    $('ws-name').textContent = ws.name
    $('ws-name-sidebar').textContent = ws.name
    $('mobile-ws-name').textContent = ws.name
    $('ws-picker').classList.add('hidden')
    renderWsList()

    // 断开旧 WebSocket（标记为主动关闭，不重连）
    devLog('APP', 'disconnecting old WS')
    if (state.ws) {
      state.wsManualClose = true
      state.ws.onclose = null  // 移除 onclose 避免触发重连
      state.ws.close()
      state.ws = null
    }

    await loadSessions()
    devLog('APP', 'connecting WS after loadSessions')
    connectWS()
    // 恢复该工作区的终端会话
    await restoreTerminals(ws.id)
    // 初始化文件树状态并加载
    state.treeNodes.clear()
    state.expandedPaths = new Set(['.'])
    await loadFileTree()

    // 触发工作区切换事件
    window.dispatchEvent(new CustomEvent('workspace-change'))
  }, { context: '切换工作区失败' })
}

// 保留旧的 selectWorkspace 函数作为兼容（内部调用新的逻辑）
async function selectWorkspace(ws) {
  await checkTerminalsBeforeSwitch(ws)
}

function toggleWsPicker() {
  const picker = $('ws-picker')
  const isHidden = picker.classList.contains('hidden')

  if (isHidden) {
    // 计算坐标
    const btn = $('ws-switcher').getBoundingClientRect()
    picker.style.top = (btn.bottom + 8) + 'px'
    picker.style.left = btn.left + 'px'
    picker.classList.remove('hidden')
  } else {
    picker.classList.add('hidden')
  }

  // 关闭所有菜单
  document.querySelectorAll('.dropdown-menu').forEach(m => m.classList.remove('open'))
}

function showNewWs() {
  $('new-ws-name').value = ''
  $('new-ws-desc').value = ''
  $('new-ws-err').classList.add('hidden')
  $('new-ws-modal').classList.add('open')
  $('new-ws-name').focus()
}

function closeNewWsModal() {
  $('new-ws-modal').classList.remove('open')
}

async function doCreateWorkspace() {
  const name = $('new-ws-name').value.trim()
  const desc = $('new-ws-desc').value.trim()
  const err = $('new-ws-err')

  if (!name) {
    err.textContent = '请输入工作区名称'
    err.classList.remove('hidden')
    return
  }

  const { success } = await safeExecute(async () => {
    await api('/api/workspaces', { method: 'POST', body: { name, description: desc } })
    closeNewWsModal()
    await loadWorkspaces()
  }, { context: '创建工作区失败', silent: true })

  if (!success) {
    err.textContent = '创建失败，请重试'
    err.classList.remove('hidden')
  }
}

// 工作区菜单控制
function toggleWsMenu(event, index) {
  event.stopPropagation()
  const menu = $(`ws-menu-${index}`)
  const isOpen = menu.classList.contains('open')
  // 关闭所有菜单
  document.querySelectorAll('.dropdown-menu').forEach(m => m.classList.remove('open'))
  // 切换当前菜单
  if (!isOpen) {
    menu.classList.add('open')
    lucide.createIcons({ nodes: [menu] })
  }
}

async function renameWorkspace(index) {
  const ws = state.workspaces[index]
  if (!ws) return
  const newName = prompt('重命名工作区：', ws.name)
  if (!newName || newName === ws.name) return

  await safeExecute(async () => {
    await api(`/api/workspaces/${ws.id}`, { method: 'PUT', body: { name: newName } })
    await loadWorkspaces()
  }, { context: '重命名工作区失败' })
}

async function deleteWorkspace(index) {
  const ws = state.workspaces[index]
  if (!ws) return

  // 检查是否为当前工作区
  if (state.currentWs?.id === ws.id) {
    alert('请先切换到其他工作区')
    return
  }

  if (!confirm(`确定要删除工作区「${ws.name}」吗？此操作不可恢复。`)) return

  await safeExecute(async () => {
    await api(`/api/workspaces/${ws.id}`, { method: 'DELETE' })
    await loadWorkspaces()
  }, { context: '删除工作区失败' })
}

// 会话菜单控制
function toggleSessionMenu(event, index) {
  event.stopPropagation()
  const menu = $(`session-menu-${index}`)
  const isOpen = menu.classList.contains('open')
  // 关闭所有菜单
  document.querySelectorAll('.dropdown-menu').forEach(m => m.classList.remove('open'))
  // 切换当前菜单
  if (!isOpen) {
    menu.classList.add('open')
    lucide.createIcons({ nodes: [menu] })
  }
}

async function renameSession(index) {
  const s = state.sessions[index]
  if (!s) return
  const currentTitle = s.title || s.firstMessage?.slice(0,20) || '新建对话'
  const newTitle = prompt('重命名会话：', currentTitle)
  if (!newTitle || newTitle === currentTitle) return

  await safeExecute(async () => {
    await api(`/api/sessions/${s.id}`, { method: 'PUT', body: { title: newTitle } })
    await loadSessions()
  }, { context: '重命名会话失败' })
}

async function deleteSession(index) {
  const s = state.sessions[index]
  if (!s) return

  if (!confirm('确定要删除此会话吗？相关消息记录将被永久删除。')) return

  await safeExecute(async () => {
    await api(`/api/sessions/${s.id}`, { method: 'DELETE' })
    // 如果删除的是当前会话，清空当前会话
    if (state.currentSession?.id === s.id) {
      state.currentSession = null
      state.messages = []
      clearMessages()
    }
    await loadSessions()
  }, { context: '删除会话失败' })
}

// 点击外部关闭菜单
document.addEventListener('click', e => {
  if (!e.target.closest('.dropdown-menu') && !e.target.closest('.menu-btn')) {
    document.querySelectorAll('.dropdown-menu').forEach(m => m.classList.remove('open'))
  }
  if (!e.target.closest('#ws-switcher')) $('ws-picker')?.classList.add('hidden')
  if (!e.target.closest('#new-ws-modal') && $('new-ws-modal')?.classList.contains('open')) {
    // 点击 modal 外部不关闭，只能通过取消按钮
  }
})

// Modal 键盘事件
$('new-ws-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('new-ws-desc').focus()
})
$('new-ws-desc').addEventListener('keydown', e => {
  if (e.key === 'Enter') doCreateWorkspace()
  if (e.key === 'Escape') closeNewWsModal()
})

// ─────────────────────────────────────────────
// 会话
// ─────────────────────────────────────────────
async function loadSessions() {
  await safeExecute(async () => {
    devLog('APP', 'loadSessions, workspace:', state.currentWs?.id)
    devLog('APP', 'stack:', new Error().stack.split('\n').slice(1, 3).join(' | '))
    if (!state.currentWs) return
    const data = await api(`/api/sessions?workspaceId=${state.currentWs.id}`)
    if (!data) return
    // 字段映射: API 返回 { sessions: [...] }，每个 session 有 id, started_at(映射为createdAt), messageCount, firstMessage
    state.sessions = data.sessions || []
    renderSessionList()
    // 选最新一个
    if (state.sessions.length > 0 && !state.currentSession) {
      await selectSession(state.sessions[0])
    } else if (state.sessions.length === 0) {
      await newSession()
    }
  }, { context: '加载会话失败' })
}

function renderSessionList() {
  safeExecuteSync(() => {
    const el = $('session-list')
    if (state.sessions.length === 0) {
      el.innerHTML = '<p class="text-[10px] font-mono opacity-30 text-center py-4">暂无会话</p>'
      return
    }
    el.innerHTML = state.sessions.map((s, i) => {
      // 字段映射: firstMessage 取前20字作为标题，createdAt 是 started_at 的别名
      const title = s.title || s.firstMessage?.slice(0,20) || '新建对话'
      const date  = fmtDate(s.createdAt)
      const turns = s.messageCount ? Math.floor(s.messageCount/2) : 0
      const active = state.currentSession?.id === s.id
      const isLark = s.channel === 'lark'
      return `
      <div data-index="${i}" class="session-item relative group ${active?'active':''} px-3 py-3 rounded-2xl">
        <div onclick="selectSessionByIndex(this.closest('.session-item').dataset.index)" class="cursor-pointer">
          <div class="flex items-start justify-between gap-1 mb-1">
            <div class="flex items-center gap-1.5 flex-1 min-w-0">
              <p class="text-[11px] font-semibold leading-tight truncate ${active?'':'opacity-60'}">${escHtml(title)}</p>
              ${isLark ? `<span class="shrink-0 px-1 py-0.5 bg-blue-50 text-blue-500 rounded text-[8px] font-bold" title="飞书会话">飞书</span>` : ''}
            </div>
            <span class="text-[8px] font-mono opacity-30 shrink-0 mt-0.5">${date}</span>
          </div>
          ${turns ? `<span class="text-[8px] font-mono opacity-20 mt-1 block">${turns} 轮</span>` : ''}
        </div>
        <button onclick="toggleSessionMenu(event, ${i})" class="menu-btn absolute right-2 top-2 p-1.5 rounded-lg hover:bg-slate-100 opacity-0 group-hover:opacity-100 transition-opacity">
          <i data-lucide="more-horizontal" class="w-3.5 h-3.5 opacity-50"></i>
        </button>
        <div id="session-menu-${i}" class="dropdown-menu">
          <div class="dropdown-item" onclick="renameSession(${i})"><i data-lucide="pencil" class="w-3 h-3"></i>重命名</div>
          <div class="dropdown-item delete" onclick="deleteSession(${i})"><i data-lucide="trash-2" class="w-3 h-3"></i>删除</div>
        </div>
      </div>`
    }).join('')
    lucide.createIcons({ nodes: [el] })
  }, { context: '渲染会话列表失败', silent: true }) // silent 因为这不是用户直接触发的操作
}

function selectSessionByIndex(index) {
  const s = state.sessions[parseInt(index)]
  if (s) selectSession(s)
}

async function selectSession(s) {
  state.currentSession = s
  state.messages = []
  state.ctxTurns = 0
  renderSessionList()
  updateInputState() // 根据 channel 更新输入框状态
  await loadHistory()
}

async function newSession() {
  await safeExecute(async () => {
    if (!state.currentWs) return
    const data = await api('/api/sessions', { method:'POST', body:{ workspaceId:state.currentWs.id } })
    if (!data) return
    // 字段映射: API 返回 { success, session: { id, createdAt, messageCount, firstMessage } }
    const sess = data.session || data
    state.sessions.unshift(sess)
    await selectSession(sess)
    $('chat-input').focus()
  }, { context: '创建会话失败' })
}

async function loadHistory() {
  await safeExecute(async () => {
    if (!state.currentSession) return
    const data = await api(`/api/sessions/${state.currentSession.id}/messages`)
    if (!data) return
    // Bug Fix: API 返回 { messages: [...], compacts: [...] }
    const msgs = data.messages || []
    const compacts = data.compacts || []
    state.messages = []
    // 清空并重渲染
    clearMessages()

    // Bug Fix: 遍历所有 compact 记录，在正确位置插入多条分隔线
    let compactIndex = 0
    for (const m of msgs) {
      // 在当前消息前插入所有时间早于该消息的 compact 分隔线
      while (
        compactIndex < compacts.length &&
        m.created_at > compacts[compactIndex].compacted_at
      ) {
        renderCompactDivider(compacts[compactIndex])
        compactIndex++
      }
      const el = appendMessage({ role: m.role, content: m.content, id: m.id, status: m.status })
      if (el) {
        state.messages.push({ role: m.role, content: m.content, id: m.id, status: m.status })
      }
    }
    // 处理末尾还未插入的 compact（最后几条 compact 之后没有新消息的情况）
    while (compactIndex < compacts.length) {
      renderCompactDivider(compacts[compactIndex])
      compactIndex++
    }

    state.ctxTurns = Math.floor(msgs.length / 2)
    $('ctx-turns').textContent = `上下文: ${state.ctxTurns} / 20 轮`
    scrollToBottom()
  }, { context: '加载历史消息失败' })
}

// 根据当前会话 channel 更新输入框状态（飞书会话禁用输入）
function updateInputState() {
  const input = $('chat-input')
  const sendBtn = input?.closest('#chat-input-area')?.querySelector('button[onclick="sendMessage()"]')
  const fileBtn = input?.closest('#chat-input-area')?.querySelector('button[title="上传文件"]')
  const larkNotice = $('lark-notice')
  const isLark = state.currentSession?.channel === 'lark'

  if (!input) return

  if (isLark) {
    input.disabled = true
    input.placeholder = '此会话来自飞书，请在飞书中继续对话'
    input.classList.add('cursor-not-allowed', 'opacity-60')
    if (sendBtn) {
      sendBtn.disabled = true
      sendBtn.classList.add('opacity-40', 'cursor-not-allowed')
    }
    if (fileBtn) {
      fileBtn.disabled = true
      fileBtn.classList.add('opacity-40', 'cursor-not-allowed')
    }
    if (larkNotice) {
      larkNotice.classList.remove('hidden')
      lucide.createIcons({ nodes: [larkNotice] })
    }
  } else {
    input.disabled = false
    input.placeholder = '向 Claude 下达指令… 输入 / 查看命令\n支持拖拽文件到此处\nShift+Enter 换行'
    input.classList.remove('cursor-not-allowed', 'opacity-60')
    if (sendBtn) {
      sendBtn.disabled = false
      sendBtn.classList.remove('opacity-40', 'cursor-not-allowed')
    }
    if (fileBtn) {
      fileBtn.disabled = false
      fileBtn.classList.remove('opacity-40', 'cursor-not-allowed')
    }
    if (larkNotice) {
      larkNotice.classList.add('hidden')
    }
  }
}

// ─────────────────────────────────────────────
// 视图切换
// ─────────────────────────────────────────────
function sw(id) {
  // 关闭移动端侧边栏
  closeMobileSidebar()
  closeMobileChatSidebar()

  document.querySelectorAll('.view-content').forEach(v => v.classList.remove('active'))
  document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'))
  const v = document.getElementById('view-'+id); if(v) v.classList.add('active')
  const n = document.getElementById('nav-'+id);  if(n) n.classList.add('active')
  const tints = { engineering:'#131316', automation:'#F0F0F2', logs:'#F5F5F7' }
  document.body.style.backgroundColor = tints[id] || '#F8F9FA'

  // 切换到工程化视图时初始化拖拽分割线
  if (id === 'engineering') {
    // 延迟到视图渲染完成后执行
    setTimeout(() => initEditorTerminalDivider(), 0)
  }

  // 触发视图变化事件
  window.dispatchEvent(new CustomEvent('view-change', { detail: id }))

  // 保存当前视图到 localStorage
  localStorage.setItem('lastView', id)
}

function toggleTool(header) {
  const body = header.nextElementSibling
  const ch   = header.querySelector('.tool-chevron')
  body?.classList.toggle('open')
  ch?.classList.toggle('open')
}

// ─────────────────────────────────────────────
// 移动端侧边栏控制
// ─────────────────────────────────────────────
function toggleMobileSidebar() {
  const sidebar = document.querySelector('.sidebar-nav')
  const overlay = document.querySelector('.sidebar-overlay')
  sidebar.classList.toggle('open')
  overlay.classList.toggle('open')
}

function closeMobileSidebar() {
  const sidebar = document.querySelector('.sidebar-nav')
  const overlay = document.querySelector('.sidebar-overlay')
  sidebar.classList.remove('open')
  overlay.classList.remove('open')
}

function toggleMobileChatSidebar() {
  const sidebar = document.querySelector('.chat-sidebar')
  const overlay = document.querySelector('.chat-sidebar-overlay')
  sidebar.classList.toggle('open')
  overlay.style.display = sidebar.classList.contains('open') ? 'block' : 'none'
}

function closeMobileChatSidebar() {
  const sidebar = document.querySelector('.chat-sidebar')
  const overlay = document.querySelector('.chat-sidebar-overlay')
  sidebar.classList.remove('open')
  overlay.style.display = 'none'
}

// ─────────────────────────────────────────────
// 系统状态轮询
// ─────────────────────────────────────────────
async function pollStatus() {
  try {
    const data = await api('/api/dashboard/system')
    if (!data) return
    setPill('pill-runner', data.runner)
    setPill('pill-memory', data.memory)
    setPill('pill-lark',   data.lark)
    $('runner-detail').textContent = data.runner?.detail || '—'
  } catch {}
}

function setPill(id, svc) {
  const el = $(id)
  if (!el) return
  const dot = el.querySelector('span')
  const colors = { ok:'bg-green-500', warn:'bg-yellow-400', error:'bg-red-400' }
  const c = colors[svc?.status] || 'bg-slate-300'
  if (dot) dot.className = `w-1.5 h-1.5 rounded-full ${c} inline-block`
}

function startStatusPoll() {
  pollStatus()
  setInterval(pollStatus, 15000)
}

// 启动
$('login-pass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin() })
