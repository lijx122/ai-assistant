<template>
  <div class="flex flex-1 min-h-0 gap-5">

    <!-- 左侧任务列表 -->
    <div class="w-80 tactile-container flex flex-col overflow-hidden shrink-0">
      <div class="px-5 py-4 border-b border-slate-100/50 shrink-0">
        <div class="flex items-center justify-between">
          <p class="text-[9px] font-bold uppercase tracking-[0.2em] opacity-30">
            任务列表
          </p>
          <button @click="openModal()"
            class="w-7 h-7 rounded-lg bg-oxygen-blue/10 hover:bg-oxygen-blue/20
                   flex items-center justify-center transition-colors">
            <Plus class="w-4 h-4 text-oxygen-blue"/>
          </button>
        </div>
      </div>
      <div class="flex-1 overflow-y-auto no-scrollbar p-3 space-y-1">
        <div v-if="isTasksLoading" class="space-y-2 py-1">
          <div v-for="i in 6" :key="`task-skeleton-${i}`"
            class="h-16 rounded-2xl wb-skeleton"></div>
        </div>
        <div v-else-if="!tasks.length"
          class="flex flex-col items-center justify-center py-8 text-slate-400">
          <svg class="w-16 h-16 mb-3 opacity-70" viewBox="0 0 64 64" fill="none" aria-hidden="true">
            <rect x="11" y="10" width="42" height="44" rx="10" stroke="currentColor" stroke-width="2"/>
            <path d="M20 8v8M44 8v8M11 24h42" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            <path d="M21 34h22M21 42h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
          <p class="text-[11px] font-mono">暂无任务</p>
        </div>
        <button v-else v-for="task in tasks" :key="task.id"
          @click="selectTask(task)"
          :class="['w-full text-left px-4 py-3 rounded-2xl transition-colors',
                   currentTask?.id === task.id
                     ? 'bg-white shadow-sm'
                     : 'hover:bg-white/60']">
          <div class="flex items-center justify-between mb-1.5">
            <span class="text-sm font-semibold truncate">{{ task.name }}</span>
            <span :class="statusClass(task.status)" class="text-[11px] shrink-0 ml-2">
              {{ statusText(task.status) }}
            </span>
          </div>
          <div class="flex items-center gap-1.5">
            <span :class="typeClass(task.type)"
              class="text-[10px] rounded-full px-2 py-0.5">
              {{ scheduleTypeText(task.type) }}
            </span>
            <span :class="cmdClass(task.command_type)"
              class="text-[10px] rounded-full px-2 py-0.5">
              {{ cmdTypeText(task.command_type) }}
            </span>
          </div>
        </button>
      </div>
    </div>

    <!-- 右侧详情 -->
    <div class="flex-1 tactile-container flex flex-col overflow-hidden">
      <!-- 空状态 -->
      <div v-if="!currentTask"
        class="flex-1 flex items-center justify-center">
        <div class="text-center text-slate-400">
          <svg class="w-20 h-20 mx-auto mb-4 opacity-70" viewBox="0 0 96 96" fill="none" aria-hidden="true">
            <rect x="18" y="16" width="60" height="62" rx="14" stroke="currentColor" stroke-width="2.5"/>
            <path d="M34 14v10M62 14v10M18 34h60" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
            <path d="M34 48h28M34 58h20" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
          </svg>
          <p class="font-semibold">定时任务</p>
          <p class="text-sm mt-1">选择任务查看详情</p>
          <p class="text-[11px] font-mono opacity-60 mt-2">
            支持 cron/interval/once 三种模式
          </p>
        </div>
      </div>

      <!-- 任务详情 -->
      <template v-else>
        <div class="flex items-center justify-between px-6 py-4
                    border-b border-slate-100/50 shrink-0">
          <div>
            <p class="font-semibold">{{ currentTask.name }}</p>
            <p class="text-[10px] font-mono opacity-40 mt-0.5">
              {{ currentTask.schedule }}
            </p>
          </div>
          <div class="flex items-center gap-2">
            <span :class="['px-2 py-1 rounded-lg text-[10px] font-bold',
                           statusBadgeClass(currentTask.status)]">
              {{ statusText(currentTask.status) }}
            </span>
            <button @click="triggerTask"
              class="p-2 rounded-lg hover:bg-slate-100 transition-colors"
              title="立即执行">
              <Play class="w-4 h-4"/>
            </button>
            <button @click="togglePause"
              class="p-2 rounded-lg hover:bg-slate-100 transition-colors"
              :title="currentTask.status === 'paused' ? '恢复' : '暂停'">
              <Pause v-if="currentTask.status !== 'paused'" class="w-4 h-4"/>
              <Play v-else class="w-4 h-4"/>
            </button>
            <button @click="openModal(currentTask)"
              class="p-2 rounded-lg hover:bg-slate-100 transition-colors"
              title="编辑">
              <Pencil class="w-4 h-4"/>
            </button>
            <button @click="deleteTask"
              class="p-2 rounded-lg hover:bg-red-50 text-red-500 transition-colors"
              title="删除">
              <Trash2 class="w-4 h-4"/>
            </button>
          </div>
        </div>

        <div class="flex-1 overflow-y-auto p-6">
          <!-- 信息网格 -->
          <div class="grid grid-cols-2 gap-4 mb-6">
            <div class="bg-slate-50 rounded-2xl p-4">
              <p class="text-[10px] font-mono opacity-40 mb-1">命令类型</p>
              <p class="text-sm font-medium">
                {{ cmdTypeText(currentTask.command_type) }}
              </p>
            </div>
            <div class="bg-slate-50 rounded-2xl p-4">
              <p class="text-[10px] font-mono opacity-40 mb-1">执行次数</p>
              <p class="text-sm font-medium">{{ currentTask.run_count || 0 }}</p>
            </div>
            <div class="bg-slate-50 rounded-2xl p-4">
              <p class="text-[10px] font-mono opacity-40 mb-1">上次执行</p>
              <p class="text-sm font-medium">
                {{ formatTime(currentTask.last_run) }}
              </p>
            </div>
            <div class="bg-slate-50 rounded-2xl p-4">
              <p class="text-[10px] font-mono opacity-40 mb-1">下次执行</p>
              <p class="text-sm font-medium">
                {{ formatTime(currentTask.next_run) }}
              </p>
            </div>
          </div>

          <!-- 命令内容 -->
          <div class="mb-6">
            <p class="text-[10px] font-mono opacity-40 mb-2">命令内容</p>
            <pre class="bg-slate-900 text-slate-100 p-4 rounded-2xl
                        text-xs font-mono overflow-x-auto">{{ currentTask.command }}</pre>
          </div>

          <!-- 执行历史 -->
          <div>
            <p class="text-[10px] font-mono opacity-40 mb-2">执行历史（最近10条）</p>
            <div class="space-y-2">
              <div v-if="!taskRuns.length"
                class="text-[11px] font-mono opacity-30 py-2">暂无执行记录</div>
              <div v-for="run in taskRuns" :key="run.id"
                class="flex items-center gap-3 px-4 py-2.5 rounded-2xl bg-slate-50">
                <CheckCircle v-if="run.status === 'success'"
                  class="w-4 h-4 text-green-500 shrink-0"/>
                <XCircle v-else-if="run.status === 'error'"
                  class="w-4 h-4 text-red-500 shrink-0"/>
                <Clock v-else class="w-4 h-4 text-slate-400 shrink-0"/>
                <div class="flex-1 min-w-0">
                  <p class="text-[11px] font-mono">
                    {{ formatTime(run.started_at) }}
                  </p>
                  <p v-if="run.error" class="text-[10px] text-red-500 truncate">
                    {{ run.error }}
                  </p>
                </div>
                <span :class="['text-[10px] font-mono',
                               run.status === 'success'
                                 ? 'text-green-600' : 'text-red-500']">
                  {{ run.status === 'success' ? '成功' : '失败' }}
                </span>
                <span class="text-[10px] font-mono opacity-40">
                  {{ formatDuration(run.started_at, run.ended_at) }}
                </span>
              </div>
            </div>
          </div>
        </div>
      </template>
    </div>

    <!-- 新建/编辑 Modal -->
    <div v-if="showModal"
      class="fixed inset-0 bg-black/20 backdrop-blur-sm z-50
             flex items-center justify-center p-5">
      <div class="tactile-container p-8 max-w-lg w-full flex flex-col gap-4
                  max-h-[90vh] overflow-y-auto">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 bg-oxygen-blue/10 rounded-2xl flex items-center
                      justify-center">
            <CalendarClock class="w-5 h-5 text-oxygen-blue"/>
          </div>
          <div>
            <p class="font-bold">
              {{ editingTask ? '编辑任务' : '新建定时任务' }}
            </p>
            <p class="text-[10px] opacity-40 font-mono">配置自动化任务</p>
          </div>
        </div>

        <!-- 任务名 -->
        <div>
          <p class="text-[10px] font-mono opacity-40 mb-1.5">任务名称 *</p>
          <input v-model="form.name" type="text"
            class="w-full bg-white px-4 py-2.5 rounded-2xl border border-slate-100
                   text-sm outline-none focus:border-oxygen-blue/40 transition-colors"
            placeholder="例如：每日数据备份"/>
        </div>

        <!-- 调度类型 + 命令类型 -->
        <div class="grid grid-cols-2 gap-3">
          <div>
            <p class="text-[10px] font-mono opacity-40 mb-1.5">调度类型 *</p>
            <select v-model="form.schedule_type"
              class="w-full bg-white px-4 py-2.5 rounded-2xl border border-slate-100
                     text-sm outline-none focus:border-oxygen-blue/40 transition-colors">
              <option value="cron">Cron 表达式</option>
              <option value="interval">固定间隔</option>
              <option value="once">一次性</option>
            </select>
          </div>
          <div>
            <p class="text-[10px] font-mono opacity-40 mb-1.5">命令类型 *</p>
            <select v-model="form.command_type"
              class="w-full bg-white px-4 py-2.5 rounded-2xl border border-slate-100
                     text-sm outline-none focus:border-oxygen-blue/40 transition-colors">
              <option value="shell">Shell 命令</option>
              <option value="assistant">AI 对话</option>
              <option value="http">HTTP 请求</option>
            </select>
          </div>
        </div>

        <!-- 调度表达式 -->
        <div>
          <p class="text-[10px] font-mono opacity-40 mb-1.5">
            {{ scheduleLabel }}
          </p>
          <input v-model="form.schedule" type="text"
            class="w-full bg-white px-4 py-2.5 rounded-2xl border border-slate-100
                   text-sm font-mono outline-none focus:border-oxygen-blue/40"
            :placeholder="schedulePlaceholder"/>
        </div>

        <!-- 命令内容 -->
        <div>
          <p class="text-[10px] font-mono opacity-40 mb-1.5">命令内容 *</p>
          <textarea v-model="form.command" rows="3"
            class="w-full bg-white px-4 py-2.5 rounded-2xl border border-slate-100
                   text-sm font-mono outline-none focus:border-oxygen-blue/40
                   resize-none transition-colors"
            placeholder="输入命令..."/>
        </div>

        <!-- 失败告警开关（仅 shell） -->
        <div v-if="form.command_type === 'shell'"
          class="flex items-center gap-2">
          <input type="checkbox" v-model="form.alert_on_error"
            class="w-4 h-4 rounded border-slate-300 text-oxygen-blue"/>
          <label class="text-xs text-slate-600">
            Shell 执行失败时发送告警（AI 分析并尝试自动修复）
          </label>
        </div>

        <!-- 完成后通知 -->
        <div>
          <div class="flex items-center gap-2 mb-2">
            <input type="checkbox" v-model="form.notify_enabled"
              class="w-4 h-4 rounded border-slate-300 text-oxygen-blue"/>
            <label class="text-xs font-medium text-slate-700">完成后通知</label>
          </div>
          <div v-if="form.notify_enabled"
            class="pl-6 space-y-1.5">
            <label class="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" value="web" v-model="form.notify_channels"
                class="w-3.5 h-3.5 rounded border-slate-300 text-oxygen-blue"/>
              <span class="text-xs text-slate-600">Web 仪表盘</span>
            </label>
            <label class="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" value="lark" v-model="form.notify_channels"
                class="w-3.5 h-3.5 rounded border-slate-300 text-oxygen-blue"/>
              <span class="text-xs text-slate-600">飞书</span>
            </label>
            <label class="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" value="weixin" v-model="form.notify_channels"
                class="w-3.5 h-3.5 rounded border-slate-300 text-oxygen-blue"/>
              <span class="text-xs text-slate-600">微信</span>
            </label>
          </div>
        </div>

        <!-- 错误提示 -->
        <p v-if="modalErr" class="text-[11px] text-red-400 font-mono">
          {{ modalErr }}
        </p>

        <!-- 按钮 -->
        <div class="flex gap-3 mt-2">
          <button @click="showModal = false"
            class="flex-1 py-2.5 rounded-2xl text-sm font-bold
                   border border-slate-200 hover:bg-slate-50 transition-colors">
            取消
          </button>
          <button @click="saveTask"
            class="flex-1 bg-deep-charcoal text-white py-2.5 rounded-2xl
                   text-sm font-bold hover:opacity-80 transition-opacity">
            保存
          </button>
        </div>
      </div>
    </div>

  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { useAppStore } from '../stores/app'
