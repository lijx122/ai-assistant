<template>
  <div class="flex flex-1 min-h-0 gap-5">

    <!-- 左侧 Plan 列表 -->
    <div class="w-72 tactile-container flex flex-col overflow-hidden shrink-0">
      <div class="px-5 py-4 border-b border-slate-100/50 shrink-0">
        <div class="flex items-center justify-between">
          <p class="text-[9px] font-bold uppercase tracking-[0.2em] opacity-30">
            任务规划
          </p>
          <button @click="showInput = !showInput"
            class="w-7 h-7 rounded-lg bg-oxygen-blue/10 hover:bg-oxygen-blue/20
                   flex items-center justify-center transition-colors">
            <Plus class="w-4 h-4 text-oxygen-blue"/>
          </button>
        </div>

        <!-- 新建输入区 -->
        <div v-if="showInput" class="mt-3">
          <textarea v-model="requirement" rows="3"
            class="w-full bg-white px-3 py-2 rounded-2xl border border-slate-100
                   text-[12px] outline-none focus:border-oxygen-blue/40
                   resize-none transition-colors"
            placeholder="描述你的需求，AI 将自动拆解为步骤..."/>
          <div class="flex gap-2 mt-2">
            <button @click="showInput = false; requirement = ''"
              class="flex-1 py-1.5 rounded-xl text-[11px]
                     border border-slate-200 hover:bg-slate-50">
              取消
            </button>
            <button @click="handleGenerate"
              :disabled="isGenerating || !requirement.trim()"
              class="flex-1 py-1.5 rounded-xl text-[11px] bg-oxygen-blue
                     text-white hover:opacity-80 disabled:opacity-40
                     transition-opacity flex items-center justify-center gap-1">
              <Loader2 v-if="isGenerating" class="w-3 h-3 animate-spin"/>
              <Sparkles v-else class="w-3 h-3"/>
              {{ isGenerating ? '拆解中...' : 'AI 拆解' }}
            </button>
          </div>
        </div>
      </div>

      <!-- Plan 列表 -->
      <div class="flex-1 overflow-y-auto no-scrollbar p-3 space-y-1">
        <div v-if="isPlansLoading" class="space-y-2 py-1">
          <div v-for="i in 6" :key="`plan-skeleton-${i}`"
            class="h-16 rounded-2xl wb-skeleton"></div>
        </div>
        <div v-else-if="!plans.length"
          class="flex flex-col items-center justify-center py-8 text-slate-400">
          <svg class="w-14 h-14 mb-3 opacity-70" viewBox="0 0 64 64" fill="none" aria-hidden="true">
            <rect x="11" y="12" width="42" height="40" rx="9" stroke="currentColor" stroke-width="2"/>
            <path d="M21 24h22M21 31h22M21 38h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            <path d="M49 17l4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
          <p class="text-[11px] font-mono">暂无任务规划</p>
        </div>
        <button v-else v-for="plan in plans" :key="plan.id"
          @click="selectPlan(plan.id)"
          :class="['w-full text-left px-3 py-3 rounded-2xl transition-colors',
                   currentPlan?.id === plan.id
                     ? 'bg-white shadow-sm'
                     : 'hover:bg-white/60']">
          <div class="flex items-center justify-between gap-2 mb-1">
            <span class="text-[12px] font-medium truncate flex-1">
              {{ plan.title }}
            </span>
            <span :class="['text-[9px] font-bold px-1.5 py-0.5 rounded-full shrink-0',
                           statusBadge(plan.status)]">
              {{ statusLabel(plan.status) }}
            </span>
          </div>
          <p class="text-[10px] font-mono opacity-30">
            {{ formatDate(plan.created_at) }}
          </p>
        </button>
      </div>
    </div>

    <!-- 右侧详情 -->
    <div class="flex-1 tactile-container flex flex-col overflow-hidden">

      <!-- 空状态 -->
      <div v-if="!currentPlan"
        class="flex-1 flex items-center justify-center">
        <div class="text-center text-slate-400">
          <svg class="w-20 h-20 mx-auto mb-4 opacity-70" viewBox="0 0 96 96" fill="none" aria-hidden="true">
            <rect x="18" y="18" width="60" height="56" rx="14" stroke="currentColor" stroke-width="2.5"/>
            <path d="M32 35h32M32 45h32M32 55h20" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
            <path d="M60 18v-6M66 18v-6" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
          </svg>
          <p class="font-semibold">任务规划编排</p>
          <p class="text-sm mt-1">选择或新建一个任务规划</p>
          <p class="text-[11px] font-mono opacity-60 mt-2">
            AI 拆解需求 → 编辑步骤 → 逐步执行
          </p>
        </div>
      </div>

      <!-- 详情内容 -->
      <template v-else>
        <!-- 顶部工具栏 -->
        <div class="flex items-center justify-between px-6 py-4
                    border-b border-slate-100/50 shrink-0">
          <div class="flex-1 min-w-0 mr-4">
            <input v-model="editTitle"
              @blur="saveTitleIfChanged"
              :readonly="currentPlan.status !== 'draft'"
              class="text-base font-semibold bg-transparent outline-none
                     w-full border-none focus:border-b focus:border-oxygen-blue/30"
              :class="currentPlan.status === 'draft'
                ? 'cursor-text' : 'cursor-default'"/>
            <div class="flex items-center gap-1.5 mt-0.5">
              <span v-if="currentPlan.status === 'running'"
                class="w-1.5 h-1.5 rounded-full bg-green-500
                       animate-pulse inline-block"/>
              <p class="text-[10px] font-mono opacity-40">
                {{ statusLabel(currentPlan.status) }}
                · {{ steps.length }} 个步骤
              </p>
            </div>
          </div>

          <!-- 操作按钮组 -->
          <div class="flex items-center gap-2 shrink-0">
            <!-- draft 状态 -->
            <template v-if="currentPlan.status === 'draft'">
              <button @click="addStep"
                class="flex items-center gap-1.5 px-3 py-1.5 rounded-xl
                       text-[11px] border border-slate-200 hover:bg-slate-50">
                <Plus class="w-3 h-3"/>添加步骤
              </button>
              <button @click="confirmPlan"
                :disabled="!steps.length"
                class="flex items-center gap-1.5 px-3 py-1.5 rounded-xl
                       text-[11px] bg-oxygen-blue text-white
                       hover:opacity-80 disabled:opacity-40">
                <Check class="w-3 h-3"/>确认执行
              </button>
            </template>
            <!-- confirmed 状态 -->
            <button v-if="currentPlan.status === 'confirmed'"
              @click="executePlan"
              class="flex items-center gap-1.5 px-3 py-1.5 rounded-xl
                     text-[11px] bg-green-500 text-white hover:opacity-80">
              <Play class="w-3 h-3"/>开始执行
            </button>
            <!-- running 状态 -->
            <template v-if="currentPlan.status === 'running'">
              <span class="text-[11px] text-green-600 font-mono
                           flex items-center gap-1.5">
                <span class="w-2 h-2 rounded-full bg-green-500
                             animate-pulse inline-block"/>
                执行中
              </span>
              <button @click="pausePlan"
                class="flex items-center gap-1.5 px-3 py-1.5 rounded-xl
                       text-[11px] border border-slate-200 hover:bg-slate-50">
                <Pause class="w-3 h-3"/>暂停
              </button>
            </template>
            <!-- paused 状态 -->
            <button v-if="currentPlan.status === 'paused'"
              @click="resumePlan"
              class="flex items-center gap-1.5 px-3 py-1.5 rounded-xl
                     text-[11px] bg-oxygen-blue text-white hover:opacity-80">
              <Play class="w-3 h-3"/>继续执行
            </button>
            <!-- 删除（常驻）-->
            <button @click="deletePlan"
              class="p-2 rounded-xl hover:bg-red-50 text-red-400
                     transition-colors ml-1">
              <Trash2 class="w-4 h-4"/>
            </button>
          </div>
        </div>

        <!-- 步骤列表 -->
        <div class="flex-1 overflow-y-auto no-scrollbar p-6 space-y-3">
          <div v-if="!steps.length"
            class="text-center opacity-30 py-8 text-sm">
            暂无步骤，点击「添加步骤」或使用 AI 拆解需求
          </div>

          <div v-for="(step, idx) in steps" :key="step.id"
            class="bg-slate-50 rounded-2xl p-4 flex gap-4">

            <!-- 状态图标 -->
            <div class="shrink-0 mt-0.5 w-5 flex justify-center">
              <div v-if="step.status === 'pending'"
                class="w-4 h-4 rounded-full border-2 border-slate-300"/>
              <Loader2 v-else-if="step.status === 'running'"
                class="w-4 h-4 text-oxygen-blue animate-spin"/>
              <CheckCircle v-else-if="step.status === 'done'"
                class="w-4 h-4 text-green-500"/>
              <XCircle v-else-if="step.status === 'failed'"
                class="w-4 h-4 text-red-500"/>
              <MinusCircle v-else-if="step.status === 'skipped'"
                class="w-4 h-4 text-slate-300"/>
            </div>

            <!-- 内容 -->
            <div class="flex-1 min-w-0">
              <!-- 步骤标题 -->
              <div class="flex items-center gap-2 mb-1">
                <span class="text-[10px] font-mono opacity-30 shrink-0">
                  {{ String(idx + 1).padStart(2, '0') }}
                </span>
                <input v-if="isEditable"
                  v-model="step.title"
                  @blur="saveSteps"
                  class="flex-1 text-sm font-medium bg-transparent
                         outline-none border-none"/>
                <span v-else class="text-sm font-medium truncate">
                  {{ step.title }}
                </span>
              </div>

              <!-- prompt 折叠 -->
              <div class="mt-1.5">
                <button @click="step._expanded = !step._expanded"
                  class="flex items-center gap-1 text-[10px] font-mono
                         opacity-40 hover:opacity-70 transition-opacity">
                  <ChevronRight class="w-3 h-3 transition-transform"
                    :class="step._expanded ? 'rotate-90' : ''"/>
                  {{ isEditable ? '查看/编辑指令' : '查看指令' }}
                </button>
                <div v-if="step._expanded" class="mt-2">
                  <textarea v-if="isEditable"
                    v-model="step.prompt"
                    @blur="saveSteps"
                    rows="4"
                    class="w-full bg-white rounded-2xl px-4 py-2.5
                           border border-slate-100 text-[11px] font-mono
                           outline-none focus:border-oxygen-blue/40
                           resize-none transition-colors"/>
                  <pre v-else
                    class="bg-white rounded-2xl px-4 py-2.5 text-[11px]
                           font-mono whitespace-pre-wrap text-slate-600
                           border border-slate-100">{{ step.prompt }}</pre>
                </div>
              </div>

              <!-- 执行输出 -->
              <div v-if="step.output"
                class="mt-2 bg-green-50 rounded-2xl px-4 py-2.5
                       text-[11px] font-mono text-green-700
                       whitespace-pre-wrap border border-green-100">
                {{ step.output.slice(0, 400) }}
                <span v-if="step.output.length > 400"
                  class="opacity-50">...</span>
              </div>

              <!-- 失败操作 -->
              <div v-if="step.status === 'failed'"
                class="flex gap-2 mt-2">
                <button @click="retryStep(step.id)"
                  class="flex items-center gap-1.5 px-3 py-1.5 rounded-xl
                         text-[11px] bg-oxygen-blue text-white hover:opacity-80">
                  <RotateCcw class="w-3 h-3"/>重试
                </button>
                <button @click="skipStep(step.id)"
                  class="flex items-center gap-1.5 px-3 py-1.5 rounded-xl
                         text-[11px] border border-slate-200 hover:bg-slate-50">
                  <SkipForward class="w-3 h-3"/>跳过
                </button>
              </div>
            </div>

            <!-- 排序/删除（draft时）-->
            <div v-if="isEditable"
              class="flex flex-col gap-1 shrink-0">
              <button v-if="idx > 0" @click="moveStep(idx, 'up')"
                class="p-1 rounded-lg hover:bg-white transition-colors
                       opacity-40 hover:opacity-70">
                <ChevronUp class="w-3 h-3"/>
              </button>
              <button v-if="idx < steps.length - 1"
                @click="moveStep(idx, 'down')"
                class="p-1 rounded-lg hover:bg-white transition-colors
                       opacity-40 hover:opacity-70">
                <ChevronDown class="w-3 h-3"/>
              </button>
              <button @click="removeStep(idx)"
                class="p-1 rounded-lg hover:bg-red-50 text-red-400
                       transition-colors opacity-40 hover:opacity-100">
                <X class="w-3 h-3"/>
              </button>
            </div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { useAppStore } from '../stores/app'
