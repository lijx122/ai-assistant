<template>
  <div class="flex flex-1 min-h-0 gap-5">

    <!-- 左侧列表 -->
    <div class="w-80 tactile-container flex flex-col overflow-hidden shrink-0">
      <div class="px-5 py-4 border-b border-slate-100/50 shrink-0">
        <div class="flex items-center justify-between mb-3">
          <p class="text-[9px] font-bold uppercase tracking-[0.2em] opacity-30">经验库</p>
          <button @click="openCreate"
            class="w-7 h-7 rounded-lg bg-oxygen-blue/10 hover:bg-oxygen-blue/20
                   flex items-center justify-center transition-colors">
            <Plus class="w-4 h-4 text-oxygen-blue"/>
          </button>
        </div>
        <input v-model="searchQ" @input="onSearch"
          placeholder="搜索教训..."
          class="w-full bg-white/80 border border-white rounded-xl px-3 py-1.5
                 text-[12px] outline-none focus:border-oxygen-blue/40"/>
      </div>
      <div class="flex-1 overflow-y-auto no-scrollbar p-3 space-y-1">
        <div v-if="loading" class="space-y-2 py-1">
          <div v-for="i in 5" :key="i" class="h-16 rounded-2xl wb-skeleton"></div>
        </div>
        <div v-else-if="!lessons.length"
          class="flex flex-col items-center justify-center py-8 text-slate-400">
          <BookOpen class="w-16 h-16 mb-3 opacity-30"/>
          <p class="text-[11px] font-mono">暂无教训</p>
        </div>
        <button v-else v-for="l in lessons" :key="l.id"
          @click="select(l)"
          :class="['w-full text-left px-4 py-3 rounded-2xl transition-colors',
                   current?.id === l.id ? 'bg-white shadow-sm' : 'hover:bg-white/60']">
          <div class="flex items-center gap-2 mb-1">
            <span class="text-[10px] bg-oxygen-blue/10 text-oxygen-blue rounded-full px-2 py-0.5 shrink-0">
              {{ l.task_type }}
            </span>
          </div>
          <p class="text-sm font-semibold leading-tight line-clamp-2">{{ l.title }}</p>
          <p class="text-[11px] text-slate-400 mt-0.5 line-clamp-1">{{ l.summary }}</p>
        </button>
      </div>
    </div>

    <!-- 右侧详情 -->
    <div class="flex-1 tactile-container flex flex-col overflow-hidden">

      <!-- 空状态 -->
      <div v-if="!current" class="flex-1 flex items-center justify-center">
        <div class="text-center text-slate-400">
          <BookOpen class="w-20 h-20 mx-auto mb-4 opacity-30"/>
          <p class="font-semibold">经验库</p>
          <p class="text-sm mt-1">选择一条教训查看详情</p>
          <p class="text-[11px] font-mono opacity-60 mt-2">记录过往规则，跨项目复用</p>
        </div>
      </div>

      <template v-else>
        <!-- Header -->
        <div class="flex items-center justify-between px-6 py-4
                    border-b border-slate-100/50 shrink-0">
          <div class="flex-1 min-w-0 mr-4">
            <div v-if="editing">
              <input v-model="editTitle"
                class="w-full bg-white border border-oxygen-blue/30 rounded-xl
                       px-3 py-1.5 text-sm font-semibold outline-none mb-2"/>
              <input v-model="editTaskType"
                placeholder="分类标签"
                class="w-40 bg-white border border-slate-200 rounded-xl
                       px-3 py-1.5 text-[11px] outline-none"/>
            </div>
            <div v-else>
              <div class="flex items-center gap-2">
                <span class="text-[10px] bg-oxygen-blue/10 text-oxygen-blue rounded-full px-2 py-0.5">
                  {{ current.task_type }}
                </span>
              </div>
              <h2 class="text-base font-semibold mt-1 leading-snug">{{ current.title }}</h2>
            </div>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <template v-if="editing">
              <button @click="saveEdit"
                :disabled="saving"
                class="px-4 py-1.5 bg-oxygen-blue text-white text-[12px] rounded-xl
                       hover:opacity-80 disabled:opacity-40 transition-opacity">
                {{ saving ? '保存中...' : '保存' }}
              </button>
              <button @click="cancelEdit"
                class="px-4 py-1.5 bg-slate-100 text-slate-600 text-[12px]
                       rounded-xl hover:bg-slate-200 transition-colors">
                取消
              </button>
            </template>
            <template v-else>
              <button @click="startEdit"
                class="p-2 rounded-xl hover:bg-slate-100 transition-colors">
                <Pencil class="w-4 h-4 text-slate-500"/>
              </button>
              <button @click="confirmDelete"
                class="p-2 rounded-xl hover:bg-red-50 transition-colors">
                <Trash2 class="w-4 h-4 text-red-400"/>
              </button>
            </template>
          </div>
        </div>

        <!-- Summary (editable) -->
        <div class="px-6 py-3 border-b border-slate-100/50 shrink-0">
          <p class="text-[10px] font-bold uppercase tracking-widest opacity-30 mb-1">摘要</p>
          <textarea v-if="editing" v-model="editSummary" rows="2"
            class="w-full bg-white border border-slate-200 rounded-xl px-3 py-2
                   text-[12px] outline-none resize-none focus:border-oxygen-blue/40"/>
          <p v-else class="text-[12px] text-slate-600 leading-relaxed">{{ current.summary }}</p>
        </div>

        <!-- Detail (editable markdown) -->
        <div class="flex-1 overflow-y-auto px-6 py-4">
          <p class="text-[10px] font-bold uppercase tracking-widest opacity-30 mb-3">详细内容</p>
          <textarea v-if="editing" v-model="editDetail" rows="16"
            class="w-full bg-white border border-slate-200 rounded-xl px-3 py-2
                   text-[12px] font-mono outline-none resize-none focus:border-oxygen-blue/40"/>
          <div v-else class="prose prose-sm max-w-none text-slate-700">
            <pre class="whitespace-pre-wrap text-[12px] font-mono bg-slate-50 rounded-xl p-4">{{ current.detail || '（无详细内容）' }}</pre>
          </div>
        </div>

        <!-- 关联邻居 -->
        <div v-if="neighbors.length" class="px-6 py-3 border-t border-slate-100/50 shrink-0">
          <p class="text-[10px] font-bold uppercase tracking-widest opacity-30 mb-2">关联教训</p>
          <div class="flex flex-wrap gap-2">
            <button v-for="n in neighbors" :key="n.id"
              @click="selectById(n.id)"
              class="flex items-center gap-1.5 px-3 py-1 rounded-xl
                     bg-slate-100 hover:bg-slate-200 transition-colors text-[11px]">
              <span class="text-[9px] opacity-50">{{ n.relation }}</span>
              <span class="font-medium">{{ n.title }}</span>
            </button>
          </div>
        </div>

        <!-- Meta footer -->
        <div class="px-6 py-2 border-t border-slate-100/50 shrink-0 flex gap-4 text-[10px] text-slate-400 font-mono">
          <span>命中 {{ current.hit_count }} 次</span>
          <span>更新 {{ fmtDate(current.updated_at) }}</span>
          <span>创建 {{ fmtDate(current.created_at) }}</span>
        </div>
      </template>
    </div>

    <!-- 新建 Modal -->
    <div v-if="showCreate"
      class="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center
             justify-center z-50 p-6">
      <div class="bg-white rounded-3xl shadow-2xl w-full max-w-lg p-6 flex flex-col gap-4">
        <div class="flex items-center justify-between">
          <h3 class="font-semibold text-base">记录新教训</h3>
          <button @click="showCreate=false"><X class="w-5 h-5 opacity-40"/></button>
        </div>
        <div class="flex gap-3">
          <div class="flex-1">
            <label class="text-[10px] opacity-40 font-bold uppercase tracking-widest">分类标签</label>
            <input v-model="newTaskType" placeholder="如 ts-debug, git-commit"
              class="w-full mt-1 bg-slate-50 border border-slate-200 rounded-xl
                     px-3 py-2 text-sm outline-none focus:border-oxygen-blue/40"/>
          </div>
        </div>
        <div>
          <label class="text-[10px] opacity-40 font-bold uppercase tracking-widest">标题（≤60字）</label>
          <input v-model="newTitle" placeholder="一句话总结"
            class="w-full mt-1 bg-slate-50 border border-slate-200 rounded-xl
                   px-3 py-2 text-sm outline-none focus:border-oxygen-blue/40"/>
        </div>
        <div>
          <label class="text-[10px] opacity-40 font-bold uppercase tracking-widest">摘要（≤200字）</label>
          <textarea v-model="newSummary" rows="2" placeholder="包含 Why"
            class="w-full mt-1 bg-slate-50 border border-slate-200 rounded-xl
                   px-3 py-2 text-sm outline-none resize-none focus:border-oxygen-blue/40"/>
        </div>
        <div>
          <label class="text-[10px] opacity-40 font-bold uppercase tracking-widest">详细内容（Markdown）</label>
          <textarea v-model="newDetail" rows="5" placeholder="规则 → Why → How to apply"
            class="w-full mt-1 bg-slate-50 border border-slate-200 rounded-xl
                   px-3 py-2 text-sm font-mono outline-none resize-none focus:border-oxygen-blue/40"/>
        </div>
        <div class="flex justify-end gap-2">
          <button @click="showCreate=false"
            class="px-4 py-2 text-sm rounded-xl bg-slate-100 hover:bg-slate-200 transition-colors">
            取消
          </button>
          <button @click="createLesson"
            :disabled="!newTitle.trim() || !newTaskType.trim() || creating"
            class="px-4 py-2 text-sm rounded-xl bg-oxygen-blue text-white
                   hover:opacity-80 disabled:opacity-40 transition-opacity">
            {{ creating ? '创建中...' : '创建' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { api } from '../api'
import { Plus, BookOpen, Pencil, Trash2, X } from 'lucide-vue-next'

const lessons = ref([])
const loading = ref(false)
const current = ref(null)
const neighbors = ref([])
const searchQ = ref('')
const searchTimer = ref(null)

const editing = ref(false)
const saving = ref(false)
const editTitle = ref('')
const editTaskType = ref('')
const editSummary = ref('')
const editDetail = ref('')

const showCreate = ref(false)
const creating = ref(false)
const newTaskType = ref('')
const newTitle = ref('')
const newSummary = ref('')
const newDetail = ref('')

async function load(q = '') {
  loading.value = true
  try {
    const params = q ? `?q=${encodeURIComponent(q)}` : ''
    const data = await api.get(`/api/lessons${params}`)
    lessons.value = data?.lessons || []
  } finally {
    loading.value = false
  }
}

function onSearch() {
  clearTimeout(searchTimer.value)
  searchTimer.value = setTimeout(() => load(searchQ.value), 350)
}

async function select(l) {
  const data = await api.get(`/api/lessons/${l.id}`)
  current.value = data
  editing.value = false
  loadGraph(l.id)
}

async function selectById(id) {
  const l = lessons.value.find(x => x.id === id)
  if (l) await select(l)
  else {
    const data = await api.get(`/api/lessons/${id}`)
    if (data && !data.error) current.value = data
  }
}

async function loadGraph(id) {
  neighbors.value = []
  const g = await api.get(`/api/lessons/${id}/graph?depth=1`)
  if (g?.neighbors) {
    neighbors.value = g.neighbors.map(n => ({
      id: n.lesson.id,
      title: n.lesson.title,
      relation: n.relation,
      direction: n.direction,
    }))
  }
}

function startEdit() {
  editTitle.value = current.value.title
  editTaskType.value = current.value.task_type
  editSummary.value = current.value.summary
  editDetail.value = current.value.detail || ''
  editing.value = true
}

function cancelEdit() { editing.value = false }

async function saveEdit() {
  saving.value = true
  try {
    await api.put(`/api/lessons/${current.value.id}`, {
      title: editTitle.value,
      task_type: editTaskType.value,
      summary: editSummary.value,
      detail: editDetail.value,
    })
    await select({ id: current.value.id })
    await load(searchQ.value)
    editing.value = false
  } finally {
    saving.value = false
  }
}

async function confirmDelete() {
  if (!confirm(`删除「${current.value.title}」？此操作不可撤销。`)) return
  await api.delete(`/api/lessons/${current.value.id}`)
  current.value = null
  await load(searchQ.value)
}

function openCreate() {
  newTaskType.value = ''
  newTitle.value = ''
  newSummary.value = ''
  newDetail.value = ''
  showCreate.value = true
}

async function createLesson() {
  creating.value = true
  try {
    const res = await api.post('/api/lessons', {
      task_type: newTaskType.value.trim(),
      title: newTitle.value.trim(),
      summary: newSummary.value.trim(),
      detail: newDetail.value.trim() || newSummary.value.trim(),
    })
    showCreate.value = false
    await load(searchQ.value)
    if (res?.id) await selectById(res.id)
  } finally {
    creating.value = false
  }
}

function fmtDate(ts) {
  if (!ts) return '-'
  return new Date(ts).toLocaleDateString('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'
  })
}

onMounted(() => load())
</script>
