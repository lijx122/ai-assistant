// ─────────────────────────────────────────────
// UI 工具函数
// ─────────────────────────────────────────────

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

function renderMarkdown(text) {
  // 极简 markdown: code blocks, inline code, bold, newlines
  return escHtml(text)
    .replace(/```([\s\S]*?)```/g, '<pre class="bg-slate-50 rounded-xl p-3 my-2 text-[11px] overflow-x-auto"><code>$1</code></pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/\n/g, '<br>')
}

function fmtDate(ts) {
  if (!ts) return ''
  const d = new Date(typeof ts === 'number' ? ts : ts)
  const now = new Date()
  const diff = now - d
  if (diff < 86400000) return '今天'
  if (diff < 172800000) return '昨天'
  return `${d.getMonth()+1}月${d.getDate()}日`
}

function autoResizeTextarea(el) {
  el.style.height = 'auto'
  const scrollH = el.scrollHeight
  const maxH = 200

  if (scrollH > maxH) {
    el.style.height = maxH + 'px'
    el.style.overflowY = 'auto'
  } else {
    el.style.height = scrollH + 'px'
    el.style.overflowY = 'hidden'
  }
}

function resetTextareaHeight(el) {
  el.style.height = 'auto'
  el.style.overflowY = 'hidden'
}

function showToast(message) {
  // 移除已有 toast
  document.querySelectorAll('.tree-toast').forEach(t => t.remove())

  const toast = document.createElement('div')
  toast.className = 'tree-toast fixed top-4 right-4 px-4 py-2 bg-slate-800 text-white text-[11px] rounded-lg shadow-lg z-50 flex items-center gap-2'
  toast.innerHTML = `
    <i data-lucide="check-circle" class="w-4 h-4 text-green-400"></i>
    <span>${message}</span>
  `

  document.body.appendChild(toast)
  lucide.createIcons({ nodes: [toast] })

  // 1.5秒后消失
  setTimeout(() => {
    toast.style.opacity = '0'
    toast.style.transition = 'opacity 0.3s'
    setTimeout(() => toast.remove(), 300)
  }, 1500)
}

// 显示错误提示（红色样式）
function showErrorToast(message) {
  // 移除已有 toast
  document.querySelectorAll('.tree-toast').forEach(t => t.remove())

  const toast = document.createElement('div')
  toast.className = 'tree-toast fixed top-4 right-4 px-4 py-2 bg-red-600 text-white text-[11px] rounded-lg shadow-lg z-50 flex items-center gap-2'
  toast.innerHTML = `
    <i data-lucide="alert-circle" class="w-4 h-4"></i>
    <span>${message}</span>
  `

  document.body.appendChild(toast)
  lucide.createIcons({ nodes: [toast] })

  // 3秒后消失（错误信息停留更久）
  setTimeout(() => {
    toast.style.opacity = '0'
    toast.style.transition = 'opacity 0.3s'
    setTimeout(() => toast.remove(), 300)
  }, 3000)
}

// 通用错误边界包装函数
// 用法: safeExecute(() => { ... }) 或 safeExecute(async () => { ... })
// 返回: { success: boolean, result?: any, error?: Error }
async function safeExecute(fn, options = {}) {
  const { silent = false, context = '' } = options

  try {
    const result = await fn()
    return { success: true, result }
  } catch (error) {
    const errorMsg = context ? `${context}: ${error.message}` : error.message

    // 开发模式输出详细错误
    if (typeof devError === 'function') {
      devError('ERROR_BOUNDARY', errorMsg, error)
    } else {
      console.error('[ERROR_BOUNDARY]', errorMsg, error)
    }

    // 显示用户友好的错误提示
    if (!silent) {
      showErrorToast(errorMsg.slice(0, 100)) // 限制长度避免溢出
    }

    return { success: false, error }
  }
}

// 同步版本的 safeExecute
function safeExecuteSync(fn, options = {}) {
  const { silent = false, context = '' } = options

  try {
    const result = fn()
    return { success: true, result }
  } catch (error) {
    const errorMsg = context ? `${context}: ${error.message}` : error.message

    if (typeof devError === 'function') {
      devError('ERROR_BOUNDARY', errorMsg, error)
    } else {
      console.error('[ERROR_BOUNDARY]', errorMsg, error)
    }

    if (!silent) {
      showErrorToast(errorMsg.slice(0, 100))
    }

    return { success: false, error }
  }
}
