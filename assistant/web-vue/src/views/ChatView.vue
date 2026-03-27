<template>
  <div class="flex flex-1 min-h-0 gap-3">

    <!-- 左侧会话列表 -->
    <div class="w-56 tactile-container flex flex-col overflow-hidden shrink-0">
      <div class="px-5 pt-5 pb-3 shrink-0">
        <div class="flex items-center justify-between mb-3">
          <p class="text-[9px] font-bold uppercase tracking-[0.2em] opacity-30">
            会话记录
          </p>
          <button @click="newSession"
            class="w-6 h-6 rounded-lg bg-oxygen-blue/10 hover:bg-oxygen-blue/20
                   flex items-center justify-center transition-colors">
            <Plus class="w-3 h-3 text-oxygen-blue"/>
          </button>
        </div>
        <!-- 工作区显示 -->
        <div class="flex items-center gap-2 bg-white/70 px-3 py-2 rounded-2xl
                    border border-white text-[10px] font-mono opacity-60">
          <FolderOpen class="w-3 h-3"/>
          <span class="truncate">
            {{ store.currentWorkspace?.name || '—' }}
          </span>
        </div>
      </div>
      <!-- 会话列表 -->
      <div class="flex-1 overflow-y-auto no-scrollbar px-3 pb-4 space-y-1">
        <div v-if="isSessionsLoading" class="space-y-2 py-1">
          <div v-for="i in 6" :key="`session-skeleton-${i}`"
            class="h-9 rounded-2xl wb-skeleton"></div>
        </div>
        <div v-else-if="!sessions.length"
          class="flex flex-col items-center justify-center py-8 text-slate-400">
          <svg class="w-14 h-14 mb-3 opacity-70" viewBox="0 0 64 64" fill="none" aria-hidden="true">
            <rect x="10" y="14" width="44" height="36" rx="10" stroke="currentColor" stroke-width="2"/>
            <path d="M22 28h20M22 35h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            <circle cx="46" cy="26" r="2" fill="currentColor"/>
          </svg>
          <p class="text-[11px] font-mono">暂无会话</p>
        </div>
        <div v-else>
          <transition-group name="wb-fade" tag="div" class="space-y-1">
            <div v-for="s in sessions" :key="s.id"
              @click="selectSession(s)"
              :class="['w-full text-left px-3 py-2.5 rounded-2xl text-[12px]',
                       'transition-colors group flex items-center gap-2 cursor-pointer',
                       store.currentSession?.id === s.id
                         ? 'bg-white shadow-sm font-medium'
                         : 'hover:bg-white/60']">
              <MessageCircle class="w-3 h-3 opacity-30 shrink-0"/>
              <span class="truncate flex-1">
                {{ s.title || '新会话' }}
              </span>
              <span @click.stop="exportSession(s)"
                class="opacity-0 group-hover:opacity-30 hover:!opacity-70
                       transition-opacity p-0.5 rounded cursor-pointer"
                title="导出为 Markdown">
                <Download class="w-3 h-3"/>
              </span>
              <span @click.stop="deleteSession(s.id)"
                class="opacity-0 group-hover:opacity-30 hover:!opacity-70
                       transition-opacity p-0.5 rounded cursor-pointer">
                <X class="w-3 h-3"/>
              </span>
            </div>
          </transition-group>
        </div>
      </div>
    </div>

    <!-- 主对话区 -->
    <div class="flex-1 flex flex-col gap-3 min-h-0 min-w-0">
      <!-- 状态栏 -->
      <div class="flex items-center justify-between px-1">
        <div class="flex items-center gap-3">
          <div class="flex items-center gap-1.5 bg-slate-100 px-3 py-1.5
                      rounded-full text-[10px] font-mono text-slate-500">
            <Layers class="w-3 h-3"/>
            <span>上下文: {{ messages.length }} / 20 轮</span>
          </div>
        </div>
        <div class="text-[10px] font-mono opacity-30 flex items-center gap-1.5">
          <Globe class="w-3 h-3"/>渠道: Web
        </div>
      </div>

      <!-- 消息列表 -->
      <div ref="msgList"
        :key="messagePaneKey"
        @click="handleMessagePaneClick"
        class="flex-1 tactile-container p-7 flex flex-col no-scrollbar
               overflow-y-auto space-y-5 min-h-0 wb-message-pane">
        <!-- 空状态 -->
        <div v-if="!messages.length"
          class="flex-1 flex flex-col items-center justify-center text-slate-400">
          <svg class="w-20 h-20 mb-4 opacity-70" viewBox="0 0 96 96" fill="none" aria-hidden="true">
            <rect x="16" y="20" width="64" height="44" rx="14" stroke="currentColor" stroke-width="2.5"/>
            <path d="M30 38h36M30 46h24" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
            <path d="M44 64l4 8 4-8" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <p class="text-sm font-light">选择工作区，开始对话</p>
        </div>

        <!-- 消息气泡 -->
        <div v-for="msg in messages" :key="msg.id"
          :class="['flex gap-3',
                   msg.role === 'user' ? 'justify-end' : 'justify-start']">
          <!-- AI 头像 -->
          <div v-if="msg.role === 'assistant'"
            class="w-7 h-7 rounded-xl bg-deep-charcoal flex items-center
                   justify-center text-white text-[10px] font-bold shrink-0 mt-1">
            W
          </div>
          <!-- 消息内容 -->
          <div :class="['max-w-[75%] rounded-2xl px-4 py-3 text-sm leading-relaxed relative group',
                        msg.role === 'user'
                          ? 'bg-oxygen-blue text-white rounded-br-sm'
                          : 'bg-white shadow-sm rounded-bl-sm']">
            <!-- 工具调用块 -->
            <div v-if="hasToolUse(msg)"
              class="mb-2 space-y-2">
              <div v-for="block in getToolBlocks(msg)" :key="block.id"
                :class="['bg-slate-50 rounded-2xl text-[11px] font-mono',
                         'text-slate-500 border max-w-[85%] overflow-hidden',
                         'transition-all duration-200',
                         block.success === false ? 'border-red-100' : 'border-slate-100']">
                <button
                  class="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-white/50 transition-colors"
                  @click="toggleToolBlock(block.id)">
                  <XCircle v-if="block.success === false"
                    class="w-3.5 h-3.5 text-red-400 shrink-0"/>
                  <CheckCircle v-else class="w-3.5 h-3.5 text-green-500 shrink-0"/>
                  <span class="font-medium text-slate-600 flex-1 min-w-0 truncate">{{ block.name }}</span>
                  <span v-if="block.success === false"
                    class="text-[9px] text-red-400 opacity-80">失败</span>
                  <span v-else class="text-[9px] text-green-600 opacity-60">完成</span>
                  <ChevronDown class="w-3.5 h-3.5 opacity-40 transition-transform"
                    :class="isToolBlockExpanded(block.id) ? 'rotate-180' : ''"/>
                </button>
                <transition name="wb-collapse">
                  <div v-if="isToolBlockExpanded(block.id)" class="px-4 pb-3">
                    <pre class="text-[10px] text-slate-400 overflow-x-auto
                                whitespace-pre-wrap break-all max-h-20">{{
                      JSON.stringify(block.input, null, 2).slice(0, 300)
                    }}</pre>
                    <div v-if="block.output"
                      :class="['mt-2 pt-2 border-t text-[10px] whitespace-pre-wrap',
                               'break-all max-h-20 overflow-x-auto',
                               block.success === false
                                 ? 'border-red-100 text-red-400'
                                 : 'border-slate-100 text-slate-500']">
                      {{ extractErrorOrOutput(block.output) }}
                    </div>
                  </div>
                </transition>
              </div>
            </div>
            <!-- 文本内容（Markdown） -->
            <div v-if="getTextContent(msg)"
              class="prose prose-sm max-w-none wb-markdown"
              :class="msg.role === 'user' ? 'prose-invert wb-markdown-user' : ''"
              v-html="renderMarkdown(getTextContent(msg))">
            </div>
            <!-- 用户消息编辑按钮 -->
            <div v-if="msg.role === 'user' && !msg.id.startsWith('temp-')"
              class="absolute -right-8 top-0 opacity-0 group-hover:opacity-100 transition-opacity flex gap-1">
              <button @click="startBranchMessage(msg)"
                class="p-1 rounded-lg bg-white/80 shadow-sm hover:bg-green-50 transition-colors"
                title="从这条消息创建分支">
                <GitBranch class="w-3.5 h-3.5 text-green-600"/>
              </button>
              <button @click="startEditMessage(msg)"
                class="p-1 rounded-lg bg-white/80 shadow-sm hover:bg-white transition-colors"
                title="编辑消息">
                <Pencil class="w-3.5 h-3.5 text-slate-500"/>
              </button>
            </div>
            <!-- AI 消息分支按钮 -->
            <div v-if="msg.role === 'assistant' && !store.isStreaming"
              class="absolute -right-8 top-0 opacity-0 group-hover:opacity-100 transition-opacity">
              <button @click="startBranchMessage(msg)"
                class="p-1 rounded-lg bg-white/80 shadow-sm hover:bg-green-50 transition-colors"
                title="从这条消息创建分支">
                <GitBranch class="w-3.5 h-3.5 text-green-600"/>
              </button>
            </div>
          </div>
          <!-- 用户头像 -->
          <div v-if="msg.role === 'user'"
            class="w-7 h-7 rounded-xl bg-slate-200 flex items-center
                   justify-center text-[10px] font-bold shrink-0 mt-1">
            A
          </div>
        </div>

        <!-- 流式输出中的临时消息 -->
        <div v-if="store.isStreaming || streamingToolCalls.length || streamingText"
          class="flex gap-3 justify-start">
          <div class="w-7 h-7 rounded-xl bg-deep-charcoal flex items-center
                      justify-center text-white text-[10px] font-bold shrink-0 mt-1">W</div>
          <div class="flex-1 min-w-0 space-y-2">

            <!-- 工具调用卡片列表 -->
            <div v-for="tool in streamingToolCalls" :key="tool.id"
              :class="['bg-slate-50 rounded-2xl border max-w-[85%] overflow-hidden',
                       'transition-all duration-200',
                       tool.status === 'error' ? 'border-red-100' : 'border-slate-100']">
              <button
                class="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-white/50 transition-colors"
                @click="toggleToolBlock(tool.id)">
                <!-- 状态图标 -->
                <Loader2 v-if="tool.status === 'running'"
                  class="w-3.5 h-3.5 text-oxygen-blue animate-spin shrink-0"/>
                <CheckCircle v-else-if="tool.status === 'done'"
                  class="w-3.5 h-3.5 text-green-500 shrink-0"/>
                <XCircle v-else-if="tool.status === 'error'"
                  class="w-3.5 h-3.5 text-red-400 shrink-0"/>
                <!-- 工具名 -->
                <span class="text-[11px] font-mono font-medium text-slate-600 flex-1 min-w-0 truncate">
                  {{ tool.name }}
                </span>
                <!-- 状态文字 -->
                <span v-if="tool.status === 'running'"
                  class="text-[9px] font-mono text-oxygen-blue opacity-60">
                  执行中...
                </span>
                <span v-else-if="tool.status === 'done'"
                  class="text-[9px] font-mono text-green-600 opacity-60">
                  完成
                </span>
                <span v-else-if="tool.status === 'error'"
                  class="text-[9px] font-mono text-red-400 opacity-80">
                  失败
                </span>
                <ChevronDown class="w-3.5 h-3.5 opacity-40 transition-transform"
                  :class="isToolBlockExpanded(tool.id) ? 'rotate-180' : ''"/>
              </button>
              <transition name="wb-collapse">
                <div v-if="isToolBlockExpanded(tool.id)" class="px-4 pb-3">
                  <!-- 输入参数 -->
                  <pre class="text-[10px] font-mono text-slate-400 overflow-x-auto
                              whitespace-pre-wrap break-all leading-relaxed max-h-20">{{
                    JSON.stringify(tool.input, null, 2).slice(0, 300)
                  }}</pre>
                  <!-- 输出结果（完成后显示）-->
                  <div v-if="tool.output"
                    :class="['mt-2 pt-2 border-t text-[10px] font-mono overflow-x-auto',
                             'whitespace-pre-wrap break-all max-h-20',
                             tool.status === 'error'
                               ? 'border-red-100 text-red-400'
                               : 'border-slate-100 text-slate-500']">
                    {{ extractErrorOrOutput(tool.output) }}
                  </div>
                </div>
              </transition>
            </div>

            <!-- 文字流式气泡 -->
            <div v-if="streamingText || (store.isStreaming && !streamingToolCalls.length)"
              class="bg-white shadow-sm rounded-2xl rounded-bl-sm px-4 py-3
                     text-sm leading-relaxed max-w-[75%]">
              <div v-if="streamingText"
                class="prose prose-sm max-w-none wb-markdown"
                v-html="renderMarkdown(streamingText)"/>
              <!-- 等待动画 -->
              <div v-if="store.isStreaming && !streamingText && !streamingToolCalls.length"
                class="flex gap-1.5 items-center py-1">
                <span class="w-1.5 h-1.5 rounded-full bg-slate-300 animate-bounce"
                  style="animation-delay:0ms"/>
                <span class="w-1.5 h-1.5 rounded-full bg-slate-300 animate-bounce"
                  style="animation-delay:150ms"/>
                <span class="w-1.5 h-1.5 rounded-full bg-slate-300 animate-bounce"
                  style="animation-delay:300ms"/>
              </div>
              <!-- 光标 -->
              <span v-if="store.isStreaming && streamingText"
                class="inline-block w-0.5 h-3.5 bg-slate-400 ml-0.5
                       animate-pulse rounded-full align-middle"/>
            </div>

          </div>
        </div>
      </div>

      <!-- 输入区 -->
      <div class="tactile-container px-7 py-3 flex items-end gap-6
                  bg-white/40 min-h-[76px] shrink-0">
        <!-- 编辑模式 -->
        <template v-if="editingMessage">
          <button @click="cancelEditMessage"
            class="shrink-0 mb-3 hover:opacity-70 transition-opacity"
            title="取消编辑">
            <X class="w-[18px] h-[18px] text-slate-400"/>
          </button>
          <textarea ref="inputEl"
            v-model="editingText"
            rows="1"
            placeholder="编辑消息..."
            class="flex-1 bg-white/80 border border-oxygen-blue/30 rounded-xl
                   outline-none font-light min-w-0 resize-none py-2"
            style="min-height:44px;max-height:200px;font-size:15px;
                   padding:10px 14px 14px;line-height:1.6;"
            @input="autoResize">
          </textarea>
          <button @click="submitEditMessage"
            :disabled="store.isStreaming || !editingText.trim()"
            class="bg-oxygen-blue text-white p-2.5 rounded-2xl shadow-md
                   shadow-oxygen-blue/20 shrink-0 hover:opacity-90 hover:-translate-y-0.5
                   transition-all mb-1 disabled:opacity-40 disabled:hover:translate-y-0"
            title="重新发送">
            <RotateCcw class="w-4 h-4"/>
          </button>
        </template>
        <!-- 正常输入模式 -->
        <template v-else>
          <button class="shrink-0 mb-3 hover:opacity-70 transition-opacity">
            <Paperclip class="w-[18px] h-[18px] opacity-40"/>
          </button>
          <textarea ref="inputEl"
            v-model="inputText"
            rows="1"
            placeholder="向 Claude 下达指令… 输入 / 查看命令"
            class="flex-1 bg-transparent border-none outline-none font-light
                   min-w-0 resize-none py-2"
            style="min-height:44px;max-height:200px;font-size:15px;
                   padding:10px 14px 14px;line-height:1.6;"
            @keydown="handleKeydown"
            @input="autoResize">
          </textarea>
        <!-- 深度研究模式选择 -->
        <div class="relative">
          <button @click="drPickerOpen = !drPickerOpen"
            :class="['flex items-center gap-1.5 px-3 py-1.5 rounded-xl',
                     'text-[11px] font-mono transition-all shrink-0 mb-1 border',
                     deepResearchMode
                       ? 'bg-oxygen-blue text-white border-oxygen-blue'
                       : 'border-slate-200 text-slate-400 hover:border-slate-300']"
            title="选择研究模式">
            <Telescope class="w-3.5 h-3.5"/>
            <span>{{ drModeLabel }}</span>
            <ChevronDown class="w-3 h-3 opacity-60"/>
          </button>

          <div v-if="drPickerOpen"
            class="absolute bottom-full mb-1 left-0 bg-white rounded-2xl
                   shadow-xl border border-slate-100 py-1.5 min-w-40 z-50">
            <button @click="setDRMode(null)"
              class="w-full text-left px-4 py-2 text-[11px] hover:bg-slate-50">
              关闭深度研究
            </button>
            <div class="border-t border-slate-100 my-1"/>
            <button @click="setDRMode('web')"
              class="w-full text-left px-4 py-2 text-[11px] hover:bg-slate-50">
              🌐 网络深度研究
            </button>
            <button @click="setDRMode('codebase')"
              class="w-full text-left px-4 py-2 text-[11px] hover:bg-slate-50">
              📁 工作区代码分析
            </button>
            <button @click="setDRMode('github')"
              class="w-full text-left px-4 py-2 text-[11px] hover:bg-slate-50">
              🐙 GitHub 项目分析
            </button>
            <button @click="setDRMode('github-deep')"
              class="w-full text-left px-4 py-2 text-[11px] hover:bg-slate-50">
              🔬 GitHub 深度分析（含 clone）
            </button>
          </div>
        </div>
        <div class="flex items-center gap-1 opacity-30 shrink-0 mb-3">
          <kbd class="px-1.5 py-0.5 bg-white rounded border border-slate-200 text-[9px]">
            ⌘</kbd>
          <kbd class="px-1.5 py-0.5 bg-white rounded border border-slate-200 text-[9px]">
            Enter</kbd>
        </div>
        <button @click="sendMessage" :disabled="store.isStreaming || !inputText.trim()"
          class="bg-oxygen-blue text-white p-2.5 rounded-2xl shadow-md
                 shadow-oxygen-blue/20 shrink-0 hover:opacity-90 hover:-translate-y-0.5
                 transition-all mb-1 disabled:opacity-40 disabled:hover:translate-y-0">
          <Send class="w-4 h-4"/>
        </button>
        </template>
      </div>
    </div>

    <!-- 右侧 Todo 面板 -->
    <div class="w-48 tactile-container flex flex-col overflow-hidden shrink-0">
      <div class="px-4 pt-4 pb-3 shrink-0 border-b border-slate-100/50">
        <div class="flex items-center justify-between">
          <p class="text-[9px] font-bold uppercase tracking-[0.2em] opacity-30">
            自动执行队列
          </p>
          <label class="flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" v-model="autoExecute"
              class="w-3 h-3 rounded"/>
          </label>
        </div>
        <p class="text-[9px] font-mono opacity-30 mt-1">
          {{ autoExecute ? '已开启' : '未开启自动执行' }}
        </p>
      </div>
      <div class="flex-1 overflow-y-auto no-scrollbar p-3 space-y-1.5">
        <div v-if="isTodoLoading" class="space-y-2 py-1">
          <div v-for="i in 5" :key="`todo-skeleton-${i}`"
            class="h-6 rounded-xl wb-skeleton"></div>
        </div>
        <div v-else-if="!todoItems.length"
          class="flex flex-col items-center justify-center py-8 text-slate-400">
          <svg class="w-12 h-12 mb-2 opacity-70" viewBox="0 0 64 64" fill="none" aria-hidden="true">
            <rect x="14" y="10" width="36" height="44" rx="9" stroke="currentColor" stroke-width="2"/>
            <path d="M24 10.5h16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            <path d="M22 26h20M22 34h20M22 42h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
          <p class="text-[10px] font-mono">暂无待办</p>
        </div>
        <div v-else>
          <div v-for="item in todoItems" :key="item.text"
            :class="['flex items-start gap-2 px-2 py-1.5 rounded-xl',
                     item.done ? 'opacity-40' : '']">
            <div :class="['w-3.5 h-3.5 rounded-full border shrink-0 mt-0.5',
                          'flex items-center justify-center',
                          item.done
                            ? 'bg-green-500 border-green-500'
                            : 'border-slate-300']">
              <Check v-if="item.done" class="w-2 h-2 text-white"/>
            </div>
            <span :class="['text-[11px] leading-tight',
                           item.done ? 'line-through' : '']">
              {{ item.text }}
            </span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick, onUnmounted } from 'vue'
