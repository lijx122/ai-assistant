// ─────────────────────────────────────────────
// 终端功能 (T-3.2 + T-3.5 持久化)
// ─────────────────────────────────────────────

// 恢复工作区的终端会话（页面加载时调用）
async function restoreTerminals(workspaceId) {
  try {
    const res = await api(`/api/terminal?workspaceId=${workspaceId}`)
    if (!res.terminals || res.terminals.length === 0) return

    devLog('TERM', `Restoring ${res.terminals.length} terminal(s) for workspace ${workspaceId}`)

    for (const termData of res.terminals) {
      // 跳过已关闭的终端
      if (termData.closedAt) continue

      // 检查是否已存在（避免重复）
      if (state.terminals.find(t => t.id === termData.id)) continue

      // 初始化终端（重建 WS 连接）
      const term = await initTerminal(termData)
      state.terminals.push(term)
    }

    // 如果有恢复的终端，选中第一个
    if (state.terminals.length > 0 && !state.currentTerminal) {
      state.currentTerminal = state.terminals[0].id
    }

    renderTerminalTabs()
    updateTerminalUI()
  } catch (err) {
    devError('TERM', 'Failed to restore terminals:', err)
  }
}

async function createNewTerminal() {
  if (!state.currentWs) {
    alert('请先选择工作区')
    return
  }
  if (state.terminals.length >= state.maxTerminals) {
    alert(`最多只能创建 ${state.maxTerminals} 个终端`)
    return
  }

  try {
    const res = await api('/api/terminal', {
      method: 'POST',
      body: { workspaceId: state.currentWs.id }
    })

    if (res.terminal) {
      // 添加 workspaceId 到终端数据
      const termData = { ...res.terminal, workspaceId: state.currentWs.id }
      const term = await initTerminal(termData)
      state.terminals.push(term)
      state.currentTerminal = term.id
      renderTerminalTabs()
      updateTerminalUI()
    }
  } catch (err) {
    devError('TERM', 'Failed to create terminal:', err)
    alert(err.message || '创建终端失败')
  }
}

async function initTerminal(terminalData) {
  const { id, title, cwd, pid, workspaceId, lastActiveAt, createdAt } = terminalData

  // 创建终端容器
  const container = document.createElement('div')
  container.id = `terminal-${id}`
  container.className = 'absolute inset-0'
  container.style.display = 'none'

  const termDiv = document.createElement('div')
  termDiv.className = 'w-full h-full'
  container.appendChild(termDiv)

  $('terminal-container').appendChild(container)

  // 创建 xterm 实例
  const term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: 'JetBrains Mono, monospace',
    theme: {
      background: '#1a1a1a',
      foreground: '#e0e0e0',
      cursor: '#7091F5',
      selectionBackground: '#7091F550',
      black: '#2d2d2d',
      red: '#e06c75',
      green: '#98c379',
      yellow: '#e5c07b',
      blue: '#7091F5',
      magenta: '#c678dd',
      cyan: '#56b6c2',
      white: '#d0d0d0'
    },
    scrollback: 10000
  })

  // 添加 fit 插件
  const fitAddon = new FitAddon.FitAddon()
  term.loadAddon(fitAddon)

  // 挂载终端
  term.open(termDiv)
  fitAddon.fit()

  // 连接 WebSocket
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const ws = new WebSocket(`${proto}://${location.host}/ws/terminal/${id}`)

  ws.onopen = () => {
    devLog('TERM', `Connected: ${id}`)
    updateTerminalStatus('connected', pid)
  }

  ws.onmessage = (e) => {
    term.write(e.data)
  }

  ws.onclose = () => {
    devLog('TERM', `Disconnected: ${id}`)
    term.write('\r\n\x1b[31m[连接已断开]\x1b[0m\r\n')
    updateTerminalStatus('disconnected')
  }

  ws.onerror = (err) => {
    devError('TERM', `Error: ${id}`, err)
  }

  // 用户输入发送到后端
  term.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data)
    }
  })

  // 窗口大小变化时发送 resize 消息
  term.onResize(({ cols, rows }) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', cols, rows }))
    }
  })

  // 监听容器大小变化
  const resizeObserver = new ResizeObserver(() => {
    fitAddon.fit()
  })
  resizeObserver.observe(container)

  // 显示空状态或当前终端
  $('terminal-empty').style.display = 'none'
  container.style.display = 'block'

  return {
    id,
    title,
    cwd,
    pid,
    workspaceId: workspaceId || state.currentWs?.id,
    lastActiveAt: lastActiveAt || createdAt || Date.now(),
    createdAt: createdAt || Date.now(),
    ws,
    xterm: term,
    fitAddon,
    container,
    resizeObserver
  }
}

