// ─────────────────────────────────────────────
// WebSocket
// ─────────────────────────────────────────────
let wsInstanceCount = 0  // 全局计数器，追踪创建了多少个 WS 实例

function connectWS() {
  wsInstanceCount++
  const myId = wsInstanceCount
  devLog('WS', `#${myId} Creating connection, readyState:`, state.ws?.readyState)

  // 防止重复连接
  if (state.ws?.readyState === WebSocket.OPEN || state.ws?.readyState === WebSocket.CONNECTING) {
    devLog('WS', `#${myId} Already connected, aborting`)
    return
  }
  // 清理旧连接
  if (state.ws) { state.ws.close(); state.ws = null }

  if (!state.currentWs) {
    devLog('WS', `#${myId} No workspace, aborting`)
    return
  }

  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const wsUrl = `${proto}://${location.host}/ws/chat/${state.currentWs.id}`
  devLog('WS', `#${myId} Connecting to:`, wsUrl)

  const ws = new WebSocket(wsUrl)
  state.ws = ws
  state.wsManualClose = false  // 重置主动关闭标记

  ws.onopen = () => {
    devLog('WS', `#${myId} OPENED, total: ${wsInstanceCount}`)
  }

  ws.onmessage = e => {
    let ev
    try { ev = JSON.parse(e.data) } catch { return }
    devLog('WS', `#${myId} MESSAGE`, ev.type, ev.type === 'token' ? ev.text?.substring(0, 20) + '...' : ev)
    handleWsEvent(ev)
  }

  ws.onclose = (e) => {
    devLog('WS', `#${myId} CLOSED code:${e.code} manual:${state.wsManualClose}`)
    state.ws = null
    // 只有非主动关闭且仍在当前工作区时才重连
    if (!state.wsManualClose && state.currentWs) {
      devLog('WS', `#${myId} Will reconnect in 3s`)
      setTimeout(() => {
        if (state.currentWs && !state.ws) connectWS()
      }, 3000)
    }
  }

  ws.onerror = (err) => {
    devError('WS', `#${myId} Error:`, err)
  }
}

function disconnectWS(manual = true) {
  devLog('WS', 'Disconnecting, manual:', manual, 'readyState:', state.ws?.readyState)
  if (state.ws) {
    state.wsManualClose = manual
    state.ws.onclose = null  // 移除 onclose 避免触发重连
    state.ws.close()
    state.ws = null
    devLog('WS', 'Disconnected')
  }
}

// Bug 修复：确保 WS 已连接，发消息前调用
function ensureWsConnected(timeout = 5000) {
  return new Promise((resolve) => {
    // 已连接直接返回
    if (state.ws?.readyState === WebSocket.OPEN) {
      devLog('WS', 'ensureWsConnected: already connected')
      resolve()
      return
    }

    devLog('WS', 'ensureWsConnected: waiting for connection...')
    const start = Date.now()
    const check = setInterval(() => {
      if (state.ws?.readyState === WebSocket.OPEN) {
        clearInterval(check)
        devLog('WS', 'ensureWsConnected: connected after', Date.now() - start, 'ms')
        resolve()
      } else if (Date.now() - start > timeout) {
        clearInterval(check)
        devWarn('WS', 'ensureWsConnected timeout, proceeding anyway')
        resolve() // 超时也继续，不阻塞用户
      }
    }, 100)

    // 如果 WS 还没创建或已关闭，立即触发连接
    if (!state.ws || state.ws.readyState === WebSocket.CLOSED) {
      devLog('WS', 'ensureWsConnected: triggering connectWS')
      connectWS()
    }
  })
}

function handleWsEvent(ev) {
  const payloadInfo = typeof ev.payload === 'string' ? `string(${ev.payload?.length})` : (ev.payload ? Object.keys(ev.payload) : 'no payload')
  devLog('WS', 'handleWsEvent type:', ev.type, 'payload:', payloadInfo)

  // 【诊断日志】所有 WS 事件都输出到控制台
  console.log('[WS-DEBUG] 事件类型:', ev.type, 'payload:', ev.payload, 'streamMsgId:', state.streamMsgId, 'streaming:', state.streaming)

  // HITL 诊断：特别记录确认相关事件
  if (ev.type === 'confirmation_requested' || ev.type === 'confirmation_done' || ev.type === 'confirmation_executing' || ev.type === 'confirmation_cancelled') {
    console.log('[WS-HITL] 收到确认事件:', ev.type, ev.payload)
  }

  if (ev.type === 'todo_updated' || ev.type === 'auto_execute_changed') {
    if (typeof handleTodoWSMessage === 'function') {
      handleTodoWSMessage(ev)
    }
    return
  }

  switch (ev.type) {
    case 'text':
      onStreamToken(ev.payload)
      break
    case 'tool_call':
      console.log('[WS-DEBUG] tool_call 事件:', ev.payload)
      onToolCall(ev.payload)
      break
    case 'tool_result':
      console.log('[WS-DEBUG] tool_result 事件:', ev.payload)
      onToolResult(ev.payload)
      break
    case 'compact_start':
      onCompactStart(ev.payload)
      break
    case 'compact_done':
      onCompactDone(ev.payload)
      break
    case 'usage':
      // token 统计，目前只更新轮数
      state.ctxTurns++
      $('ctx-turns').textContent = `上下文: ${state.ctxTurns} / 20 轮`
      break
    case 'done':
      console.log('[WS-DEBUG] done 事件:', ev.payload, 'streamMsgId:', state.streamMsgId, 'has loading:', !!document.querySelector('.loading-container'))
      devLog('WS', 'done event received, streamMsgId:', state.streamMsgId, 'has loading:', !!document.querySelector('.loading-container'))
      // Bug Fix: 如果有 loading 容器（重连/刷新场景），直接移除并刷新
      const loadingContainer = document.querySelector('.loading-container')
      if (loadingContainer) {
        console.log('[WS-DEBUG] 发现 loading-container，移除并刷新历史')
        loadingContainer.closest('.msg-assistant')?.remove()
        loadHistory() // 从数据库重新加载完整消息
      } else if (state.streaming && state.streamMsgId) {
        // 正常流式结束（自己发的消息）
        console.log('[WS-DEBUG] 正常流式结束，调用 onStreamDone')
        onStreamDone()
        // 兜底对账：即使流式 token 丢失，也从数据库拉取最终内容，避免“需刷新才显示”
        setTimeout(() => {
          loadHistory()
        }, 80)
      } else {
        // 兜底：也尝试刷新
        console.log('[WS-DEBUG] 兜底刷新历史')
        loadHistory()
      }
      break
    case 'error':
      onStreamError(ev.payload)
      break
    case 'queue_position':
      onQueuePosition(ev.position)
      break
    case 'task_running':
      // Bug Fix: 有任务正在运行，显示加载状态等待完成
      if (ev.payload && ev.payload.msgId) {
        onTaskRunning(ev.payload.msgId, ev.payload.startedAt)
      }
      break
    case 'confirmation_requested':
      // 显示确认弹窗
      showConfirmationDialog(ev.payload)
      break
    case 'confirmation_executing':
      // 确认后执行中，显示提示
      showNotification('正在执行确认的操作...', 'info')
      break
    case 'confirmation_done':
      // 确认执行完成
      console.log('[WS-DEBUG] confirmation_done 事件:', ev.payload)
      // 更新工具块状态
      if (ev.payload.tool_use_id) {
        onToolResult({
          tool_use_id: ev.payload.tool_use_id,
          result: ev.payload.result,
          error: ev.payload.error,
          success: ev.payload.success
        })
      }
      if (ev.payload.success) {
        showNotification('操作执行成功', 'success')
      } else {
        showNotification(ev.payload.error || '操作执行失败', 'error')
      }
      break
    case 'confirmation_cancelled':
      // 确认已取消
      console.log('[WS-DEBUG] confirmation_cancelled 事件:', ev.payload)
      // 更新工具块状态为取消
      if (ev.payload.tool_use_id) {
        onToolResult({
          tool_use_id: ev.payload.tool_use_id,
          result: null,
          error: '用户已取消操作'
        })
      }
      showNotification('操作已取消', 'info')
      break
  }
}