import { useAppStore } from '../stores/app'
import { api } from '../api'
import {
  Plus, FolderOpen, MessageCircle, X, Layers, Globe,
  Paperclip, Send, Check, CheckCircle, Loader2, XCircle, ChevronDown, Telescope, Download, Pencil, RotateCcw, GitBranch
} from 'lucide-vue-next'

const store = useAppStore()
const sessions = ref([])
const messages = ref([])
const inputText = ref('')
const msgList = ref(null)
const inputEl = ref(null)
const streamingText = ref('')
const streamingToolCalls = ref([])  // 流式工具调用列表
const autoExecute = ref(false)
const todoItems = ref([])
const isSessionsLoading = ref(true)
const isTodoLoading = ref(true)
const messagePaneKey = ref(0)
const expandedToolBlocks = ref({})
const drMode = ref(null)
const drPickerOpen = ref(false)
const deepResearchMode = computed(() => drMode.value !== null)
const drModeLabel = computed(() => ({
  null: '深度研究',
  web: '网络研究',
  codebase: '代码分析',
  github: 'GitHub分析',
  'github-deep': 'GitHub深研',
}[drMode.value ?? 'null'] || '深度研究'))

// 编辑重发状态
const editingMessage = ref(null)  // 正在编辑的消息
const editingText = ref('')       // 编辑中的文本
let ws = null
let currentMsgId = null