import { api } from '../api'
import {
  Plus, LayoutList, Sparkles, Loader2, Check, Play, Pause,
  Trash2, CheckCircle, XCircle, MinusCircle, ChevronRight,
  ChevronUp, ChevronDown, X, RotateCcw, SkipForward
} from 'lucide-vue-next'

const store = useAppStore()
const plans = ref([])
const currentPlan = ref(null)
const steps = ref([])
const showInput = ref(false)
const requirement = ref('')
const isGenerating = ref(false)
const editTitle = ref('')
const isPlansLoading = ref(true)

const isEditable = computed(() =>
  currentPlan.value?.status === 'draft')

// ── 工具函数 ──

function statusLabel(s) {
  return { draft:'草稿', confirmed:'待执行', running:'执行中',
           paused:'已暂停', done:'已完成', failed:'失败' }[s] || s
}
function statusBadge(s) {
  return {
    draft:     'bg-slate-100 text-slate-500',
    confirmed: 'bg-blue-100 text-blue-600',
    running:   'bg-green-100 text-green-700',
    paused:    'bg-amber-100 text-amber-600',
    done:      'bg-green-100 text-green-600',
    failed:    'bg-red-100 text-red-500',
  }[s] || 'bg-slate-100 text-slate-400'
}
function formatDate(ts) {
  if (!ts) return ''
  return new Date(ts).toLocaleDateString('zh-CN', {
    month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit'
  })
}