// ─────────────────────────────────────────────
// 发消息
// ─────────────────────────────────────────────
async function sendMessage() {
  const input = $('chat-input')
  const text  = input.value.trim()

  // 发送锁检查：防止重复提交
  if (state.isSending) {
    devLog('CHAT', 'Send blocked: already sending')
    return
  }

  if ((!text && state.uploads.length === 0) || state.streaming) return
  if (!state.currentWs || !state.currentSession) {
    alert('请先选择工作区')
    return
  }

  // 处理指令（仅纯文本）
  if (text.startsWith('/')) {
    execCommand(text)
    input.value = ''
    resetTextareaHeight(input)
    return
  }

  // === 乐观更新：立即给用户反馈 ===
  state.isSending = true

  // 1. 立即清空输入框
  const contentToSend = text
  input.value = ''
  resetTextareaHeight(input)
  closeCmdPalette()

  // 2. 立即显示用户消息（乐观更新）
  const displayContent = contentToSend || (state.uploads.length > 0 ? `[${state.uploads.length} 个附件]` : '')
  const optimisticUserMsg = { role: 'user', content: displayContent, uploads: [...state.uploads], id: uid() }
  appendMessage(optimisticUserMsg)
  scrollToBottom()

  // 3. 禁用发送按钮（防止重复点击）
  const sendBtn = document.getElementById('chat-send-btn')
  if (sendBtn) {
    sendBtn.disabled = true
    sendBtn.classList.add('opacity-50', 'cursor-not-allowed')
  }

  // 4. 清空上传队列
  const uploadsToSend = [...state.uploads]
  state.uploads = []
  renderUploadPreviews()

  // Bug 修复：发消息前确保 WS 已连接
  await ensureWsConnected()

  // 构建 content：字符串或数组
  let content
  if (uploadsToSend.length === 0) {
    content = contentToSend
  } else {
    content = []
    for (const file of uploadsToSend) {
      if (file.type === 'image') {
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: file.mediaType, data: file.base64 }
        })
      } else if (file.type === 'document' && file.mimeType === 'application/pdf') {
        content.push({
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: file.base64 }
        })
      } else if (file.type === 'text' && file.content) {
        content.push({
          type: 'text',
          text: `[文件: ${file.name}]\n\n${file.content.slice(0, 10000)}`
        })
      }
    }
    if (contentToSend) {
      content.push({ type: 'text', text: contentToSend })
    }
  }

  // 准备流式接收
  state.streaming = true
  state.streamBuf  = ''
  state.streamMsgId = uid()
  devLog('RENDER', 'Creating bubble, streamMsgId:', state.streamMsgId)

  // 创建空的 assistant bubble 用于流式填充
  appendStreamingBubble(state.streamMsgId)
  scrollToBottom()

  try {
    const res = await api('/api/chat', {
      method: 'POST',
      body: {
        workspaceId: state.currentWs.id,
        sessionId:   state.currentSession.id,
        content:     content,
        messageId:   optimisticUserMsg.id
      }
    })
    // T6: 使用后端返回的 assistantMsgId 替换前端生成的 ID
    if (res?.assistantMsgId) {
      devLog('CHAT', 'Got assistantMsgId from server:', res.assistantMsgId)
      updateStreamingBubbleId(state.streamMsgId, res.assistantMsgId)
      state.streamMsgId = res.assistantMsgId
    }
  } catch(e) {
    // API 失败：移除乐观显示的消息并重置状态
    devError('CHAT', 'Send message failed:', e)
    removeMessage(optimisticUserMsg.id)
    // 移除 assistant 的流式气泡（因为 API 失败，不会有响应）
    const streamContainer = $('stream-' + state.streamMsgId)
    if (streamContainer) {
      streamContainer.remove()
    }
    state.streaming = false
    onStreamError(e.message || '发送失败，请重试')
  } finally {
    // 恢复发送状态
    state.isSending = false
    if (sendBtn) {
      sendBtn.disabled = false
      sendBtn.classList.remove('opacity-50', 'cursor-not-allowed')
    }
  }
}

// ─────────────────────────────────────────────
// 流式渲染
// ─────────────────────────────────────────────
function appendStreamingBubble(id) {
  const list = $('msg-list')
  $('empty-state')?.remove()
  const wrap = document.createElement('div')
  wrap.className = 'flex justify-start items-start gap-3 msg-assistant'
  wrap.innerHTML = `
    <div class="w-8 h-8 rounded-xl bg-deep-charcoal flex items-center justify-center shrink-0">
      <i data-lucide="bot" class="w-4 h-4 text-white"></i>
    </div>
    <div id="stream-${id}" class="max-w-[82%] space-y-2">
      <!-- 流式内容容器：文本块和工具块平级插入 -->
    </div>`
  list.appendChild(wrap)
  lucide.createIcons({ nodes: [wrap] })
}

// T6: 更新流式气泡 ID（后端返回 assistantMsgId 后替换前端临时 ID）
function updateStreamingBubbleId(oldId, newId) {
  const container = $('stream-' + oldId)
  if (container) {
    container.id = 'stream-' + newId
    devLog('RENDER', 'Updated bubble id from', oldId, 'to', newId)
  } else {
    devWarn('RENDER', 'Bubble not found for id update:', oldId)
  }
}

// Bug Fix: 显示任务运行中的加载状态（替代 replay）
function onTaskRunning(msgId, startedAt) {
  devLog('RENDER', 'Task running:', msgId, 'started at:', startedAt)
  // 设置流式状态
  state.streaming = true
  state.streamMsgId = msgId
  state.streamBuf = ''
  // 创建加载容器（使用 stream-${msgId} ID，与正常流式兼容）
  createLoadingContainer(msgId)
  scrollToBottom()
}

// Bug Fix: 创建加载中容器（使用 stream-${msgId} ID）
function createLoadingContainer(msgId) {
  // 如果已存在则不重复创建
  if ($('stream-' + msgId)) {
    console.log('[LOADING-DEBUG] 容器已存在，跳过创建 stream-' + msgId)
    return
  }

  console.log('[LOADING-DEBUG] 创建 loading 容器 stream-' + msgId)

  const list = $('msg-list')
  $('empty-state')?.remove()
  const wrap = document.createElement('div')
  wrap.className = 'flex justify-start items-start gap-3 msg-assistant'
  // 使用 stream-${msgId} 作为容器ID，内部显示加载动画
  wrap.innerHTML = `
    <div class="w-8 h-8 rounded-xl bg-deep-charcoal flex items-center justify-center shrink-0">
      <i data-lucide="bot" class="w-4 h-4 text-white"></i>
    </div>
    <div id="stream-${msgId}" class="bubble p-5 flex items-center gap-2 text-gray-500 loading-container">
      <span class="loading-dot"></span>
      <span class="loading-dot"></span>
      <span class="loading-dot"></span>
      <span class="text-sm ml-2">正在生成回复...</span>
    </div>`
  list.appendChild(wrap)
  lucide.createIcons({ nodes: [wrap] })
  console.log('[LOADING-DEBUG] loading 容器创建完成 stream-' + msgId)
}