// ── 会话管理 ──

async function loadSessions() {
  if (!store.currentWorkspace) return
  isSessionsLoading.value = true
  try {
    const data = await api.get(
      `/api/sessions?workspaceId=${store.currentWorkspace.id}`)
    sessions.value = data?.sessions || []
  } finally {
    isSessionsLoading.value = false
  }
}

async function selectSession(s) {
  store.setSession(s)
  const data = await api.get(`/api/sessions/${s.id}/messages`)
  if (data?.messages) messages.value = parseMessages(data.messages)
  expandedToolBlocks.value = {}
  messagePaneKey.value += 1
  await nextTick()
  scrollToBottom()
  await loadTodo()
}

async function newSession() {
  if (!store.currentWorkspace) return
  const data = await api.post('/api/sessions', {
    workspaceId: store.currentWorkspace.id
  })
  if (data?.session) {
    await loadSessions()
    await selectSession(data.session)
  }
}

async function deleteSession(id) {
  await api.delete(`/api/sessions/${id}`)
  if (store.currentSession?.id === id) {
    store.setSession(null)
    messages.value = []
  }
  await loadSessions()
}

async function exportSession(s) {
  const filename = `${(s.title || '会话记录').replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_')}_${s.id.slice(0, 8)}.md`
  // 直接下载
  window.open(`/api/sessions/${s.id}/export`, '_blank')
}