// ── 数据加载 ──

async function loadPlans() {
  if (!store.currentWorkspace) return
  isPlansLoading.value = true
  try {
    const data = await api.get(
      `/api/plans?workspaceId=${store.currentWorkspace.id}`)
    plans.value = data?.plans || []
  } finally {
    isPlansLoading.value = false
  }
}

async function selectPlan(id) {
  const data = await api.get(`/api/plans/${id}`)
  const plan = data?.plan || data
  currentPlan.value = plan
  editTitle.value = plan.title
  steps.value = (plan.steps || []).map(s => ({ ...s, _expanded: false }))
}

// ── 生成 ──

async function handleGenerate() {
  if (!requirement.value.trim() || isGenerating.value) return
  isGenerating.value = true
  try {
    const data = await api.post('/api/plans/generate', {
      workspaceId: store.currentWorkspace.id,
      requirement: requirement.value,
    })
    const planId = data?.plan?.id || data?.planId || data?.id
    if (planId) {
      showInput.value = false
      requirement.value = ''
      await loadPlans()
      await selectPlan(planId)
    }
  } catch (e) {
    console.error('[Plan] generate failed:', e)
  } finally {
    isGenerating.value = false
  }
}

// ── 步骤编辑 ──

function addStep() {
  steps.value.push({
    id: 'new-' + Date.now(),
    title: '新步骤',
    prompt: '',
    status: 'pending',
    order_index: steps.value.length,
    _expanded: true,
  })
}