// Bug Fix: 移除加载容器（通过 msgId 查找）
function removeLoadingContainer(msgId) {
  const container = $('stream-' + msgId)
  if (container) {
    container.closest('.msg-assistant')?.remove()
    devLog('RENDER', 'Loading container removed for', msgId)
  }
}

// 兼容旧函数名（供 done 事件调用）
function removeLoadingBubble() {
  // 通过查找 loading-container 类来移除
  const container = document.querySelector('.loading-container')
  if (container) {
    container.closest('.msg-assistant')?.remove()
    devLog('RENDER', 'Loading bubble removed')
  }
}

// T6: Replay 已存在的流式内容（重连后恢复）- 已废弃，改用 task_running
// onReplay 函数已删除，相关逻辑由 onTaskRunning 替代

function onStreamToken(chunk) {
  state.streamBuf += chunk
  const container = $('stream-' + state.streamMsgId)
  devLog('RENDER', 'appendToken, streamMsgId:', state.streamMsgId, 'container exists:', !!container, 'chunk:', chunk?.substring(0, 30))
  if (!container) {
    devWarn('RENDER', 'appendToken - container not found, aborting')
    return
  }

  // Bug 1 修复：找或创建当前文字块，不碰工具块
  let textEl = container.querySelector('.text-chunk.streaming')
  if (!textEl) {
    textEl = document.createElement('div')
    textEl.className = 'text-chunk streaming bubble p-5'
    textEl.innerHTML = '<p class="text-sm leading-relaxed"></p><span class="stream-cursor"></span>'
    container.appendChild(textEl)
    devLog('RENDER', 'created new text-chunk')
  }

  // 只更新文字块内容（增加 requestAnimationFrame 节流，避免长文本渲染卡顿导致 UI 冻结）
  const p = textEl.querySelector('p');
  if (p) {
    if (!p.dataset.rendering) {
      p.dataset.rendering = 'true';
      requestAnimationFrame(() => {
        p.innerHTML = marked.parse(state.streamBuf);
        scrollToBottom();
        delete p.dataset.rendering;
      });
    }
  } else {
    scrollToBottom();
  }
}


// Bug 2 修复：防止重复渲染，增加状态保护
let lastStreamMsgId = null

function onStreamDone() {
  // 防止同一消息重复处理
  if (state.streamMsgId === lastStreamMsgId) {
    devLog('RENDER', 'done already handled, skipping:', state.streamMsgId)
    console.log('[DONE-DEBUG] 重复处理，跳过。streamMsgId:', state.streamMsgId, 'lastStreamMsgId:', lastStreamMsgId)
    return
  }
  lastStreamMsgId = state.streamMsgId

  devLog('RENDER', 'done, finalizing, streamMsgId:', state.streamMsgId)
  console.log('[DONE-DEBUG] onStreamDone 调用, streamMsgId:', state.streamMsgId, 'streaming:', state.streaming)
  state.streaming = false

  // Bug 1 修复：找到容器，固化文字块
  const container = $('stream-' + state.streamMsgId)
  console.log('[DONE-DEBUG] 查找容器 stream-' + state.streamMsgId, '结果:', !!container)
  if (container) {
    // 无增量内容时，不固化空文本，直接等待 history 对账回填
    if (!state.streamBuf) {
      container.closest('.msg-assistant')?.remove()
    }
    // 移除光标并固化所有流式文字块
    container.querySelectorAll('.text-chunk.streaming').forEach(el => {
      el.classList.remove('streaming')
      const p = el.querySelector('p')
      if (p) {
        p.innerHTML = renderMarkdown(state.streamBuf)
        devLog('RENDER', 'done - text finalized, length:', p.textContent?.length || 0)
      }
      // 移除光标
      const cursor = el.querySelector('.stream-cursor')
      if (cursor) cursor.remove()
    })
  } else {
    console.warn('[DONE-DEBUG] 找不到容器 stream-' + state.streamMsgId)
  }

  $('queue-banner').classList.add('hidden')
  state.streamBuf = ''
  state.streamMsgId = null  // 清理 streamMsgId，避免重复操作
  scrollToBottom()
  console.log('[DONE-DEBUG] onStreamDone 完成')
}

function onStreamError(msg) {
  state.streaming = false
  const container = $('stream-' + state.streamMsgId)
  if (container) {
    // 找到当前流式文字块，添加错误样式
    const textEl = container.querySelector('.text-chunk.streaming')
    if (textEl) {
      textEl.classList.add('border-red-200', 'bg-red-50/50')
      const p = textEl.querySelector('p')
      if (p) p.innerHTML = `<span class="text-red-400 text-[12px] font-mono">⚠ 出错: ${escHtml(String(msg))}</span>`
    }
  }
}