// ── 编辑重发 ──

function startEditMessage(msg) {
  editingMessage.value = msg
  editingText.value = getTextContent(msg) || ''
}

function cancelEditMessage() {
  editingMessage.value = null
  editingText.value = ''
}

async function submitEditMessage() {
  if (!editingMessage.value || !editingText.value.trim()) return
  if (!store.currentSession) return

  const msg = editingMessage.value
  const newContent = editingText.value.trim()

  // 更新消息内容并删除后续消息
  await api.put(`/api/chat/messages/${msg.id}`, {
    content: newContent
  })

  // 重新加载消息
  const data = await api.get(`/api/sessions/${store.currentSession.id}/messages`)
  if (data?.messages) {
    messages.value = parseMessages(data.messages)
  }

  // 清除编辑状态
  editingMessage.value = null
  editingText.value = ''
  await nextTick()
  scrollToBottom()

  // 重新发送消息触发 AI 回复
  await api.post('/api/chat', {
    sessionId: store.currentSession.id,
    workspaceId: store.currentWorkspace.id,
    content: newContent,
  })
}

// ── 分支功能 ──

async function startBranchMessage(msg) {
  if (!store.currentSession) return

  try {
    const data = await api.post(`/api/sessions/${store.currentSession.id}/branch`, {
      branchFromMessageId: msg.id,
    })

    if (data?.success && data.newSessionId) {
      // 切换到新分支会话
      await loadSessions()
      // 找到新创建的会话并选中
      const newSession = sessions.value.find(s => s.id === data.newSessionId)
      if (newSession) {
        await selectSession(newSession)
      }
    }
  } catch (e) {
    console.error('[Branch] Failed to create branch:', e)
  }
}