function moveStep(idx, dir) {
  const arr = steps.value
  if (dir === 'up' && idx > 0) {
    [arr[idx], arr[idx - 1]] = [arr[idx - 1], arr[idx]]
  } else if (dir === 'down' && idx < arr.length - 1) {
    [arr[idx], arr[idx + 1]] = [arr[idx + 1], arr[idx]]
  }
}

function removeStep(idx) {
  steps.value.splice(idx, 1)
}

async function saveSteps() {
  if (!currentPlan.value || !isEditable.value) return
  await api.put(`/api/plans/${currentPlan.value.id}/steps`, {
    steps: steps.value.map((s, i) => ({
      id: s.id,
      title: s.title,
      prompt: s.prompt,
      order_index: i,
    }))
  })
}

async function saveTitleIfChanged() {
  if (!currentPlan.value || !isEditable.value) return
  if (editTitle.value === currentPlan.value.title) return
  await api.put(`/api/plans/${currentPlan.value.id}`, {
    title: editTitle.value
  })
  currentPlan.value.title = editTitle.value
  await loadPlans()
}

// ── 执行控制 ──

async function confirmPlan() {
  await saveSteps()
  await api.post(`/api/plans/${currentPlan.value.id}/confirm`, {})
  await selectPlan(currentPlan.value.id)
}