function onToolCall(payload) {
  // payload: { tool_use_id, name, input }
  devLog('Tool', 'onToolCall:', payload.tool_use_id, payload.name)
  console.log('[TOOL-DEBUG] onToolCall 调用:', payload, 'streamMsgId:', state.streamMsgId)

  const container = $('stream-' + state.streamMsgId)
  if (!container) {
    console.error('[TOOL-DEBUG] 找不到容器 stream-' + state.streamMsgId, 'DOM中stream元素数:', document.querySelectorAll('[id^="stream-"]').length)
    devError('Tool', 'container not found for stream', state.streamMsgId)
    return
  }
  console.log('[TOOL-DEBUG] 找到容器:', container)

  // Bug 修复：工具调用时固化当前文字块并重置 streamBuf
  const textEl = container.querySelector('.text-chunk.streaming')
  if (textEl) {
    textEl.classList.remove('streaming')
    const p = textEl.querySelector('p')
    if (p) {
      p.innerHTML = renderMarkdown(state.streamBuf)
      devLog('Tool', 'finalized text chunk before tool, length:', state.streamBuf.length)
    }
    const cursor = textEl.querySelector('.stream-cursor')
    if (cursor) cursor.remove()
  }
  state.streamBuf = ''  // 重置，后续文字从头开始

  // Bug 1 修复：检查是否已存在该工具块（防止重复）
  if ($('tool-' + payload.tool_use_id)) {
    devLog('Tool', 'Block already exists for', payload.tool_use_id)
    return
  }

  const block = document.createElement('div')
  block.id = 'tool-' + payload.tool_use_id
  block.dataset.toolId = payload.tool_use_id
  const colorMap = { read_file:'blue', write_file:'blue', bash:'orange', create_task:'orange', todo_write:'purple', todo_read:'purple', read_skill:'green', recall:'indigo' }
  const col = colorMap[payload.name] || 'slate'

  const colorClasses = {
    blue:   { bg: 'bg-blue-500/5',   border: 'border-blue-500/10',   iconBg: 'bg-blue-500/15',   iconText: 'text-blue-500' },
    orange: { bg: 'bg-orange-500/5', border: 'border-orange-500/10', iconBg: 'bg-orange-500/15', iconText: 'text-orange-500' },
    purple: { bg: 'bg-purple-500/5', border: 'border-purple-500/10', iconBg: 'bg-purple-500/15', iconText: 'text-purple-500' },
    green:  { bg: 'bg-green-500/5',  border: 'border-green-500/10',  iconBg: 'bg-green-500/15',  iconText: 'text-green-500' },
    indigo: { bg: 'bg-indigo-500/5', border: 'border-indigo-500/10', iconBg: 'bg-indigo-500/15', iconText: 'text-indigo-500' },
    slate:  { bg: 'bg-slate-500/5',  border: 'border-slate-500/10',  iconBg: 'bg-slate-500/15',  iconText: 'text-slate-500' }
  }
  const c = colorClasses[col] || colorClasses.slate

  block.className = `tool-block ${c.bg} ${c.border} border rounded-[1.25rem] mb-2 overflow-hidden`

  // 创建头部（可点击折叠）
  const header = document.createElement('div')
  header.className = 'tool-header flex items-center gap-3 px-4 py-3 cursor-pointer select-none'

  // 工具显示配置
  const toolDisplayConfig = {
    recall: {
      icon: '🔍',
      label: '搜索历史对话',
      paramDisplay: (input) => input?.keywords || ''
    }
  }

  const config = toolDisplayConfig[payload.name]
  if (config) {
    // 特殊工具显示
    header.innerHTML = `
      <div class="w-5 h-5 rounded-lg ${c.iconBg} flex items-center justify-center shrink-0">
        <span class="text-[12px]">${config.icon}</span>
      </div>
      <span class="text-[11px] font-mono font-bold ${c.iconText}">${config.label}</span>
      <span class="text-[11px] font-mono opacity-60 truncate flex-1">${escHtml(config.paramDisplay(payload.input))}</span>
      <span class="tool-status ml-auto text-[10px] bg-oxygen-blue/10 text-oxygen-blue px-2 py-0.5 rounded-full font-bold">执行中…</span>
      <i data-lucide="chevron-down" class="w-3.5 h-3.5 opacity-30 tool-chevron"></i>
    `
  } else {
    // 默认显示
    header.innerHTML = `
      <div class="w-5 h-5 rounded-lg ${c.iconBg} flex items-center justify-center shrink-0">
        <i data-lucide="terminal" class="w-3 h-3 ${c.iconText}"></i>
      </div>
      <span class="text-[11px] font-mono font-bold ${c.iconText}">${escHtml(payload.name)}</span>
      <span class="text-[11px] font-mono opacity-40 truncate flex-1">${escHtml(JSON.stringify(payload.input || '').slice(0,40))}</span>
      <span class="tool-status ml-auto text-[10px] bg-oxygen-blue/10 text-oxygen-blue px-2 py-0.5 rounded-full font-bold">执行中…</span>
      <i data-lucide="chevron-down" class="w-3.5 h-3.5 opacity-30 tool-chevron"></i>
    `
  }

  // 创建内容区（可折叠）
  const body = document.createElement('div')
  body.className = 'tool-body hidden px-4 pb-3'
  body.innerHTML = `<pre class="text-[10px] font-mono text-slate-500 bg-slate-50 rounded-xl p-3 overflow-x-auto tool-result">等待执行结果...</pre>`

  // 使用 addEventListener 绑定折叠事件
  header.addEventListener('click', function() {
    const isHidden = body.classList.contains('hidden')
    devLog('Tool', 'toggle clicked, was hidden:', isHidden)
    if (isHidden) {
      body.classList.remove('hidden')
      header.querySelector('.tool-chevron')?.classList.add('open')
    } else {
      body.classList.add('hidden')
      header.querySelector('.tool-chevron')?.classList.remove('open')
    }
  })

  block.appendChild(header)
  block.appendChild(body)

  // Bug 1 修复：工具块作为平级子元素追加到容器，不碰文字块
  container.appendChild(block)
  lucide.createIcons({ nodes: [block] })
  scrollToBottom()
  devLog('Tool', 'Block appended to container for', payload.tool_use_id)
  console.log('[TOOL-DEBUG] 工具块已添加到容器:', 'tool-' + payload.tool_use_id, '容器id:', container.id, '容器子元素数:', container.children.length)
}

function onToolResult(payload) {
  devLog('Tool', 'onToolResult:', payload.tool_use_id, 'result keys:', Object.keys(payload.result || {}))
  console.log('[TOOL-DEBUG] onToolResult 调用:', payload)

  const blockId = 'tool-' + payload.tool_use_id
  let block = $(blockId)
  console.log('[TOOL-DEBUG] 查找工具块:', blockId, '结果:', !!block)

  // 如果 DOM 容器不存在，等待下一个渲染帧再尝试
  if (!block) {
    console.warn('[TOOL-DEBUG] 工具块不存在，等待下一帧重试:', blockId)
    devLog('Tool', 'Block not found for', payload.tool_use_id, ', waiting for next frame...')
    requestAnimationFrame(() => {
      const retryBlock = $(blockId)
      console.log('[TOOL-DEBUG] 重试查找工具块:', blockId, '结果:', !!retryBlock)
      if (retryBlock) {
        devLog('Tool', 'Block found on retry, rendering result')
        renderToolResult(retryBlock, payload)
      } else {
        devError('Tool', 'Block still not found after retry for', payload.tool_use_id)
        console.error('[TOOL-DEBUG] 重试后仍找不到工具块:', blockId)
      }
    })
    return
  }

  renderToolResult(block, payload)
}

/**
 * 渲染工具结果到 DOM
 */