// ── 消息处理 ──

function tryParseContent(content) {
  if (typeof content === 'string') {
    try { return JSON.parse(content) } catch { return content }
  }
  return content
}

function isOnlyToolResult(content) {
  return Array.isArray(content) &&
    content.every(b => b.type === 'tool_result')
}

function parseMessages(raw) {
  // 第一遍：收集所有 tool_result
  const toolOutputs = {}
  raw.forEach(msg => {
    if (msg.role === 'user') {
      const content = tryParseContent(msg.content)
      if (Array.isArray(content)) {
        content.forEach(block => {
          if (block.type === 'tool_result') {
            toolOutputs[block.tool_use_id] = block.content
          }
        })
      }
    }
  })

  // 第二遍：过滤并注入 tool_use 的 output
  return raw
    .filter(msg => {
      // 过滤掉仅包含 tool_result 的 user 消息
      if (msg.role === 'user') {
        const content = tryParseContent(msg.content)
        if (isOnlyToolResult(content)) return false
      }
      return true
    })
    .map(msg => {
      const content = tryParseContent(msg.content)
      // 给 assistant 消息中的 tool_use 注入 output
      if (msg.role === 'assistant' && Array.isArray(content)) {
        return {
          ...msg,
          content: content.map(block => {
            if (block.type === 'tool_use' && toolOutputs[block.id]) {
              const raw = toolOutputs[block.id]
              let success = true
              try {
                const p = typeof raw === 'string' ? JSON.parse(raw) : raw
                success = p?.success !== false
              } catch {}
              return { ...block, output: raw, success }
            }
            return block
          })
        }
      }
      return { ...msg, content }
    })
}

