<template>
  <div class="flex flex-1 min-h-0 gap-5">

    <!-- 左侧分类 -->
    <div class="w-56 tactile-container flex flex-col overflow-hidden shrink-0">
      <div class="px-5 py-4 border-b border-slate-100/50 shrink-0">
        <p class="text-[9px] font-bold uppercase tracking-[0.2em] opacity-30">
          日志分类
        </p>
      </div>
      <div class="flex-1 p-3 space-y-1">
        <button v-for="cat in categories" :key="cat.value"
          @click="currentCategory = cat.value"
          :class="['w-full flex items-center gap-3 px-3 py-2.5 rounded-2xl',
                   'text-[12px] transition-colors text-left',
                   currentCategory === cat.value
                     ? 'bg-oxygen-blue/10 text-oxygen-blue font-medium'
                     : 'opacity-60 hover:bg-white/50 hover:opacity-100']">
          <component :is="cat.icon" class="w-4 h-4 shrink-0"/>
          <span>{{ cat.label }}</span>
          <span v-if="cat.count"
            class="ml-auto text-[10px] font-mono opacity-50">
            {{ cat.count }}
          </span>
        </button>
      </div>
    </div>

    <!-- 右侧日志 -->
    <div class="flex-1 tactile-container flex flex-col overflow-hidden">
      <!-- 工具栏 -->
      <div class="flex items-center justify-between px-6 py-4
                  border-b border-slate-100/50 shrink-0">
        <div class="flex items-center gap-4">
          <p class="font-semibold">实时日志</p>
          <!-- 搜索框 -->
          <div class="flex items-center gap-2 bg-white/70 border border-white
                      px-3 py-1.5 rounded-full shadow-sm">
            <Search class="w-3 h-3 opacity-40 shrink-0"/>
            <input v-model="searchQuery" type="text"
              placeholder="搜索日志..."
              class="bg-transparent outline-none text-[11px] font-mono w-40
                     placeholder:opacity-40"/>
          </div>
          <!-- 自动滚动开关 -->
          <label class="flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" v-model="autoScroll"
              class="w-3 h-3 rounded"/>
            <span class="text-[10px] font-mono opacity-40">自动滚动</span>
          </label>
        </div>
        <div class="flex items-center gap-2">
          <!-- 实时指示灯 -->
          <div class="flex items-center gap-1.5 text-[10px] font-mono
                      opacity-40 mr-2">
            <span class="w-1.5 h-1.5 rounded-full bg-green-500
                         animate-pulse inline-block"></span>
            实时
          </div>
          <button @click="downloadLogs"
            class="p-2 rounded-xl hover:bg-slate-100 transition-colors"
            title="下载日志">
            <Download class="w-4 h-4 opacity-40"/>
          </button>
          <button @click="clearLogs"
            class="p-2 rounded-xl hover:bg-red-50 hover:text-red-500
                   transition-colors" title="清空">
            <Trash2 class="w-4 h-4 opacity-40"/>
          </button>
        </div>
      </div>

      <!-- 日志列表 -->
      <div ref="logListEl"
        class="flex-1 overflow-y-auto no-scrollbar px-3 py-2">
        <!-- 空状态 -->
        <div v-if="!filteredLogs.length"
          class="flex flex-col items-center justify-center h-full opacity-30">
          <ScrollText class="w-10 h-10 mb-3"/>
          <p class="text-sm font-light">暂无日志记录</p>
        </div>

        <!-- 日志行 -->
        <div v-for="log in filteredLogs" :key="log.id"
          class="flex items-start gap-3 px-3 py-1.5 rounded-xl
                 hover:bg-slate-50 transition-colors font-mono
                 text-[11px] group cursor-default"
          @click="selectedLog = selectedLog?.id === log.id ? null : log">
          <!-- 时间 -->
          <span class="text-blue-400 w-16 shrink-0 mt-0.5">
            {{ formatTime(log.timestamp) }}
          </span>
          <!-- 级别 -->
          <span :class="levelClass(log.level)"
            class="w-10 shrink-0 font-bold mt-0.5">
            {{ log.level?.toUpperCase() }}
          </span>
          <!-- 分类 -->
          <span class="text-slate-400 w-20 shrink-0 mt-0.5">
            [{{ log.category }}]
          </span>
          <!-- 模块 -->
          <span class="text-slate-500 w-28 shrink-0 truncate mt-0.5">
            {{ log.module }}
          </span>
          <!-- 消息 -->
          <span :class="['flex-1 min-w-0',
                         selectedLog?.id === log.id
                           ? 'text-slate-700 whitespace-pre-wrap break-all'
                           : 'text-slate-700 truncate']">
            {{ log.message }}
          </span>
        </div>
      </div>

      <!-- 底部：日志总数 -->
      <div class="px-6 py-2 border-t border-slate-100/50 shrink-0
                  flex items-center justify-between">
        <span class="text-[10px] font-mono opacity-30">
          显示 {{ filteredLogs.length }} / {{ logs.length }} 条
        </span>
        <span class="text-[10px] font-mono opacity-30">
          {{ currentCategory === 'all' ? '全部分类' : currentCategory }}
        </span>
      </div>
    </div>

  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { useAppStore } from '../stores/app'