function switchTerminal(id) {
  if (state.currentTerminal === id) return

  // 隐藏当前终端
  if (state.currentTerminal) {
    const current = state.terminals.find(t => t.id === state.currentTerminal)
    if (current) {
      current.container.style.display = 'none'
    }
  }

  // 显示新终端
  const target = state.terminals.find(t => t.id === id)
  if (target) {
    target.container.style.display = 'block'
    target.fitAddon.fit()
    state.currentTerminal = id
    updateTerminalStatus('connected', target.pid, target.cwd)
  }

  renderTerminalTabs()
}

async function closeTerminal(id) {
  const idx = state.terminals.findIndex(t => t.id === id)
  if (idx === -1) return

  const term = state.terminals[idx]

  // 关闭 WebSocket
  if (term.ws) {
    term.ws.close()
  }

  // 销毁 xterm
  term.xterm.dispose()

  // 停止监听大小变化
  term.resizeObserver.disconnect()

  // 移除 DOM
  term.container.remove()

  // 从数组移除
  state.terminals.splice(idx, 1)

  // 如果关闭的是当前终端，切换到其他终端
  if (state.currentTerminal === id) {
    state.currentTerminal = state.terminals.length > 0 ? state.terminals[0].id : null
    if (state.currentTerminal) {
      const next = state.terminals.find(t => t.id === state.currentTerminal)
      next.container.style.display = 'block'
      next.fitAddon.fit()
      updateTerminalStatus('connected', next.pid, next.cwd)
    } else {
      $('terminal-empty').style.display = 'flex'
      updateTerminalStatus('idle')
    }
  }

  renderTerminalTabs()
  updateTerminalUI()

  // 通知后端关闭
  try {
    await api(`/api/terminal/${id}`, { method: 'DELETE' })
  } catch (err) {
    devError('TERM', 'Failed to close terminal on server:', err)
  }
}

function renderTerminalTabs() {
  const container = $('terminal-tabs')
  container.innerHTML = ''

  state.terminals.forEach(term => {
    const isActive = term.id === state.currentTerminal
    const tab = document.createElement('div')
    tab.className = `terminal-tab flex items-center gap-2 px-3 py-2 rounded-xl text-[11px] font-medium ${isActive ? 'active' : 'bg-white/40'}`
    tab.onclick = (e) => {
      if (e.target.closest('.close-btn')) return
      switchTerminal(term.id)
    }

    const icon = document.createElement('i')
    icon.setAttribute('data-lucide', 'terminal')
    icon.className = 'w-3.5 h-3.5 opacity-60'

    const title = document.createElement('span')
    title.textContent = term.title
    title.className = 'truncate max-w-[80px]'

    const closeBtn = document.createElement('button')
    closeBtn.className = 'close-btn ml-1 p-0.5 rounded hover:bg-slate-200/50'
    closeBtn.innerHTML = '<i data-lucide="x" class="w-3 h-3"></i>'
    closeBtn.onclick = () => closeTerminal(term.id)

    tab.appendChild(icon)
    tab.appendChild(title)
    tab.appendChild(closeBtn)
    container.appendChild(tab)
  })

  lucide.createIcons()
}

function updateTerminalUI() {
  const btn = $('new-terminal-btn')
  const count = $('terminal-count')

  // 更新新建按钮状态
  if (state.terminals.length >= state.maxTerminals) {
    btn.disabled = true
    btn.classList.add('opacity-50', 'cursor-not-allowed')
  } else {
    btn.disabled = false
    btn.classList.remove('opacity-50', 'cursor-not-allowed')
  }

  // 更新计数
  count.textContent = `${state.terminals.length} / ${state.maxTerminals}`
}

function updateTerminalStatus(status, pid, cwd) {
  const statusEl = $('terminal-status')
  const cwdEl = $('terminal-cwd')
  const clearBtn = $('clear-terminal-btn')

  if (status === 'connected') {
    statusEl.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-green-500 dot-pulse"></span>已连接'
    statusEl.classList.remove('opacity-50')
    statusEl.classList.add('text-green-600')
    if (clearBtn) clearBtn.classList.remove('hidden')
  } else if (status === 'disconnected') {
    statusEl.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-red-400"></span>已断开'
    statusEl.classList.remove('text-green-600')
    statusEl.classList.add('text-red-500')
    if (clearBtn) clearBtn.classList.add('hidden')
  } else {
    statusEl.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-slate-300"></span>未连接'
    statusEl.classList.remove('text-green-600', 'text-red-500')
    statusEl.classList.add('opacity-50')
    if (clearBtn) clearBtn.classList.add('hidden')
  }

  if (cwd) {
    cwdEl.textContent = cwd
    cwdEl.title = cwd
  } else {
    cwdEl.textContent = '—'
  }
}

