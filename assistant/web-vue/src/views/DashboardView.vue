<template>
  <div class="flex flex-wrap gap-5 content-start
              overflow-y-auto no-scrollbar h-full pb-2">

    <!-- 卡片1：Token 消耗折线图（宽 66%，高 h-64）-->
    <div class="w-full xl:w-[calc(66%-10px)] h-64
                tactile-container p-6 flex flex-col">
      <div class="flex items-center justify-between mb-4">
        <p class="font-semibold">Token 消耗</p>
        <div class="flex items-center gap-4 text-[10px] font-mono">
          <span class="flex items-center gap-1.5 opacity-50">
            <span class="w-2 h-2 rounded-full bg-oxygen-blue inline-block"></span>
            Input
          </span>
          <span class="flex items-center gap-1.5 opacity-50">
            <span class="w-2 h-2 rounded-full bg-green-500 inline-block"></span>
            Output
          </span>
          <span class="opacity-30">
            今日 {{ formatTokens(todayTokens) }} tokens
          </span>
        </div>
      </div>

      <!-- SVG 折线图 -->
      <div class="flex-1 relative min-h-0">
        <!-- 无数据 -->
        <div v-if="!hasTokenData"
          class="absolute inset-0 flex flex-col items-center
                 justify-center opacity-30">
          <BarChart2 class="w-10 h-10 mb-2"/>
          <p class="text-[11px] font-mono">暂无 Token 数据</p>
          <p class="text-[10px] opacity-60 mt-1">开始对话后将显示消耗曲线</p>
        </div>

        <!-- 有数据时绘制折线图 -->
        <svg v-else class="w-full h-full" :viewBox="`0 0 800 120`"
          preserveAspectRatio="none">
          <!-- 水平网格线 -->
          <line v-for="i in [30,60,90]" :key="i"
            x1="0" :y1="i" x2="800" :y2="i"
            stroke="#f1f5f9" stroke-width="1"/>

          <!-- Input 面积填充 -->
          <path :d="inputAreaPath"
            fill="#7091F5" fill-opacity="0.08"/>
          <!-- Input 折线 -->
          <polyline :points="inputPoints"
            fill="none" stroke="#7091F5" stroke-width="1.5"
            stroke-linecap="round" stroke-linejoin="round"/>

          <!-- Output 面积填充 -->
          <path :d="outputAreaPath"
            fill="#22c55e" fill-opacity="0.08"/>
          <!-- Output 折线 -->
          <polyline :points="outputPoints"
            fill="none" stroke="#22c55e" stroke-width="1.5"
            stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>

      <!-- X 轴时间标签（每6小时一个）-->
      <div class="flex justify-between mt-2 px-0.5">
        <span v-for="label in xLabels" :key="label"
          class="text-[9px] font-mono opacity-30">{{ label }}</span>
      </div>
    </div>

    <!-- 卡片2：系统状态（宽 34%，高 h-64）-->
    <div class="w-full xl:w-[calc(34%-10px)] h-64
                tactile-container p-6 flex flex-col">
      <p class="font-semibold mb-4">系统状态</p>
      <div class="flex-1 space-y-3">

        <!-- 运行器 -->
        <div class="flex items-center justify-between p-3 rounded-xl bg-white/50">
          <div class="flex items-center gap-3">
            <div class="w-8 h-8 rounded-lg bg-green-100
                        flex items-center justify-center">
              <Cpu class="w-4 h-4 text-green-600"/>
            </div>
            <div>
              <p class="text-[11px] font-semibold">运行器</p>
              <p class="text-[9px] font-mono opacity-40">
                活跃: {{ systemData?.runner?.activeCount || 0 }} ·
                队列: {{ systemData?.runner?.queueSize || 0 }}
              </p>
            </div>
          </div>
          <span :class="badgeClass(systemData?.runner?.status)">
            {{ statusText(systemData?.runner?.status) }}
          </span>
        </div>

        <!-- 记忆服务 -->
        <div class="flex items-center justify-between p-3 rounded-xl bg-white/50">
          <div class="flex items-center gap-3">
            <div class="w-8 h-8 rounded-lg bg-blue-100
                        flex items-center justify-center">
              <Brain class="w-4 h-4 text-blue-600"/>
            </div>
            <div>
              <p class="text-[11px] font-semibold">记忆服务</p>
              <p class="text-[9px] font-mono opacity-40">Memory Service</p>
            </div>
          </div>
          <span class="text-[10px] font-mono px-2 py-1 rounded-full
                       bg-blue-100 text-blue-600">正常</span>
        </div>

        <!-- 飞书 -->
        <div class="flex items-center justify-between p-3 rounded-xl bg-white/50">
          <div class="flex items-center gap-3">
            <div class="w-8 h-8 rounded-lg bg-purple-100
                        flex items-center justify-center">
              <MessageCircle class="w-4 h-4 text-purple-600"/>
            </div>
            <div>
              <p class="text-[11px] font-semibold">飞书连接</p>
              <p class="text-[9px] font-mono opacity-40">Lark Bot</p>
            </div>
          </div>
          <span :class="larkBadge">{{ larkText }}</span>
        </div>

        <!-- 微信 -->
        <div class="flex items-center justify-between p-3 rounded-xl bg-white/50">
          <div class="flex items-center gap-3">
            <div class="w-8 h-8 rounded-lg bg-green-100
                        flex items-center justify-center">
              <svg class="w-4 h-4 text-green-600" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8.5 11.5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zM12 6.5c-.83 0-1.5-.67-1.5-1.5S11.17 3.5 12 3.5s1.5.67 1.5 1.5S12.83 6.5 12 6.5zm3.5 5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm-7 0c-.83 0-1.5-.67-1.5-1.5S7.67 8.5 8.5 8.5s1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm3.5 5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm3.5-5c-.83 0-1.5-.67-1.5-1.5S15.17 8.5 16 8.5s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/>
              </svg>
            </div>
            <div>
              <p class="text-[11px] font-semibold">微信连接</p>
              <p class="text-[9px] font-mono opacity-40">WeChat Bot</p>
            </div>
          </div>
          <span :class="weixinBadge">{{ weixinText }}</span>
        </div>
      </div>
    </div>

    <!-- 卡片3：今日概览（宽 50%，高 h-48）-->
    <div class="w-full md:w-[calc(50%-10px)] h-48
                tactile-container p-6 flex flex-col">
      <p class="font-semibold mb-4">今日概览</p>
      <div class="flex-1 grid grid-cols-3 gap-3">
        <div class="text-center p-3 rounded-xl bg-white/50">
          <p class="text-2xl font-bold text-oxygen-blue">
            {{ statsData?.today?.calls || 0 }}
          </p>
          <p class="text-[9px] font-mono opacity-40 mt-1">对话次数</p>
        </div>
        <div class="text-center p-3 rounded-xl bg-white/50">
          <p class="text-2xl font-bold text-green-500">
            {{ formatTokens(todayTokens) }}
          </p>
          <p class="text-[9px] font-mono opacity-40 mt-1">Token 消耗</p>
        </div>
        <div class="text-center p-3 rounded-xl bg-white/50">
          <p class="text-2xl font-bold text-purple-500">
            {{ systemData?.terminal?.connected || 0 }}
          </p>
          <p class="text-[9px] font-mono opacity-40 mt-1">活跃终端</p>
        </div>
      </div>
    </div>

    <!-- 卡片3.5：微信管理 -->
    <WeixinManager class="w-full"/>

    <!-- 卡片4：任务执行（宽 50%，高 h-48）-->
    <div class="w-full md:w-[calc(50%-10px)] h-48
                tactile-container p-6 flex flex-col">
      <p class="font-semibold mb-3">任务执行</p>
      <div class="flex items-center gap-4 mb-3">
        <div class="text-center">
          <p class="text-xl font-bold">{{ taskData?.todayRuns || 0 }}</p>
          <p class="text-[9px] font-mono opacity-40">今日执行</p>
        </div>
        <div class="flex gap-2 flex-1">
          <span class="flex items-center gap-1 text-[10px] font-mono
                       text-green-600 bg-green-50 px-2 py-1 rounded-full">
            <CheckCircle class="w-3 h-3"/>
            {{ taskData?.todayByStatus?.success || 0 }} 成功
          </span>
          <span class="flex items-center gap-1 text-[10px] font-mono
                       text-red-500 bg-red-50 px-2 py-1 rounded-full">
            <XCircle class="w-3 h-3"/>
            {{ taskData?.todayByStatus?.error || 0 }} 失败
          </span>
        </div>
      </div>

      <!-- 最近失败 -->
      <div class="flex-1 overflow-y-auto no-scrollbar space-y-1">
        <p v-if="!taskData?.recentFailures?.length"
          class="text-[10px] font-mono opacity-30 py-1">暂无失败记录</p>
        <div v-for="f in taskData?.recentFailures?.slice(0,3)" :key="f.id"
          class="flex items-center gap-2 text-[10px] font-mono">
          <XCircle class="w-3 h-3 text-red-400 shrink-0"/>
          <span class="text-slate-600 truncate flex-1">{{ f.taskName }}</span>
          <span class="text-slate-400 shrink-0">
            {{ formatTimeShort(f.startedAt) }}
          </span>
        </div>
      </div>
    </div>

    <!-- 卡片5：终端状态（宽 100%，高 h-32）-->
    <div class="w-full h-32 tactile-container p-6 flex items-center gap-8">
      <div>
        <p class="font-semibold mb-1">终端会话</p>
        <p class="text-[10px] font-mono opacity-40">Terminal Sessions</p>
      </div>
      <div class="flex gap-6">
        <div class="text-center">
          <p class="text-2xl font-bold">{{ systemData?.terminal?.total || 0 }}</p>
          <p class="text-[9px] font-mono opacity-40 mt-1">总数</p>
        </div>
        <div class="text-center">
          <p class="text-2xl font-bold text-green-500">
            {{ systemData?.terminal?.connected || 0 }}
          </p>
          <p class="text-[9px] font-mono opacity-40 mt-1">活跃</p>
        </div>
        <div class="text-center">
          <p class="text-2xl font-bold text-slate-300">
            {{ systemData?.terminal?.disconnected || 0 }}
          </p>
          <p class="text-[9px] font-mono opacity-40 mt-1">已断开</p>
        </div>
      </div>

      <!-- 刷新时间 -->
      <div class="ml-auto text-right">
        <p class="text-[9px] font-mono opacity-25">上次更新</p>
        <p class="text-[11px] font-mono opacity-40">{{ lastUpdate }}</p>
      </div>
    </div>

  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useAppStore } from '../stores/app'