import { api } from '../api'
import {
  Plus, CalendarClock, Clock, Play, Pause, Pencil,
  Trash2, CheckCircle, XCircle
} from 'lucide-vue-next'

const store = useAppStore()
const tasks = ref([])
const currentTask = ref(null)
const taskRuns = ref([])
const showModal = ref(false)
const editingTask = ref(null)
const modalErr = ref('')
const isTasksLoading = ref(true)

const form = ref({
  name: '',
  schedule_type: 'cron',
  command_type: 'shell',
  schedule: '',
  command: '',
  alert_on_error: false,
  notify_enabled: false,    // 通知总开关
  notify_channels: [],      // ['web', 'lark', 'weixin']
})

// ── 工具函数 ──

function statusText(s) {
  return { active:'运行中', paused:'已暂停',
           completed:'已完成', error:'错误' }[s] || s
}
function statusClass(s) {
  return { active:'text-green-600', completed:'text-green-600',
           paused:'text-amber-500', error:'text-red-500' }[s] || 'text-slate-400'
}
function statusBadgeClass(s) {
  return { active:'bg-green-100 text-green-700',
           completed:'bg-green-100 text-green-700',
           paused:'bg-amber-100 text-amber-700',
           error:'bg-red-100 text-red-500' }[s]
         || 'bg-slate-100 text-slate-500'
}
function typeClass(t) {
  return { cron:'bg-slate-100 text-slate-500',
           interval:'bg-amber-100 text-amber-600',
           once:'bg-blue-100 text-blue-600' }[t]
         || 'bg-slate-100 text-slate-500'
}
function cmdClass(t) {
  return { shell:'bg-slate-100 text-slate-500',
           assistant:'bg-purple-100 text-purple-600',
           http:'bg-green-100 text-green-600' }[t]
         || 'bg-slate-100 text-slate-500'
}
function scheduleTypeText(t) {
  return { cron:'Cron', interval:'间隔', once:'一次性' }[t] || t
}
function cmdTypeText(t) {
  return { shell:'Shell', assistant:'AI', http:'HTTP' }[t] || t
}
function formatTime(ts) {
  if (!ts) return '-'
  return new Date(ts).toLocaleString('zh-CN', {
    month:'numeric', day:'numeric',
    hour:'2-digit', minute:'2-digit'
  })
}
function formatDuration(start, end) {
  if (!start || !end) return ''
  const ms = new Date(end) - new Date(start)
  if (ms < 1000) return ms + 'ms'
  return (ms / 1000).toFixed(1) + 's'
}