function renderToolResult(block, payload) {
  const result = payload.result || {}
  console.log('[TOOL-DEBUG] renderToolResult 调用:', 'block:', !!block, 'result:', result)

  // 兼容各种可能的字段名
  // payload.success 来自 confirmation_done 事件，优先检查
  const isSuccess = payload.success ?? result.success ?? result.ok ?? (result.exit_code === 0) ?? (result.error === undefined)
  const output = result.output ?? result.content ?? result.data ?? result.text ?? ''

  devLog('Tool', 'resolved success:', isSuccess, 'output len:', output.length, 'block:', !!block)
  console.log('[TOOL-DEBUG] 解析结果 - isSuccess:', isSuccess, 'output长度:', output.length, 'output前100字:', output?.substring(0, 100))

  // 更新状态标签
  const statusBadge = block.querySelector('.tool-status')
  if (statusBadge) {
    statusBadge.textContent = isSuccess ? '完成' : '失败'
    statusBadge.className = `tool-status ml-auto text-[10px] px-2 py-0.5 rounded-full font-bold ${isSuccess ? 'bg-green-500/10 text-green-600' : 'bg-red-500/10 text-red-600'}`
    devLog('Tool', 'status badge updated:', isSuccess ? '完成' : '失败')
    console.log('[TOOL-DEBUG] 状态标签已更新:', isSuccess ? '完成' : '失败')
  } else {
    devWarn('Tool', 'status badge not found')
    console.warn('[TOOL-DEBUG] 找不到状态标签 .tool-status')
  }

  // 更新边框颜色（Bug 1 修复：成功绿色，失败红色）
  if (isSuccess) {
    block.className = block.className.replace(/bg-\w+-500\/5/g, 'bg-green-500/5').replace(/border-\w+-500\/10/g, 'border-green-500/20')
  } else {
    block.className = block.className.replace(/bg-\w+-500\/5/g, 'bg-red-500/5').replace(/border-\w+-500\/10/g, 'border-red-500/20')
  }

  // 更新结果内容
  const resultEl = block.querySelector('.tool-result')
  if (resultEl) {
    let displayText = ''

    // recall 工具特殊显示
    if (payload.name === 'recall') {
      const data = result.data || {}
      const found = data.found ?? 0

      if (found === 0) {
        displayText = '🔍 未找到相关记录'
      } else {
        displayText = `🔍 找到 ${found} 条相关记录`
      }
    } else if (output) {
      // 新格式：{ success, output, exit_code, elapsed_ms }
      const lines = [
        `退出码: ${result.exit_code ?? result.exitCode ?? 'N/A'}`,
        `耗时: ${result.elapsed_ms ?? result.elapsedMs ?? '?'}ms`,
        result.truncated ? '[输出已截断]' : null,
        '---',
        output,
      ].filter(Boolean)
      displayText = lines.join('\n')
    } else if (result.error) {
      displayText = `错误: ${result.error}`
    } else {
      displayText = JSON.stringify(result, null, 2)
    }

    resultEl.textContent = displayText
    devLog('Tool', 'result content updated, length:', displayText.length)
  } else {
    devWarn('Tool', 'result element not found')
  }

  const body = block.querySelector('.tool-body')
  const header = block.querySelector('.tool-header')
  console.log('[TOOL-DEBUG] 查找 tool-body:', !!body, 'tool-header:', !!header)
  if (body) {
    body.classList.remove('hidden')
    devLog('Tool', 'body shown')
    console.log('[TOOL-DEBUG] tool-body 已显示')
  } else {
    console.warn('[TOOL-DEBUG] 找不到 tool-body')
  }
  if (header) {
    header.querySelector('.tool-chevron')?.classList.add('open')
  }
  scrollToBottom()
  devLog('Tool', 'Result updated for', payload.tool_use_id)
  console.log('[TOOL-DEBUG] renderToolResult 完成:', payload.tool_use_id)
}

function onQueuePosition(pos) {
  // 后端发送: 'waiting' | 'executing' | number
  if (pos === 'waiting') {
    $('queue-banner').classList.remove('hidden')
    $('queue-text').innerHTML = '正在排队等待处理…'
    $('lock-status').textContent = '锁: 等待中'
  } else if (pos === 'executing') {
    $('queue-banner').classList.remove('hidden')
    $('queue-text').innerHTML = '<b>正在执行中…</b>'
    $('lock-status').textContent = '锁: 持有中'
  } else if (typeof pos === 'number' && pos > 0) {
    $('queue-banner').classList.remove('hidden')
    $('queue-text').innerHTML = `正在处理上一条指令，已排队第 <b>${pos}</b> 位…`
    $('lock-status').textContent = `锁: 持有中 · 队列: ${pos}`
  } else {
    $('queue-banner').classList.add('hidden')
    $('lock-status').textContent = '锁: 空闲 · 队列: 0'
  }
}

function cancelQueue() {
  // TODO: 后续实现取消逻辑（发送 cancel 信号到 WS）
  $('queue-banner').classList.add('hidden')
}

// ─────────────────────────────────────────────
// 历史消息渲染
// ─────────────────────────────────────────────
function clearMessages() {
  const list = $('msg-list')
  list.innerHTML = ''
  // 重新插入空状态（如需）
}

function removeMessage(id) {
  const msgEl = document.querySelector(`[data-msg-id="${id}"]`)
  if (msgEl) {
    msgEl.remove()
    devLog('CHAT', 'Removed optimistic message:', id)
  }
  // 从 state.messages 中移除
  const idx = state.messages.findIndex(m => m.id === id)
  if (idx !== -1) {
    state.messages.splice(idx, 1)
  }
}