function extractErrorOrOutput(output) {
  if (!output) return ''
  try {
    const parsed = typeof output === 'string' ? JSON.parse(output) : output
    if (parsed?.error) return '错误: ' + parsed.error
    if (parsed?.success === false) return parsed.error || '执行失败'
    if (parsed?.output !== undefined) return String(parsed.output).slice(0, 200)
    return JSON.stringify(parsed).slice(0, 200)
  } catch {
    return String(output).slice(0, 200)
  }
}

function hasToolUse(msg) {
  return Array.isArray(msg.content) &&
    msg.content.some(b => b.type === 'tool_use')
}

function getToolBlocks(msg) {
  if (!Array.isArray(msg.content)) return []
  return msg.content.filter(b => b.type === 'tool_use')
}

function isToolBlockExpanded(id) {
  return expandedToolBlocks.value[id] !== false
}

function toggleToolBlock(id) {
  expandedToolBlocks.value[id] = !isToolBlockExpanded(id)
}

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function decodeHtmlEntities(text) {
  const el = document.createElement('textarea')
  el.innerHTML = text || ''
  return el.value
}

function encodeCodePayload(text) {
  try {
    return btoa(unescape(encodeURIComponent(text)))
  } catch {
    return ''
  }
}

function decodeCodePayload(payload) {
  try {
    return decodeURIComponent(escape(atob(payload)))
  } catch {
    return ''
  }
}