import { api } from '../api'
import WeixinManager from '../components/WeixinManager.vue'
import {
  BarChart2, Cpu, Brain, MessageCircle,
  CheckCircle, XCircle
} from 'lucide-vue-next'

const store = useAppStore()
const systemData = ref(null)
const statsData = ref(null)
const taskData = ref(null)
const lastUpdate = ref('—')
let timer = null

// ── Token 折线图计算 ──

const hourly = computed(() => statsData.value?.hourly || [])

const hasTokenData = computed(() =>
  hourly.value.some(h => h.inputTokens > 0 || h.outputTokens > 0)
)

const todayTokens = computed(() => {
  const t = statsData.value?.total
  return (t?.inputTokens || 0) + (t?.outputTokens || 0)
})

// X轴标签：取 index 0, 6, 12, 18, 23
const xLabels = computed(() => {
  if (!hourly.value.length) return []
  return [0, 6, 12, 18, 23]
    .map(i => hourly.value[i]?.hour || '')
    .filter(Boolean)
})

function calcSVGPoints(data, key, w = 800, h = 120, pad = 10) {
  if (!data.length) return { points: '', area: '' }
  const max = Math.max(...data.map(d => d[key] || 0), 1)
  const step = w / (data.length - 1)
  const pts = data.map((d, i) => {
    const x = i * step
    const y = h - pad - ((d[key] || 0) / max) * (h - pad * 2)
    return { x, y }
  })
  const points = pts.map(p => `${p.x},${p.y}`).join(' ')
  const area = `M${pts[0].x},${h} ` +
    pts.map(p => `L${p.x},${p.y}`).join(' ') +
    ` L${pts[pts.length-1].x},${h} Z`
  return { points, area }
}

