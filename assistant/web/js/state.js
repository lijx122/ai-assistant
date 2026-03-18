// ─────────────────────────────────────────────
// 开发者模式与日志开关（由 config.yaml -> /api/config/public 下发）
// ─────────────────────────────────────────────
const RAW_CONSOLE = {
  log: console.log.bind(console),
  info: (console.info || console.log).bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: (console.debug || console.log).bind(console)
}

const DEFAULT_LOGGING_CONFIG = {
  browser_console_enabled: true,
  browser_debug_enabled: false
}

window.__PUBLIC_CONFIG__ = window.__PUBLIC_CONFIG__ || {}
window.__LOGGING_CONFIG__ = {
  ...DEFAULT_LOGGING_CONFIG,
  ...(window.__PUBLIC_CONFIG__.logs || {})
}
window.__DEV__ = !!window.__LOGGING_CONFIG__.browser_debug_enabled

const isDebugLine = (firstArg) =>
  typeof firstArg === 'string' && /\[[A-Z-]*DEBUG\]/.test(firstArg)

function updateDevBadge() {
  const badge = document.getElementById('dev-badge')
  if (badge) {
    badge.classList.toggle('hidden', !window.__DEV__)
  }
}

function patchBrowserConsole() {
  const cfg = window.__LOGGING_CONFIG__ || DEFAULT_LOGGING_CONFIG
  const consoleEnabled = !!cfg.browser_console_enabled
  const debugEnabled = !!cfg.browser_debug_enabled

  console.log = (...args) => {
    if (!consoleEnabled) return
    if (!debugEnabled && isDebugLine(args[0])) return
    RAW_CONSOLE.log(...args)
  }
  console.info = (...args) => {
    if (!consoleEnabled) return
    if (!debugEnabled && isDebugLine(args[0])) return
    RAW_CONSOLE.info(...args)
  }
  console.warn = (...args) => {
    if (!consoleEnabled) return
    if (!debugEnabled && isDebugLine(args[0])) return
    RAW_CONSOLE.warn(...args)
  }
  console.error = (...args) => {
    if (!consoleEnabled) return
    if (!debugEnabled && isDebugLine(args[0])) return
    RAW_CONSOLE.error(...args)
  }
  console.debug = (...args) => {
    if (!consoleEnabled) return
    if (!debugEnabled && isDebugLine(args[0])) return
    RAW_CONSOLE.debug(...args)
  }
}

window.applyLoggingConfig = function(partialConfig = {}) {
  window.__LOGGING_CONFIG__ = {
    ...(window.__LOGGING_CONFIG__ || DEFAULT_LOGGING_CONFIG),
    ...partialConfig
  }
  window.__DEV__ = !!window.__LOGGING_CONFIG__.browser_debug_enabled
  patchBrowserConsole()
  updateDevBadge()
}

window.applyPublicConfig = function(publicConfig = {}) {
  window.__PUBLIC_CONFIG__ = publicConfig
  if (publicConfig.logs) {
    window.applyLoggingConfig(publicConfig.logs)
  }
}

patchBrowserConsole()
document.addEventListener('DOMContentLoaded', updateDevBadge)

window.devLog = function(module, ...args) {
  if (!window.__DEV__) return
  const time = new Date().toISOString().substr(11, 12)
  console.log(`[${time}][${module}]`, ...args)
}

window.devWarn = function(module, ...args) {
  if (!window.__DEV__) return
  console.warn(`[${module}]`, ...args)
}

window.devError = function(module, ...args) {
  console.error(`[${module}]`, ...args)
}

window.devEnable = () => {
  console.warn('[DEV] 已改为 config.yaml 控制，请设置 logs.browser_debug_enabled=true 并重启服务')
}

window.devDisable = () => {
  console.warn('[DEV] 已改为 config.yaml 控制，请设置 logs.browser_debug_enabled=false 并重启服务')
}

// ─────────────────────────────────────────────
// 状态
// ─────────────────────────────────────────────
const state = {
  workspaces: [],
  currentWs: null,       // { id, name, ... }
  sessions: [],
  currentSession: null,  // { id, ... }
  messages: [],          // 渲染用，{ role, content, toolCalls, id }
  streaming: false,
  isSending: false,       // 发送锁，防止重复提交
  streamBuf: '',          // 当前流式文字缓冲
  streamMsgId: null,
  ws: null,              // WebSocket
  ctxTurns: 0,
  systemStatus: {},
  terminals: [],         // { id, title, cwd, ws, xterm, fitAddon, container }
  currentTerminal: null, // 当前活跃的终端 id
  maxTerminals: 5,
  uploads: [],           // 当前待发送的文件附件 { id, name, type, base64?, content?, url? }
  // 编辑器状态
  editor: null,          // Monaco editor 实例
  editorFiles: [],       // 打开的文件列表 { id, path, content, originalContent, language, isModified }
  currentEditorFile: null, // 当前编辑的文件 id
  // 文件树状态（VSCode 树形模式）
  treeNodes: new Map(),  // Map<path, TreeNode> 所有加载过的节点
  expandedPaths: new Set(['.']), // 展开的目录路径集合，默认展开根目录
  selectedTreePath: null, // 当前选中的路径
  newFileTargetPath: '.', // 新建文件的目标目录
  newFolderTargetPath: '.', // 新建目录的目标目录
  clipboard: null, // { type: 'cut'|'copy', path, isDirectory }
  isEditorLoading: false,
  // 工作区切换相关
  pendingWorkspaceSwitch: null, // 待切换的目标工作区
}

// ─────────────────────────────────────────────
// 基础工具函数
// ─────────────────────────────────────────────
const $ = id => document.getElementById(id)
const uid = () => Math.random().toString(36).slice(2)