function normalizeCodeLang(lang) {
  if (!lang) return ''
  const clean = lang.trim().toLowerCase().split(/\s+/)[0]
  return clean.replace(/^language-/, '')
}

function codeLangLabel(lang) {
  const normalized = normalizeCodeLang(lang)
  return normalized || 'text'
}

function renderCodeBlock(codeHtml, langRaw) {
  const code = decodeHtmlEntities(codeHtml)
  const lang = normalizeCodeLang(langRaw)
  const hljs = window.hljs
  let highlighted = escapeHtml(code)

  if (hljs) {
    try {
      if (lang && hljs.getLanguage?.(lang)) {
        highlighted = hljs.highlight(code, { language: lang }).value
      } else {
        highlighted = hljs.highlightAuto(code).value
      }
    } catch {
      highlighted = escapeHtml(code)
    }
  }

  const payload = encodeCodePayload(code)
  return `<div class="wb-codeblock"><div class="wb-codeblock-head"><span class="wb-codeblock-lang">${escapeHtml(codeLangLabel(langRaw))}</span><button class="wb-codeblock-copy" type="button" data-copy-code="${payload}">复制</button></div><pre><code class="hljs ${lang ? `language-${escapeHtml(lang)}` : ''}">${highlighted}</code></pre></div>`
}

function enhanceMarkdownHtml(html) {
  if (!html) return ''
  return html.replace(
    /<pre><code(?: class="language-([^"]+)")?>([\s\S]*?)<\/code><\/pre>/g,
    (_, lang, code) => renderCodeBlock(code, lang || '')
  )
}

function handleMessagePaneClick(e) {
  const target = e.target?.closest?.('[data-copy-code]')
  if (!target) return
  const payload = target.getAttribute('data-copy-code') || ''
  const code = decodeCodePayload(payload)
  if (!code) return
  navigator.clipboard?.writeText(code)
  target.textContent = '已复制'
  setTimeout(() => {
    target.textContent = '复制'
  }, 1200)
}

function getTextContent(msg) {
  if (typeof msg.content === 'string') return msg.content
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
  }
  return ''
}

function renderMarkdown(text) {
  if (!text) return ''
  if (typeof window.marked === 'undefined') return text
  const html = window.marked.parse(text)
  return enhanceMarkdownHtml(html)
}

// ── 发送消息 ──

let isSending = false

async function sendMessage() {
  let text = inputText.value.trim()
  if (!text || store.isStreaming || isSending) return
  if (!store.currentSession) {
    await newSession()
  }

  isSending = true
  inputText.value = ''
  if (inputEl.value) {
    inputEl.value.style.height = 'auto'
  }

  // 深度研究模式：注入工具调用指令
  if (drMode.value) {
    if (drMode.value === 'web') {
      text = `请使用 deep_research 工具（mode: web）研究：\n\n${text}`
    } else if (drMode.value === 'codebase') {
      text = `请使用 deep_research 工具（mode: codebase）分析当前工作区，重点关注：\n\n${text}`
    } else if (drMode.value === 'github') {
      text = `请使用 deep_research 工具（mode: github, clone_depth: false）分析项目：\n\n${text}`
    } else if (drMode.value === 'github-deep') {
      text = `请使用 deep_research 工具（mode: github, clone_depth: true）深度分析项目（包括 clone 代码）：\n\n${text}`
    }
  }

  // 乐观更新：立即显示用户消息
  messages.value.push({
    id: 'temp-' + Date.now(),
    role: 'user',
    content: text,
  })
  await nextTick()
  scrollToBottom()

  // 初始化流式状态
  store.isStreaming = true
  streamingText.value = ''
  streamingToolCalls.value = []

  try {
    await api.post('/api/chat', {
      sessionId: store.currentSession.id,
      workspaceId: store.currentWorkspace.id,
      content: text,
    })
  } catch(e) {
    store.isStreaming = false
    isSending = false
  } finally {
    isSending = false
  }
}

function setDRMode(mode) {
  drMode.value = mode
  drPickerOpen.value = false
}

function handleKeydown(e) {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault()
    sendMessage()
  }
}