const inputPoints = computed(() =>
  calcSVGPoints(hourly.value, 'inputTokens').points)
const inputAreaPath = computed(() =>
  calcSVGPoints(hourly.value, 'inputTokens').area)
const outputPoints = computed(() =>
  calcSVGPoints(hourly.value, 'outputTokens').points)
const outputAreaPath = computed(() =>
  calcSVGPoints(hourly.value, 'outputTokens').area)

// ── 系统状态 ──

function statusText(s) {
  if (!s) return '加载中'
  return s === 'ok' ? '正常' : '异常'
}

function badgeClass(s) {
  const base = 'text-[10px] font-mono px-2 py-1 rounded-full'
  if (!s) return base + ' bg-slate-100 text-slate-400'
  return s === 'ok'
    ? base + ' bg-green-100 text-green-600'
    : base + ' bg-red-100 text-red-500'
}

const larkText = computed(() => {
  const s = systemData.value?.lark
  if (!s) return '加载中'
  return s.status === 'ok' ? '已连接' : '未配置'
})

const larkBadge = computed(() => {
  const s = systemData.value?.lark
  const base = 'text-[10px] font-mono px-2 py-1 rounded-full'
  if (!s) return base + ' bg-slate-100 text-slate-400'
  return s.status === 'ok'
    ? base + ' bg-purple-100 text-purple-600'
    : base + ' bg-slate-100 text-slate-400'
})

const weixinText = computed(() => {
  const s = systemData.value?.weixin
  if (!s) return '加载中'
  return s.accounts > 0 ? `已连接 (${s.accounts})` : '未连接'
})

const weixinBadge = computed(() => {
  const s = systemData.value?.weixin
  const base = 'text-[10px] font-mono px-2 py-1 rounded-full'
  if (!s) return base + ' bg-slate-100 text-slate-400'
  return s.accounts > 0
    ? base + ' bg-green-100 text-green-600'
    : base + ' bg-slate-100 text-slate-400'
})

// ── 工具函数 ──

function formatTokens(n) {
  if (!n) return '0'
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k'
  return String(n)
}

function formatTimeShort(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  return `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`
}

// ── 数据加载 ──

async function loadAll() {
  const wsId = store.currentWorkspace?.id
  try {
    const [sys, stats, tasks] = await Promise.all([
      api.get('/api/dashboard/system'),
      api.get(`/api/dashboard/stats${wsId ? '?workspaceId=' + wsId : ''}`),
      api.get('/api/dashboard/tasks'),
    ])
    systemData.value = sys
    statsData.value = stats
    taskData.value = tasks
    lastUpdate.value = new Date().toLocaleTimeString('zh-CN', {
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    })
  } catch (e) {
    console.error('[Dashboard] load failed:', e)
  }
}

onMounted(() => {
  loadAll()
  timer = setInterval(loadAll, 30000)
})

onUnmounted(() => clearInterval(timer))
</script>