function appendMessage({ role, content, id, uploads = [], status }) {
  const list  = $('msg-list')
  $('empty-state')?.remove()
  const wrap = document.createElement('div')

  // 设置消息 ID 以便后续移除
  if (id) {
    wrap.dataset.msgId = id
  }

  if (role === 'user') {
    // Bug 修复：检查是否是 tool_result 消息（历史消息中的工具结果）
    if (Array.isArray(content) && content.length > 0 && content[0].type === 'tool_result') {
      // 这是 tool_result 消息，不应该显示为 user 气泡
      // 而是应该找到对应的 tool_use 块并回填结果
      // 由于是在历史消息加载时，对应的 assistant 消息应该已经渲染过了
      // 我们需要延迟回填，因为 assistant 消息可能还没有渲染
      setTimeout(() => {
        for (const block of content) {
          if (block.type === 'tool_result') {
            const toolBlock = $('tool-' + block.tool_use_id)
            if (toolBlock) {
              // 找到对应的 tool 块，回填结果
              const resultEl = toolBlock.querySelector('.tool-result')
              if (resultEl) {
                fillToolResultContent(resultEl, block.content)
              }
              // 更新状态标签
              const statusBadge = toolBlock.querySelector('.tool-status')
              if (statusBadge) {
                statusBadge.textContent = '完成'
                statusBadge.className = 'tool-status ml-auto text-[10px] px-2 py-0.5 rounded-full font-bold bg-green-500/10 text-green-600'
              }
            }
          }
        }
      }, 0)
      return null  // 不创建 DOM 元素
    }

    wrap.className = 'flex justify-end gap-3 msg-user'
    // User content 可能是字符串、多模态数组或 tool_result 数组
    let displayContent = ''
    let mediaBlocks = []

    if (Array.isArray(content)) {
      // 多模态数组：提取 text 和 image/document blocks
      const textParts = []
      for (const block of content) {
        if (block.type === 'text') {
          textParts.push(block.text)
        } else if (block.type === 'image' && block.source?.data) {
          mediaBlocks.push({ type: 'image', mime: block.source.media_type, data: block.source.data })
        } else if (block.type === 'document' && block.source?.data) {
          mediaBlocks.push({ type: 'document', mime: block.source.media_type, name: 'PDF 文档' })
        }
      }
      displayContent = textParts.join('\n')
    } else {
      displayContent = content
    }

    // 构建附件预览 HTML
    let uploadsHtml = ''
    if (uploads.length > 0 || mediaBlocks.length > 0) {
      const items = uploads.length > 0 ? uploads.map(f => {
        if (f.type === 'image' && f.url) {
          return `<img src="${f.url}" class="max-h-24 rounded-xl border border-white/50 shadow-sm" alt="${escHtml(f.name)}">`
        } else {
          const icon = f.mimeType === 'application/pdf' ? 'file-text' : 'file'
          return `<div class="flex items-center gap-2 bg-black/20 px-3 py-1.5 rounded-lg text-[11px]"><i data-lucide="${icon}" class="w-3.5 h-3.5"></i>${escHtml(f.name)}</div>`
        }
      }) : mediaBlocks.map(b => {
        if (b.type === 'image') {
          return `<img src="data:${b.mime};base64,${b.data}" class="max-h-24 rounded-xl border border-white/50 shadow-sm">`
        } else {
          return `<div class="flex items-center gap-2 bg-black/20 px-3 py-1.5 rounded-lg text-[11px]"><i data-lucide="file-text" class="w-3.5 h-3.5"></i>${escHtml(b.name || '文档')}</div>`
        }
      })
      uploadsHtml = `<div class="flex flex-wrap gap-2 mt-3">${items.join('')}</div>`
    }
    wrap.innerHTML = `
      <div class="max-w-[65%] bubble p-5">
        <p class="text-sm leading-relaxed">${renderMarkdown(displayContent)}</p>
        ${uploadsHtml}
      </div>`
  } else {
    wrap.className = 'flex justify-start items-start gap-3 msg-assistant'

    const assistantContainer = document.createElement('div')
    assistantContainer.className = 'max-w-[82%]'
    assistantContainer.innerHTML = `
      <div class="w-8 h-8 rounded-xl bg-deep-charcoal flex items-center justify-center shrink-0 float-left mr-3">
        <i data-lucide="bot" class="w-4 h-4 text-white"></i>
      </div>`

    if (Array.isArray(content)) {
      // 第一遍：创建所有节点，建立 tool_use_id → DOM 节点映射
      const toolBlockMap = {}
      const contentContainer = document.createElement('div')
      contentContainer.className = 'ml-11'

      content.forEach(block => {
        if (block.type === 'text' && block.text) {
          const textDiv = document.createElement('div')
          textDiv.className = 'bubble p-5 mb-2'
          textDiv.innerHTML = `<p class="text-sm leading-relaxed">${renderMarkdown(block.text)}</p>`
          contentContainer.appendChild(textDiv)

        } else if (block.type === 'tool_use') {
          const toolDiv = document.createElement('div')
          toolDiv.className = 'tool-block bg-gray-50 border border-gray-200 mb-2 overflow-hidden'
          toolDiv.dataset.toolId = block.id
          toolDiv.innerHTML = `
            <div class="tool-header flex items-center gap-2 px-3 py-2 bg-gray-100 cursor-pointer hover:bg-gray-200 transition-colors" onclick="this.nextElementSibling.classList.toggle('open');this.querySelector('.tool-chevron').classList.toggle('open')">
              <i data-lucide="terminal" class="w-3.5 h-3.5 text-gray-500"></i>
              <span class="text-xs font-mono text-gray-600 flex-1">${escHtml(block.name)}</span>
              <span class="text-[10px] text-gray-400">${block.id?.slice(-8) || ''}</span>
              <i data-lucide="chevron-down" class="w-3.5 h-3.5 text-gray-400 tool-chevron transition-transform"></i>
            </div>
            <div class="tool-body px-3 py-2 bg-gray-50">
              <pre class="text-[11px] font-mono text-gray-600 overflow-x-auto">${escHtml(JSON.stringify(block.input, null, 2))}</pre>
              <div class="tool-result mt-2 pt-2 border-t border-gray-200" data-tool-result-id="${block.id}">
                <span class="text-[10px] text-gray-400 italic">执行中...</span>
              </div>
            </div>`
          contentContainer.appendChild(toolDiv)
          toolBlockMap[block.id] = toolDiv

        } else if (block.type === 'tool_result') {
          // 找到对应的 tool_use 块，回填结果
          const toolDiv = toolBlockMap[block.tool_use_id]
          if (toolDiv) {
            const resultDiv = toolDiv.querySelector(`[data-tool-result-id="${block.tool_use_id}"]`)
            if (resultDiv) {
              fillToolResultContent(resultDiv, block.content)
            }
          }
          // 静默忽略找不到对应块的情况
        }
      })

      assistantContainer.appendChild(contentContainer)
    } else {
      // 字符串内容（兼容旧数据）
      const textDiv = document.createElement('div')
      textDiv.className = 'bubble p-5 ml-11'
      textDiv.innerHTML = `<p class="text-sm leading-relaxed">${renderMarkdown(content)}</p>`
      assistantContainer.appendChild(textDiv)
    }

    // T6: 显示 interrupted 状态提示
    if (status === 'interrupted') {
      const hintDiv = document.createElement('div')
      hintDiv.className = 'ml-11 mt-2 text-xs text-amber-600 flex items-center gap-1'
      hintDiv.innerHTML = '<i data-lucide="alert-triangle" class="w-3.5 h-3.5"></i><span>⚠ 回复被中断</span>'
      assistantContainer.appendChild(hintDiv)
    }

    wrap.appendChild(assistantContainer)
  }
  list.appendChild(wrap)
  lucide.createIcons({ nodes: [wrap] })
  return wrap
}

// 填充 tool result 内容到指定 DOM 节点
function fillToolResultContent(resultDiv, content) {
  let resultObj
  try {
    resultObj = JSON.parse(content)
  } catch {
    resultObj = { output: content, success: true }
  }

  const isSuccess = resultObj.success !== false
  const output = resultObj.output || resultObj.content || String(content)

  resultDiv.innerHTML = `
    <div class="flex items-center gap-2 mb-1">
      <span class="text-[10px] px-2 py-0.5 rounded-full ${isSuccess ? 'bg-green-100 text-green-600' : 'bg-red-100 text-red-600'}">
        ${isSuccess ? '完成' : '失败'}
      </span>
      ${resultObj.exit_code !== undefined ? `<span class="text-[10px] text-gray-400">exit: ${resultObj.exit_code}</span>` : ''}
      ${resultObj.elapsed_ms ? `<span class="text-[10px] text-gray-400">${resultObj.elapsed_ms}ms</span>` : ''}
    </div>
    <pre class="text-[11px] font-mono text-gray-700 overflow-x-auto bg-gray-100 rounded p-2">${escHtml(output.slice(0, 2000))}${output.length > 2000 ? '\n... (truncated)' : ''}</pre>`
}

function scrollToBottom() {
  const list = $('msg-list')
  list.scrollTop = list.scrollHeight
}

// ─────────────────────────────────────────────
// / 指令系统
// ─────────────────────────────────────────────
const COMMANDS = [
  { cmd:'/new',     icon:'plus',        desc:'新建对话（当前工作区）' },
  { cmd:'/ws',      icon:'folder-open', desc:'切换工作区，示例: /ws devops-lab' },
  { cmd:'/clear',   icon:'eraser',      desc:'清空当前会话上下文（不删历史）' },
  { cmd:'/skill',   icon:'zap',         desc:'手动注入 skill，示例: /skill nginx-reload' },
  { cmd:'/memory',  icon:'brain',       desc:'查看本次注入的记忆内容' },
  { cmd:'/compact', icon:'minimize-2',  desc:'手动触发上下文压缩' },
]
let cmdIdx = 0

function renderCmdList(filter = '/') {
  const list = $('cmd-list')
  const visible = COMMANDS.filter(c => c.cmd.startsWith(filter))
  list.innerHTML = visible.map((c, i) => `
    <div class="cmd-item ${i===0?'selected':''} flex items-center gap-3 px-4 py-2.5" onclick="pickCmd('${c.cmd}')">
      <span class="w-6 h-6 rounded-lg bg-oxygen-blue/10 flex items-center justify-center shrink-0">
        <i data-lucide="${c.icon}" class="w-3 h-3 text-oxygen-blue"></i>
      </span>
      <div class="flex-1 min-w-0">
        <span class="text-[12px] font-mono font-bold text-oxygen-blue">${c.cmd}</span>
        <span class="text-[11px] opacity-40 ml-2">${c.desc}</span>
      </div>
    </div>`).join('')
  lucide.createIcons({ nodes: [list] })
  cmdIdx = 0
}