const scheduleLabel = computed(() => ({
  cron: 'Cron 表达式 *',
  interval: '间隔时间 *',
  once: '执行时间 *',
})[form.value.schedule_type] || '调度配置 *')

const schedulePlaceholder = computed(() => ({
  cron: '0 2 * * *',
  interval: '30m',
  once: '2026-04-01 10:00',
})[form.value.schedule_type] || '')

// ── 数据加载 ──

async function loadTasks() {
  if (!store.currentWorkspace) return
  isTasksLoading.value = true
  try {
    const data = await api.get(
      `/api/tasks?workspaceId=${store.currentWorkspace.id}`)
    tasks.value = data?.tasks || []
  } finally {
    isTasksLoading.value = false
  }
}

async function selectTask(task) {
  currentTask.value = task
  const data = await api.get(`/api/tasks/${task.id}/runs`)
  if (data?.runs) taskRuns.value = data.runs
}

// ── 任务操作 ──

async function triggerTask() {
  if (!currentTask.value) return
  await api.post(`/api/tasks/${currentTask.value.id}/trigger`, {})
  await loadTasks()
}

async function togglePause() {
  if (!currentTask.value) return
  const action = currentTask.value.status === 'paused' ? 'resume' : 'pause'
  await api.post(`/api/tasks/${currentTask.value.id}/${action}`, {})
  await loadTasks()
  await selectTask(currentTask.value)
}