async function executePlan() {
  await api.post(`/api/plans/${currentPlan.value.id}/execute`, {})
  currentPlan.value.status = 'running'
}

async function pausePlan() {
  await api.post(`/api/plans/${currentPlan.value.id}/pause`, {})
  currentPlan.value.status = 'paused'
}

async function resumePlan() {
  await api.post(`/api/plans/${currentPlan.value.id}/resume`, {})
  currentPlan.value.status = 'running'
}

async function deletePlan() {
  if (!confirm(`确认删除「${currentPlan.value.title}」？`)) return
  await api.delete(`/api/plans/${currentPlan.value.id}`)
  currentPlan.value = null
  steps.value = []
  await loadPlans()
}

async function retryStep(stepId) {
  await api.post(
    `/api/plans/${currentPlan.value.id}/steps/${stepId}/retry`, {})
  await selectPlan(currentPlan.value.id)
}

async function skipStep(stepId) {
  await api.post(
    `/api/plans/${currentPlan.value.id}/steps/${stepId}/skip`, {})
  const step = steps.value.find(s => s.id === stepId)
  if (step) step.status = 'skipped'
}

// ── WS 实时更新 ──

// 在 app.js 的 WS onmessage 中处理 plan 相关消息
// 这里暴露更新方法供外部调用
function handleWSMessage(msg) {
  switch (msg.type) {
    case 'plan_step_start': {
      const s = steps.value.find(s => s.id === msg.stepId)
      if (s) s.status = 'running'
      if (currentPlan.value) currentPlan.value.status = 'running'
      break
    }
    case 'plan_step_done': {
      const s = steps.value.find(s => s.id === msg.stepId)
      if (s) { s.status = 'done'; s.output = msg.output }
      break
    }
    case 'plan_step_failed': {
      const s = steps.value.find(s => s.id === msg.stepId)
      if (s) { s.status = 'failed'; s.output = msg.error }
      break
    }
    case 'plan_done': {
      if (currentPlan.value?.id === msg.planId) {
        currentPlan.value.status = 'done'
      }
      break
    }
  }
}

// ── 生命周期 ──

watch(() => store.currentWorkspace, (ws) => {
  if (ws) loadPlans()
}, { immediate: true })
</script>