function onChatInput(input) {
  const pal = $('cmd-palette')
  if (input.value.startsWith('/')) {
    renderCmdList(input.value)
    pal.classList.add('open')
  } else {
    pal.classList.remove('open')
  }
}

function onChatKey(e) {
  const pal  = $('cmd-palette')
  const open = pal.classList.contains('open')
  // Shift+Enter 换行，Enter 发送
  if (e.key === 'Enter' && !e.shiftKey && !open) { sendMessage(); e.preventDefault(); return }
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { sendMessage(); e.preventDefault(); return }
  if (!open) return
  const items = [...$('cmd-list').querySelectorAll('.cmd-item')]
  if (e.key === 'ArrowDown') { cmdIdx = Math.min(cmdIdx+1, items.length-1); updateCmdSel(); e.preventDefault() }
  if (e.key === 'ArrowUp')   { cmdIdx = Math.max(cmdIdx-1, 0); updateCmdSel(); e.preventDefault() }
  if (e.key === 'Escape')    { closeCmdPalette(); return }
  if (e.key === 'Enter') {
    const sel = items[cmdIdx]
    if (sel) { const m = sel.querySelector('.font-mono'); if (m) pickCmd(m.textContent) }
    e.preventDefault()
  }
}

function updateCmdSel() {
  $('cmd-list').querySelectorAll('.cmd-item').forEach((el,i) => el.classList.toggle('selected', i===cmdIdx))
}

function pickCmd(cmd) {
  $('chat-input').value = cmd + ' '
  $('chat-input').focus()
  closeCmdPalette()
}

function closeCmdPalette() { $('cmd-palette').classList.remove('open') }

async function execCommand(text) {
  const [cmd, ...args] = text.trim().split(/\s+/)
  switch(cmd) {
    case '/new':    newSession(); break
    case '/ws':     if(args[0]) { const ws = state.workspaces.find(w=>w.name===args.join(' ')); if(ws) selectWorkspace(ws) } break
    case '/clear':  clearMessages(); state.messages=[]; state.ctxTurns=0; $('ctx-turns').textContent='上下文: 0 / 20 轮'; break
    case '/memory': alert('记忆调试功能即将上线'); break
    case '/compact': {
      // 立即显示反馈，防止用户重复点击
      const input = $('chat-input')
      const originalPlaceholder = input.placeholder
      input.placeholder = '⏳ 正在发起压缩...'
      input.disabled = true

      try {
        const result = await api('/api/chat/compact', {
          method: 'POST',
          body: { sessionId: state.currentSession?.id, workspaceId: state.currentWs?.id }
        })

        if (result && !result.success) {
          // 后端返回错误，显示提示
          showToast(result.error || '压缩失败', 'warning')
        }
        // success: true 时等待 compact_start/compact_done WS 事件
      } finally {
        input.placeholder = originalPlaceholder
        input.disabled = false
        input.focus()
      }
      break
    }
    case '/skill':  if(args[0]) api('/api/chat/skill', { method:'POST', body:{ workspaceId: state.currentWs?.id, name: args[0] } }); break
    default: alert(`未知指令: ${cmd}`)
  }
}

// ─────────────────────────────────────────────
// 文件上传
// ─────────────────────────────────────────────
function handleDragOver(e) {
  e.preventDefault()
  e.dataTransfer.dropEffect = 'copy'
  $('chat-input-area').classList.add('ring-2', 'ring-oxygen-blue', 'ring-opacity-50')
}

function handleDragLeave(e) {
  e.preventDefault()
  $('chat-input-area').classList.remove('ring-2', 'ring-oxygen-blue', 'ring-opacity-50')
}

async function handleDrop(e) {
  e.preventDefault()
  $('chat-input-area').classList.remove('ring-2', 'ring-oxygen-blue', 'ring-opacity-50')
  const files = e.dataTransfer.files
  if (files.length > 0) {
    await processFiles(files)
  }
}

async function handleFileSelect(e) {
  const files = e.target.files
  if (files.length > 0) {
    await processFiles(files)
  }
  // 清空 input，允许重复选择相同文件
  e.target.value = ''
}

async function processFiles(files) {
  if (!state.currentWs) {
    alert('请先选择工作区')
    return
  }

  const formData = new FormData()
  for (const file of files) {
    formData.append('files', file)
  }

  try {
    const res = await fetch(`/api/upload?workspaceId=${state.currentWs.id}`, {
      method: 'POST',
      body: formData,
      credentials: 'include'
    })
    if (res.status === 401) { showLogin(); return }
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)

    const data = await res.json()
    if (data.success) {
      state.uploads.push(...data.files)
      renderUploadPreviews()
    }
  } catch (e) {
    alert('上传失败: ' + e.message)
  }
}

function renderUploadPreviews() {
  const container = $('upload-preview')
  if (state.uploads.length === 0) {
    container.classList.add('hidden')
    container.innerHTML = ''
    return
  }

  container.classList.remove('hidden')
  container.innerHTML = state.uploads.map((file, idx) => {
    const isImage = file.type === 'image'
    const icon = isImage ? 'image' : (file.mimeType === 'application/pdf' ? 'file-text' : 'file')
    return `
      <div class="flex items-center gap-2 bg-white/70 px-3 py-2 rounded-xl border border-white text-[11px] max-w-[200px]">
        ${isImage && file.url ? `<img src="${file.url}" class="w-6 h-6 rounded object-cover shrink-0">` : `<i data-lucide="${icon}" class="w-4 h-4 opacity-50 shrink-0"></i>`}
        <span class="truncate flex-1">${escHtml(file.name)}</span>
        <button onclick="removeUpload(${idx})" class="p-1 hover:bg-slate-100 rounded transition-colors shrink-0">
          <i data-lucide="x" class="w-3 h-3 opacity-50"></i>
        </button>
      </div>
    `
  }).join('')
  lucide.createIcons({ nodes: [container] })
}

function removeUpload(idx) {
  state.uploads.splice(idx, 1)
  renderUploadPreviews()
}

// ─────────────────────────────────────────────
// Context Compact 事件处理
// ─────────────────────────────────────────────
function onCompactStart(payload) {
  devLog('Compact', '开始压缩上下文, before:', payload.before, 'threshold:', payload.threshold)

  const list = $('msg-list')

  // 创建压缩提示分隔线
  const divider = document.createElement('div')
  divider.id = 'compact-indicator'
  divider.className = 'flex items-center justify-center gap-2 py-3 my-2'
  divider.innerHTML = `
    <div class="flex items-center gap-2 px-4 py-2 bg-amber-50 border border-amber-200 rounded-full">
      <i data-lucide="loader-2" class="w-3.5 h-3.5 text-amber-500 animate-spin"></i>
      <span class="text-[11px] text-amber-600">🔄 正在生成摘要...</span>
    </div>
  `

  list.appendChild(divider)
  lucide.createIcons({ nodes: [divider] })
  scrollToBottom()
}