function autoResize(e) {
  const el = e.target
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 200) + 'px'
}

function scrollToBottom() {
  if (msgList.value) {
    msgList.value.scrollTop = msgList.value.scrollHeight
  }
}

// ── WebSocket ──

async function syncCurrentSessionMessages() {
  if (!store.currentSession) return
  try {
    const data = await api.get(`/api/sessions/${store.currentSession.id}/messages`)
    if (data?.messages) {
      messages.value = parseMessages(data.messages)
      await nextTick()
      scrollToBottom()
    }
  } catch (e) {
    console.error('[WS] sync messages failed:', e)
  }
}

function connectWS() {
  if (!store.currentWorkspace) return
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  ws = new WebSocket(
    `${proto}://${location.host}/ws/chat/${store.currentWorkspace.id}`)

  ws.onopen = () => {
    console.log('[WS] connected to workspace:', store.currentWorkspace?.id)
  }

  ws.onmessage = (evt) => {
    try {
      const msg = JSON.parse(evt.data)
      handleWSMessage(msg)
    } catch (e) {
      console.error('[WS] parse error:', e, evt.data?.slice(0, 100))
    }
  }

  ws.onclose = () => {
    console.log('[WS] disconnected, reconnecting...')
    setTimeout(() => {
      if (store.isLoggedIn) connectWS()
    }, 3000)
  }

  ws.onerror = (e) => {
    console.error('[WS] error:', e)
  }
}

function handleWSMessage(msg) {
  console.log('[WS] received:', msg.type, JSON.stringify(msg.payload || {}).slice(0, 80))

  switch (msg.type) {
    // 文本增量（后端实际推送的是 'text' 类型）
    case 'text':
      if (msg.payload) {
        streamingText.value += msg.payload
        nextTick(scrollToBottom)
      }
      break

    // 工具调用开始
    case 'tool_call':
      streamingToolCalls.value.push({
        id: msg.payload.tool_use_id,
        name: msg.payload.name,
        input: msg.payload.input || {},
        status: 'running',
        output: null,
      })
      // 清空当前文本，工具调用后可能有新文本
      streamingText.value = ''
      nextTick(scrollToBottom)
      break

    // 工具调用结果
    case 'tool_result': {
      const call = streamingToolCalls.value.find(t => t.id === msg.payload.tool_use_id)
      if (call) {
        call.output = msg.payload.result
        // 判断工具是否成功
        try {
          const parsed = typeof call.output === 'string'
            ? JSON.parse(call.output)
            : call.output
          call.status = parsed?.success === false ? 'error' : 'done'
        } catch {
          call.status = 'done'
        }
      }
      nextTick(scrollToBottom)
      break
    }

    // 任务开始（兼容旧消息类型）
    case 'task_running':
      currentMsgId = msg.msgId || msg.payload?.msgId
      streamingText.value = ''
      streamingToolCalls.value = []
      store.isStreaming = true
      nextTick(scrollToBottom)
      break

    case 'queue_position':
      if (msg.position === 'waiting' || msg.position === 'executing') {
        store.isStreaming = true
      }
      break

    // 完成
    case 'done':
      store.isStreaming = false
      currentMsgId = null
      // 重新加载消息获取完整内容
      syncCurrentSessionMessages()
      streamingText.value = ''
      streamingToolCalls.value = []
      loadTodo()
      break

    case 'error':
      store.isStreaming = false
      streamingText.value = ''
      streamingToolCalls.value = []
      console.error('[WS] error:', msg.payload)
      break

    // 需要确认的工具调用
    case 'confirmation_required':
    case 'confirmation_requested':
      console.log('[WS] confirmation requested:', msg.payload)
      // TODO: 实现确认弹窗
      break

    // 确认相关事件
    case 'confirmation_executing':
    case 'confirmation_done':
    case 'confirmation_cancelled':
      console.log('[WS] confirmation event:', msg.type, msg.payload)
      break
  }
}

// ── Todo ──

async function loadTodo() {
  if (!store.currentWorkspace) return
  isTodoLoading.value = true
  try {
    const data = await api.get(
      `/api/todos?workspaceId=${store.currentWorkspace.id}`)
    todoItems.value = data?.items || []
  } finally {
    isTodoLoading.value = false
  }
}

// ── 生命周期 ──

watch(() => store.currentWorkspace, async (ws) => {
  if (ws) {
    await loadSessions()
    connectWS()
    await loadTodo()
    // 自动选中第一个会话
    if (sessions.value.length > 0 && !store.currentSession) {
      await selectSession(sessions.value[0])
    }
  }
}, { immediate: true })

onUnmounted(() => {
  ws?.close()
})
</script>