import { api } from '../api'
import {
  Layers, Server, Bot, Calendar, Terminal,
  Search, Download, Trash2, ScrollText
} from 'lucide-vue-next'

const store = useAppStore()
const logs = ref([])
const currentCategory = ref('all')
const searchQuery = ref('')
const autoScroll = ref(true)
const selectedLog = ref(null)
const logListEl = ref(null)
const clearedAt = ref(0)  // 清空时的时间戳，0 表示未清空
let pollTimer = null

// ── 分类配置 ──

const categories = computed(() => [
  { value: 'all',      label: '全部日志', icon: Layers,   count: logs.value.length },
  { value: 'system',   label: '系统日志', icon: Server,   count: countByCategory('system') },
  { value: 'sdk',      label: 'SDK 调用', icon: Bot,      count: countByCategory('sdk') },
  { value: 'task',     label: '任务执行', icon: Calendar, count: countByCategory('task') },
  { value: 'terminal', label: '终端记录', icon: Terminal, count: countByCategory('terminal') },
])

function countByCategory(cat) {
  return logs.value.filter(l => l.category === cat).length
}

// ── 过滤 ──

const filteredLogs = computed(() => {
  let result = logs.value
  if (currentCategory.value !== 'all') {
    result = result.filter(l => l.category === currentCategory.value)
  }
  if (searchQuery.value.trim()) {
    const q = searchQuery.value.toLowerCase()
    result = result.filter(l =>
      l.message?.toLowerCase().includes(q) ||
      l.module?.toLowerCase().includes(q) ||
      l.category?.toLowerCase().includes(q)
    )
  }
  return result
})

// 过滤结果变化时自动滚动
watch(filteredLogs, async () => {
  if (autoScroll.value) {
    await nextTick()
    scrollToBottom()
  }
})

// ── 样式 ──

function levelClass(level) {
  return {
    INFO:  'text-[#7091F5]',
    WARN:  'text-amber-500',
    ERROR: 'text-red-500',
    DEBUG: 'text-slate-400',
  }[level?.toUpperCase()] || 'text-slate-400'
}

function formatTime(ts) {
  if (!ts) return '--:--:--'
  const d = new Date(ts)
  return [
    d.getHours().toString().padStart(2, '0'),
    d.getMinutes().toString().padStart(2, '0'),
    d.getSeconds().toString().padStart(2, '0'),
  ].join(':')
}

// ── 数据加载 ──

async function loadLogs() {
  const params = new URLSearchParams({ limit: '200' })
  if (currentCategory.value !== 'all') {
    params.set('category', currentCategory.value)
  }
  const data = await api.get(`/api/logs/recent?${params}`)
  if (!data?.data) return

  // 过滤掉清空时间之前的日志（前端降级方案）
  let filtered = clearedAt.value > 0
    ? data.data.filter(l => (l.timestamp || 0) > clearedAt.value)
    : data.data

  if (!filtered.length) return

  // 去重：避免重复加载
  const existingIds = new Set(logs.value.map(l => l.id))
  const newLogs = filtered.filter(l => !existingIds.has(l.id))

  if (!newLogs.length) return

  // 合并并保持时间顺序（旧→新）
  logs.value = [...logs.value, ...newLogs]
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-500)  // 最多保留 500 条
}

// 切换分类时清空列表重新加载（保持 clearedAt 状态）
watch(currentCategory, async () => {
  logs.value = []
  // clearedAt 不重置，保持清空状态
  await loadLogs()
})

function scrollToBottom() {
  if (logListEl.value) {
    logListEl.value.scrollTop = logListEl.value.scrollHeight
  }
}

// ── 操作 ──

function downloadLogs() {
  const content = filteredLogs.value
    .map(l => `${formatTime(l.timestamp)} ${l.level?.toUpperCase()} [${l.category}] ${l.module} ${l.message}`)
    .join('\n')
  const blob = new Blob([content], { type: 'text/plain' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `logs-${new Date().toISOString().slice(0,10)}.txt`
  a.click()
  URL.revokeObjectURL(url)
}

function clearLogs() {
  if (!confirm('确认清空当前显示的日志？')) return
  // 记录清空时间，阻止旧日志重新加载
  clearedAt.value = Date.now()
  logs.value = []
}

// ── 生命周期 ──

onMounted(async () => {
  await loadLogs()
  await nextTick()
  scrollToBottom()
  // 每5秒轮询新日志
  pollTimer = setInterval(loadLogs, 5000)
})

onUnmounted(() => {
  clearInterval(pollTimer)
})
</script>