async function deleteTask() {
  if (!currentTask.value) return
  await api.delete(`/api/tasks/${currentTask.value.id}`)
  currentTask.value = null
  await loadTasks()
}

// ── Modal ──

function openModal(task = null) {
  editingTask.value = task
  modalErr.value = ''
  if (task) {
    // 兼容旧格式：task.notify_target → 新格式
    const channels = []
    if (task.notify_target?.type === 'web' || task.notify_target?.channels?.includes('web')) channels.push('web')
    if (task.notify_target?.type === 'lark' || task.notify_target?.channels?.includes('lark')) channels.push('lark')
    if (task.notify_target?.channels?.includes('weixin')) channels.push('weixin')
    form.value = {
      name: task.name,
      schedule_type: task.type,
      command_type: task.command_type,
      schedule: task.schedule,
      command: task.command,
      alert_on_error: !!task.alert_on_error,
      notify_enabled: !!(channels.length || task.notify_enabled),
      notify_channels: channels,
    }
  } else {
    form.value = {
      name: '', schedule_type: 'cron',
      command_type: 'shell', schedule: '',
      command: '', alert_on_error: false,
      notify_enabled: false, notify_channels: [],
    }
  }
  showModal.value = true
}

async function saveTask() {
  modalErr.value = ''
  if (!form.value.name || !form.value.schedule || !form.value.command) {
    modalErr.value = '请填写所有必填项'
    return
  }
  if (form.value.notify_enabled && form.value.notify_channels.length === 0) {
    modalErr.value = '请至少选择一个通知渠道'
    return
  }
  try {
    // 兼容旧后端：仍发送 notifyTarget（空对象表示不使用）
    const notifyTarget = form.value.notify_enabled
      ? { channels: form.value.notify_channels }
      : null
    const payload = {
      workspaceId: store.currentWorkspace.id,
      name: form.value.name,
      type: form.value.schedule_type,
      commandType: form.value.command_type,
      schedule: form.value.schedule,
      command: form.value.command,
      alertOnError: form.value.alert_on_error,
      notifyEnabled: form.value.notify_enabled,
      notifyTarget,
    }
    if (editingTask.value) {
      await api.put(`/api/tasks/${editingTask.value.id}`, payload)
    } else {
      await api.post('/api/tasks', payload)
    }
    showModal.value = false
    await loadTasks()
  } catch (e) {
    modalErr.value = '保存失败：' + e.message
  }
}

// ── 生命周期 ──

watch(() => store.currentWorkspace, (ws) => {
  if (ws) loadTasks()
}, { immediate: true })
</script>