function onCompactDone(payload) {
  devLog('Compact', '压缩完成, before:', payload.before, 'after:', payload.after, 'saved:', payload.saved)

  // Bug Fix: 移除之前的"正在生成摘要"indicator（如果存在）
  const indicator = $('compact-indicator')
  if (indicator) {
    indicator.remove()
  }

  const ratio = payload.before > 0
    ? Math.round((payload.saved / payload.before) * 100)
    : 0

  // Bug Fix: 在消息列表末尾追加新的分隔线（支持多次compact）
  const list = $('msg-list')
  if (!list) return

  const divider = document.createElement('div')
  divider.className = 'flex items-center justify-center gap-2 py-3 my-2 compact-history-divider'
  divider.innerHTML = `
    <div class="flex flex-col items-center w-full">
      <div class="flex items-center gap-2 px-4 py-2 bg-green-50 border border-green-200 rounded-full cursor-pointer hover:bg-green-100 transition-colors compact-toggle">
        <i data-lucide="check-circle-2" class="w-3.5 h-3.5 text-green-500"></i>
        <span class="text-[11px] text-green-600">上下文已压缩 ${ratio}% (${payload.before} → ${payload.after} tokens)</span>
        <i data-lucide="chevron-down" class="w-3.5 h-3.5 text-green-500 compact-chevron"></i>
      </div>
      <div class="compact-summary hidden mt-2 px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl max-w-[80%]">
        <div class="text-[10px] text-slate-400 mb-1">摘要内容：</div>
        <div class="text-[11px] text-slate-600 leading-relaxed max-h-32 overflow-y-auto">${escHtml(payload.summary || '无摘要')}</div>
      </div>
    </div>
  `

  // 绑定点击展开/折叠事件
  const toggle = divider.querySelector('.compact-toggle')
  const summary = divider.querySelector('.compact-summary')
  const chevron = divider.querySelector('.compact-chevron')

  if (toggle && summary) {
    toggle.addEventListener('click', () => {
      summary.classList.toggle('hidden')
      chevron?.classList.toggle('rotate-180')
    })
  }

  list.appendChild(divider)
  lucide.createIcons({ nodes: [divider] })
  scrollToBottom()
}

// 渲染历史 compact 分隔线（用于页面刷新后恢复显示）
function renderCompactDivider(compact) {
  const list = $('msg-list')
  if (!list) return

  const ratio = compact.original_tokens > 0
    ? Math.round(((compact.original_tokens - compact.compacted_tokens) / compact.original_tokens) * 100)
    : 0

  const divider = document.createElement('div')
  divider.className = 'flex items-center justify-center gap-2 py-3 my-2 compact-history-divider'
  divider.innerHTML = `
    <div class="flex flex-col items-center w-full">
      <div class="flex items-center gap-2 px-4 py-2 bg-slate-50 border border-slate-200 rounded-full cursor-pointer hover:bg-slate-100 transition-colors compact-toggle">
        <i data-lucide="archive" class="w-3.5 h-3.5 text-slate-400"></i>
        <span class="text-[11px] text-slate-500">上下文已压缩 ${ratio}% (${compact.original_tokens} → ${compact.compacted_tokens} tokens)</span>
        <i data-lucide="chevron-down" class="w-3.5 h-3.5 text-slate-400 compact-chevron"></i>
      </div>
      <div class="compact-summary hidden mt-2 px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl max-w-[80%]">
        <div class="text-[10px] text-slate-400 mb-1">摘要内容（${compact.compressed_count} 条消息已压缩）：</div>
        <div class="text-[11px] text-slate-600 leading-relaxed max-h-32 overflow-y-auto">${escHtml(compact.summary || '无摘要')}</div>
      </div>
    </div>
  `

  // 绑定点击展开/折叠事件
  const toggle = divider.querySelector('.compact-toggle')
  const summary = divider.querySelector('.compact-summary')
  const chevron = divider.querySelector('.compact-chevron')

  if (toggle && summary) {
    toggle.addEventListener('click', () => {
      summary.classList.toggle('hidden')
      chevron?.classList.toggle('rotate-180')
    })
  }

  list.appendChild(divider)
  lucide.createIcons({ nodes: [divider] })
}

// ─────────────────────────────────────────────
// 危险操作确认弹窗 (T-7-HITL-1)
// ─────────────────────────────────────────────
// HITL 确认弹窗
// ─────────────────────────────────────────────

let _pendingConfirmationId = null

function showConfirmationDialog(payload) {
  console.log('[HITL-DEBUG] showConfirmationDialog called:', payload)
  const { confirmationId, title, description, riskLevel } = payload
  _pendingConfirmationId = confirmationId

  const titleEl = document.getElementById('confirm-title')
  const descEl = document.getElementById('confirm-description')
  const iconEl = document.getElementById('confirm-icon')
  const btnEl = document.getElementById('confirm-execute-btn')

  if (titleEl) titleEl.textContent = title || '危险操作确认'
  if (descEl) descEl.textContent = description || ''

  if (riskLevel === 'high') {
    if (iconEl) iconEl.className = 'w-10 h-10 bg-red-100 rounded-2xl flex items-center justify-center text-red-600'
    if (btnEl) btnEl.className = 'flex-1 bg-red-500 text-white py-2.5 rounded-2xl text-sm font-bold hover:opacity-80 transition-opacity'
  } else {
    if (iconEl) iconEl.className = 'w-10 h-10 bg-amber-100 rounded-2xl flex items-center justify-center text-amber-600'
    if (btnEl) btnEl.className = 'flex-1 bg-amber-500 text-white py-2.5 rounded-2xl text-sm font-bold hover:opacity-80 transition-opacity'
  }

  const modal = document.getElementById('confirmation-modal')
  if (modal) {
    modal.classList.add('open')
    if (typeof lucide !== 'undefined') lucide.createIcons()
  }
}

async function submitConfirmation() {
  if (!_pendingConfirmationId) return
  const id = _pendingConfirmationId
  _pendingConfirmationId = null

  const modal = document.getElementById('confirmation-modal')
  if (modal) modal.classList.remove('open')

  try {
    await fetch('/api/chat/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ confirmationId: id, action: 'confirm', sessionId: state.currentSession?.id })
    })
  } catch (err) {
    console.error('[HITL] confirm failed:', err)
  }
}

async function cancelConfirmation() {
  if (!_pendingConfirmationId) return
  const id = _pendingConfirmationId
  _pendingConfirmationId = null

  const modal = document.getElementById('confirmation-modal')
  if (modal) modal.classList.remove('open')

  try {
    await fetch('/api/chat/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ confirmationId: id, action: 'cancel', sessionId: state.currentSession?.id })
    })
  } catch (err) {
    console.error('[HITL] cancel failed:', err)
  }
}

// 显示通知
function showNotification(message, type = 'info') {
  const notification = document.createElement('div')
  const colors = {
    info: 'bg-oxygen-blue text-white',
    success: 'bg-green-500 text-white',
    error: 'bg-red-500 text-white',
    warning: 'bg-amber-500 text-white'
  }

  notification.className = `fixed top-4 right-4 px-4 py-3 rounded-xl shadow-lg z-50 text-sm font-medium ${colors[type] || colors.info}`
  notification.style.cssText = 'animation: slideIn 0.3s ease-out;'
  notification.textContent = message

  document.body.appendChild(notification)

  setTimeout(() => {
    notification.style.animation = 'fadeOut 0.3s ease-out'
    setTimeout(() => notification.remove(), 300)
  }, 3000)
}