// 清屏当前终端
function clearCurrentTerminal() {
  if (!state.currentTerminal) return
  const term = state.terminals.find(t => t.id === state.currentTerminal)
  if (term && term.xterm) {
    term.xterm.clear()
  }
}

// ─────────────────────────────────────────────
// 编辑器-终端拖拽分割线
// ─────────────────────────────────────────────

function initEditorTerminalDivider() {
  const divider = document.getElementById('editor-terminal-divider')
  const editorPanel = document.getElementById('editor-panel')
  const terminalPanel = document.getElementById('terminal-panel')
  const container = document.getElementById('editor-terminal-container')

  if (!divider || !editorPanel || !terminalPanel || !container) return

  // 先把初始值设为 px（必须在容器已渲染后调用）
  const containerRect = container.getBoundingClientRect()
  let editorRatio = 0.65  // 记录当前比例，用于窗口 resize 时保持比例

  if (containerRect.height > 0) {
    const dividerHeight = 6
    const totalH = containerRect.height - dividerHeight
    editorPanel.style.flexBasis = Math.floor(totalH * editorRatio) + 'px'
    terminalPanel.style.flexBasis = Math.floor(totalH * (1 - editorRatio)) + 'px'
  }

  let isDragging = false

  divider.addEventListener('mousedown', (e) => {
    isDragging = true
    divider.classList.add('dragging')
    e.preventDefault()

    // 添加全屏透明遮罩，防止编辑器/终端拦截鼠标事件
    const overlay = document.createElement('div')
    overlay.id = 'drag-overlay'
    overlay.style.cssText = `
      position: fixed; inset: 0; z-index: 9999;
      cursor: row-resize;
    `
    document.body.appendChild(overlay)
  })

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return

    const rect = container.getBoundingClientRect()
    const dividerHeight = 6  // 分割线高度
    const totalHeight = rect.height - dividerHeight

    // 计算像素值
    let editorHeight = e.clientY - rect.top

    // 限制最小高度 120px
    editorHeight = Math.min(
      Math.max(editorHeight, 120),
      totalHeight - 120
    )
    const terminalHeight = totalHeight - editorHeight

    // 改用 px 而不是 %
    editorPanel.style.flexBasis = editorHeight + 'px'
    terminalPanel.style.flexBasis = terminalHeight + 'px'

    // 通知 Monaco 重新计算尺寸
    if (state.editor) {
      state.editor.layout()
    }

    // 通知 xterm 重新计算尺寸
    state.terminals.forEach(term => {
      if (term.fitAddon) {
        term.fitAddon.fit()
      }
    })
  })

  document.addEventListener('mouseup', () => {
    if (!isDragging) return
    isDragging = false
    divider.classList.remove('dragging')

    // 移除遮罩
    document.getElementById('drag-overlay')?.remove()

    // 记录当前比例
    const rect = container.getBoundingClientRect()
    const dividerHeight = 6
    const totalHeight = rect.height - dividerHeight
    const editorHeight = parseInt(editorPanel.style.flexBasis) || Math.floor(totalHeight * 0.65)
    editorRatio = editorHeight / totalHeight

    // 拖拽结束后重新触发 Monaco layout 和 xterm fit
    if (state.editor) {
      state.editor.layout()
    }
    state.terminals.forEach(term => {
      if (term.fitAddon) {
        term.fitAddon.fit()
      }
    })
  })

  // ResizeObserver：容器大小变化时保持比例
  const resizeObserver = new ResizeObserver((entries) => {
    if (isDragging) return // 拖拽时不处理

    const entry = entries[0]
    if (!entry) return

    const newHeight = entry.contentRect.height
    const dividerHeight = 6
    const totalHeight = newHeight - dividerHeight

    if (totalHeight <= 0) return

    // 按比例重新计算高度
    const editorHeight = Math.min(
      Math.max(Math.floor(totalHeight * editorRatio), 120),
      totalHeight - 120
    )
    const terminalHeight = totalHeight - editorHeight

    editorPanel.style.flexBasis = editorHeight + 'px'
    terminalPanel.style.flexBasis = terminalHeight + 'px'

    // 通知 Monaco 和 xterm
    if (state.editor) {
      state.editor.layout()
    }
    state.terminals.forEach(term => {
      if (term.fitAddon) {
        term.fitAddon.fit()
      }
    })
  })

  resizeObserver.observe(container)
}
