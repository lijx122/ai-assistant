<template>
  <!-- 登录界面 -->
  <div v-if="!store.isLoggedIn"
    class="h-screen bg-limestone flex items-center justify-center">
    <div class="tactile-container p-10 w-80 flex flex-col gap-5">
      <div class="flex items-center gap-3 mb-2">
        <div class="w-10 h-10 bg-deep-charcoal rounded-2xl flex items-center
                    justify-center text-white font-bold italic">W</div>
        <div>
          <p class="font-bold">AI Workbench</p>
          <p class="text-[10px] opacity-40 font-mono">v2026</p>
        </div>
      </div>
      <div>
        <p class="text-[10px] font-mono opacity-40 mb-1.5">用户名</p>
        <input v-model="loginUser" type="text"
          class="w-full bg-white px-4 py-2.5 rounded-2xl border border-slate-100
                 text-sm font-mono outline-none focus:border-oxygen-blue/40"/>
      </div>
      <div>
        <p class="text-[10px] font-mono opacity-40 mb-1.5">密码</p>
        <input v-model="loginPass" type="password"
          @keydown.enter="doLogin"
          class="w-full bg-white px-4 py-2.5 rounded-2xl border border-slate-100
                 text-sm font-mono outline-none focus:border-oxygen-blue/40"/>
      </div>
      <p v-if="loginErr" class="text-[11px] text-red-400 font-mono">{{ loginErr }}</p>
      <button @click="doLogin"
        class="bg-deep-charcoal text-white py-3 rounded-2xl text-sm
               font-bold hover:opacity-80 transition-opacity">登录</button>
    </div>
  </div>

  <!-- 主界面 -->
  <div v-else class="flex h-screen p-5 gap-5 bg-limestone font-['Plus_Jakarta_Sans']">

    <!-- 侧边导航 -->
    <nav class="w-20 tactile-container flex flex-col items-center
                py-8 gap-5 shadow-sm shrink-0">
      <div class="w-11 h-11 bg-deep-charcoal rounded-2xl flex items-center
                  justify-center text-white font-bold italic text-lg
                  shadow-lg mb-2">W</div>

      <button @click="currentView='intelligence'"
        :class="['nav-link p-3.5 rounded-2xl',
                 currentView==='intelligence' ? 'active' : '']"
        title="对话">
        <MessageCircle class="w-5 h-5"/>
      </button>
      <button @click="currentView='engineering'"
        :class="['nav-link p-3.5 rounded-2xl',
                 currentView==='engineering' ? 'active' : '']"
        title="工程化">
        <Code2 class="w-5 h-5"/>
      </button>
      <button @click="currentView='automation'"
        :class="['nav-link p-3.5 rounded-2xl',
                 currentView==='automation' ? 'active' : '']"
        title="定时任务">
        <CalendarClock class="w-5 h-5"/>
      </button>
      <button @click="currentView='observability'"
        :class="['nav-link p-3.5 rounded-2xl',
                 currentView==='observability' ? 'active' : '']"
        title="仪表盘">
        <BarChartBig class="w-5 h-5"/>
      </button>
      <button @click="currentView='logs'"
        :class="['nav-link p-3.5 rounded-2xl',
                 currentView==='logs' ? 'active' : '']"
        title="日志">
        <ScrollText class="w-5 h-5"/>
      </button>
      <!-- 任务规划 - 暂时隐藏 -->
      <!-- <button @click="currentView='plan'"
        :class="['nav-link p-3.5 rounded-2xl',
                 currentView==='plan' ? 'active' : '']"
        title="任务规划">
        <LayoutList class="w-5 h-5"/>
      </button> -->

      <div class="mt-auto">
        <button @click="doLogout" class="nav-link p-3.5 rounded-2xl" title="退出">
          <LogOut class="w-5 h-5"/>
        </button>
      </div>
    </nav>

    <!-- 主内容区 -->
    <div class="flex-1 flex flex-col gap-5 overflow-hidden min-w-0">

      <!-- Header -->
      <header class="h-[66px] flex items-center justify-between px-6
                     tactile-container shrink-0">
        <div class="flex items-center gap-4">
          <!-- 工作区选择器 -->
          <div class="relative" ref="wsPicker" data-ws-picker>
            <div @click="wsPickerOpen = !wsPickerOpen"
              class="flex items-center gap-2 bg-white/80 px-4 py-2 rounded-full
                     border border-white shadow-sm cursor-pointer hover:bg-white">
              <span class="w-2 h-2 rounded-full bg-green-500 dot-pulse"></span>
              <span class="text-sm font-semibold font-mono">
                {{ store.currentWorkspace?.name || '选择工作区' }}
              </span>
              <ChevronDown class="w-4 h-4 opacity-40"/>
            </div>
            <!-- 下拉 -->
            <div v-if="wsPickerOpen"
              class="absolute top-full mt-2 left-0 bg-white/95 backdrop-blur-xl
                     border border-white/80 rounded-2xl shadow-xl overflow-hidden
                     z-50 min-w-48">
              <div class="py-1.5">
                <button v-for="ws in store.workspaces" :key="ws.id"
                  @click.stop="selectWorkspace(ws)"
                  class="w-full flex items-center gap-2 px-4 py-2.5 text-sm
                         hover:bg-slate-50 text-left font-mono">
                  <span class="w-1.5 h-1.5 rounded-full"
                    :class="ws.id === store.currentWorkspace?.id
                      ? 'bg-green-500' : 'bg-slate-300'"></span>
                  {{ ws.name }}
                </button>
              </div>
              <div class="border-t border-slate-100 p-2" data-ws-picker>
                <!-- 未输入时显示按钮 -->
                <div v-if="!showNewWsInput"
                  @click.stop="showNewWsInput = true"
                  class="flex items-center gap-2 px-3 py-2 rounded-xl
                         hover:bg-slate-50 text-[11px] font-mono opacity-50
                         cursor-pointer transition-opacity hover:opacity-70">
                  <Plus class="w-3 h-3"/>新建工作区
                </div>
                <!-- 输入时显示 input -->
                <div v-else class="flex items-center gap-2 px-1" @click.stop>
                  <input v-model="newWsName" ref="newWsInputEl"
                    class="flex-1 bg-white px-3 py-1.5 rounded-xl border
                           border-slate-200 text-[11px] font-mono outline-none
                           focus:border-oxygen-blue/40 min-w-0"
                    placeholder="工作区名称"
                    @keydown.enter="createWorkspace"
                    @keydown.esc="showNewWsInput = false; newWsName = ''"/>
                  <button @click="createWorkspace"
                    :disabled="!newWsName.trim()"
                    class="px-2 py-1.5 rounded-xl bg-oxygen-blue text-white
                           text-[11px] disabled:opacity-40 hover:opacity-80
                           transition-opacity shrink-0">
                    确定
                  </button>
                </div>
              </div>
            </div>
          </div>
          <!-- 工作区管理按钮 -->
          <button @click="showWsManager = true"
            class="p-2 rounded-xl hover:bg-slate-100 transition-colors"
            title="管理工作区">
            <Settings class="w-4 h-4 opacity-30 hover:opacity-60 transition-opacity"/>
          </button>
          <span class="w-px h-4 bg-slate-200 hidden sm:block"></span>
          <div class="hidden md:flex items-center gap-1.5 text-[10px] font-mono opacity-35">
            <Lock class="w-3 h-3"/>
            <span>锁: 空闲 · 队列: 0</span>
          </div>
        </div>

        <div class="flex items-center gap-5">
          <div class="flex items-center gap-3 font-mono text-[10px]">
            <span class="flex items-center gap-1.5 opacity-45">
              <span class="w-1.5 h-1.5 rounded-full bg-green-500"></span>运行器
            </span>
            <span class="flex items-center gap-1.5 opacity-45">
              <span class="w-1.5 h-1.5 rounded-full bg-blue-400"></span>记忆
            </span>
            <span class="flex items-center gap-1.5 opacity-45">
              <span class="w-1.5 h-1.5 rounded-full bg-purple-400"></span>飞书
            </span>
          </div>
          <span class="w-px h-4 bg-slate-200 hidden sm:block"></span>
          <div class="text-right hidden sm:block">
            <p class="text-[9px] font-bold opacity-25 uppercase tracking-[0.2em]">
              运行器状态</p>
            <p class="text-[11px] font-mono">idle</p>
          </div>
          <div class="w-9 h-9 rounded-full bg-slate-200 border-2 border-white
                      shadow-sm flex items-center justify-center
                      text-[10px] font-bold">
            {{ store.token ? 'A' : '?' }}
          </div>
        </div>
      </header>

      <!-- 视图区 -->
      <component :is="currentComponent" class="flex-1 min-h-0 overflow-hidden"/>
    </div>

    <!-- 工作区管理 Modal -->
    <div v-if="showWsManager"
      class="fixed inset-0 bg-black/20 backdrop-blur-sm z-50
             flex items-center justify-center p-5"
      @click.self="showWsManager = false">
      <div class="tactile-container p-8 w-[480px] flex flex-col gap-5
                  max-h-[80vh] overflow-hidden">

        <!-- 标题 -->
        <div class="flex items-center justify-between shrink-0">
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 bg-oxygen-blue/10 rounded-2xl flex
                        items-center justify-center">
              <FolderOpen class="w-5 h-5 text-oxygen-blue"/>
            </div>
            <div>
              <p class="font-bold">工作区管理</p>
              <p class="text-[10px] font-mono opacity-40">
                {{ store.workspaces?.length || 0 }} 个工作区
              </p>
            </div>
          </div>
          <button @click="showWsManager = false"
            class="p-2 rounded-xl hover:bg-slate-100 transition-colors">
            <X class="w-4 h-4 opacity-40"/>
          </button>
        </div>

        <!-- 工作区列表 -->
        <div class="flex-1 overflow-y-auto no-scrollbar space-y-2">
          <div v-for="ws in store.workspaces" :key="ws.id"
            class="flex items-center gap-3 p-3 rounded-2xl bg-slate-50
                   hover:bg-slate-100 transition-colors group">

            <!-- 工作区图标 -->
            <div class="w-8 h-8 rounded-xl flex items-center justify-center shrink-0"
              :class="ws.id === store.currentWorkspace?.id
                ? 'bg-oxygen-blue/15' : 'bg-white'">
              <Folder class="w-4 h-4"
                :class="ws.id === store.currentWorkspace?.id
                  ? 'text-oxygen-blue' : 'opacity-40'"/>
            </div>

            <!-- 名称（可内联编辑）-->
            <div class="flex-1 min-w-0">
              <template v-if="editingWsId === ws.id">
                <input v-model="editingWsName"
                  :ref="el => { if (editingWsId === ws.id) editWsInputEl = el }"
                  class="w-full bg-white px-3 py-1.5 rounded-xl border
                         border-oxygen-blue/30 text-sm font-mono outline-none"
                  @keydown.enter="saveWsName(ws)"
                  @keydown.esc="editingWsId = null"
                  @blur="saveWsName(ws)"
                  @click.stop/>
              </template>
              <template v-else>
                <p class="text-sm font-medium truncate">{{ ws.name }}</p>
                <p class="text-[10px] font-mono opacity-30 truncate">
                  {{ ws.root_path?.split('/').pop() || ws.id.slice(0, 8) }}
                </p>
              </template>
            </div>

            <!-- 当前标记 -->
            <span v-if="ws.id === store.currentWorkspace?.id"
              class="text-[9px] font-mono bg-oxygen-blue/10
                     text-oxygen-blue px-2 py-0.5 rounded-full shrink-0">
              当前
            </span>

            <!-- 操作按钮 -->
            <div class="flex items-center gap-1 shrink-0
                        opacity-0 group-hover:opacity-100 transition-opacity">
              <!-- 切换 -->
              <button v-if="ws.id !== store.currentWorkspace?.id"
                @click="switchAndClose(ws)"
                class="p-1.5 rounded-lg hover:bg-white transition-colors"
                title="切换到此工作区">
                <ArrowRightCircle class="w-3.5 h-3.5 text-oxygen-blue"/>
              </button>
              <!-- 重命名 -->
              <button @click.stop="startEditWs(ws)"
                class="p-1.5 rounded-lg hover:bg-white transition-colors"
                title="重命名">
                <Pencil class="w-3.5 h-3.5 opacity-40"/>
              </button>
              <!-- 删除 -->
              <button
                @click="deleteWorkspace(ws)"
                :disabled="store.workspaces?.length <= 1"
                class="p-1.5 rounded-lg hover:bg-red-50 transition-colors
                       disabled:opacity-20 disabled:cursor-not-allowed"
                title="删除">
                <Trash2 class="w-3.5 h-3.5 text-red-400"/>
              </button>
            </div>
          </div>
        </div>

        <!-- 新建工作区 -->
        <div class="shrink-0 border-t border-slate-100 pt-4">
          <div v-if="!showNewWsInManager" class="flex">
            <button @click="showNewWsInManager = true"
              class="flex items-center gap-2 px-4 py-2.5 rounded-2xl
                     bg-oxygen-blue/10 hover:bg-oxygen-blue/20
                     text-oxygen-blue text-sm font-medium transition-colors">
              <Plus class="w-4 h-4"/>新建工作区
            </button>
          </div>
          <div v-else class="flex gap-2">
            <input v-model="newWsName" ref="newWsManagerInputEl"
              class="flex-1 bg-white px-4 py-2.5 rounded-2xl border
                     border-slate-100 text-sm font-mono outline-none
                     focus:border-oxygen-blue/40 transition-colors min-w-0"
              placeholder="输入工作区名称..."
              @keydown.enter="createWorkspaceFromManager"
              @keydown.esc="showNewWsInManager = false"/>
            <button @click="createWorkspaceFromManager"
              :disabled="!newWsName.trim()"
              class="px-4 py-2.5 rounded-2xl bg-deep-charcoal text-white
                     text-sm font-bold hover:opacity-80 disabled:opacity-40
                     transition-opacity shrink-0">
              创建
            </button>
            <button @click="showNewWsInManager = false"
              class="px-3 py-2.5 rounded-2xl border border-slate-200
                     hover:bg-slate-50 text-sm transition-colors shrink-0">
              取消
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, markRaw, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { useAppStore } from './stores/app'
import { api } from './api'
import {
  MessageCircle, Code2, CalendarClock, BarChartBig,
  ScrollText, LayoutList, LogOut, ChevronDown, Plus, Lock,
  Settings, FolderOpen, Folder, ArrowRightCircle, Pencil, Trash2, X
} from 'lucide-vue-next'
import ChatView from './views/ChatView.vue'
import TasksView from './views/TasksView.vue'
import DashboardView from './views/DashboardView.vue'
import EngineeringView from './views/EngineeringView.vue'
import LogsView from './views/LogsView.vue'
import PlanView from './views/PlanView.vue'

// 其余视图暂用占位组件
const PlaceholderView = markRaw({
  template: '<div class="flex-1 flex items-center justify-center opacity-30 text-sm">开发中</div>'
})

const store = useAppStore()
const currentView = ref('intelligence')
const wsPickerOpen = ref(false)
const loginUser = ref('admin')
const loginPass = ref('changeme')
const loginErr = ref('')
const showNewWsInput = ref(false)
const newWsName = ref('')
const newWsInputEl = ref(null)
// 工作区管理 Modal
const showWsManager = ref(false)
const showNewWsInManager = ref(false)
const editingWsId = ref(null)
const editingWsName = ref('')
const editWsInputEl = ref(null)
const newWsManagerInputEl = ref(null)

const viewMap = {
  intelligence: markRaw(ChatView),
  engineering: markRaw(EngineeringView),
  automation: markRaw(TasksView),
  observability: markRaw(DashboardView),
  logs: markRaw(LogsView),
  plan: markRaw(PlanView),
}
const currentComponent = computed(() => viewMap[currentView.value])

async function doLogin() {
  loginErr.value = ''
  try {
    const data = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ username: loginUser.value, password: loginPass.value })
    }).then(r => r.json())
    if (data.success) {
      store.setToken('authenticated')
      await loadWorkspaces()
    } else {
      loginErr.value = data.error || '登录失败'
    }
  } catch {
    loginErr.value = '网络错误'
  }
}

function doLogout() {
  store.setToken('')
}

async function loadWorkspaces() {
  const data = await api.get('/api/workspaces')
  if (data?.workspaces) {
    store.setWorkspaces(data.workspaces)
    if (data.workspaces.length > 0) {
      store.setWorkspace(data.workspaces[0])
    }
  }
}

function selectWorkspace(ws) {
  store.setWorkspace(ws)
  wsPickerOpen.value = false
}

async function createWorkspace() {
  if (!newWsName.value.trim()) return
  try {
    const data = await api.post('/api/workspaces', {
      name: newWsName.value.trim(),
    })
    const newWs = data?.workspace
    if (newWs?.id) {
      showNewWsInput.value = false
      newWsName.value = ''
      wsPickerOpen.value = false
      await loadWorkspaces()
      store.setWorkspace(newWs)
    }
  } catch (e) {
    console.error('[Workspace] create failed:', e)
  }
}

// ── 工作区管理 Modal 相关函数 ──

watch(showNewWsInManager, async (val) => {
  if (val) {
    newWsName.value = ''
    await nextTick()
    newWsManagerInputEl.value?.focus()
  }
})

function startEditWs(ws) {
  editingWsId.value = ws.id
  editingWsName.value = ws.name
  nextTick(() => editWsInputEl?.focus())
}

async function saveWsName(ws) {
  if (!editingWsName.value.trim() ||
      editingWsName.value === ws.name) {
    editingWsId.value = null
    return
  }
  try {
    await api.put(`/api/workspaces/${ws.id}`, {
      name: editingWsName.value.trim()
    })
    await loadWorkspaces()
    // 如果改的是当前工作区，同步更新显示
    if (store.currentWorkspace?.id === ws.id && store.currentWorkspace) {
      store.currentWorkspace.name = editingWsName.value.trim()
    }
  } catch (e) {
    console.error('[Workspace] rename failed:', e)
  } finally {
    editingWsId.value = null
  }
}

async function deleteWorkspace(ws) {
  if ((store.workspaces?.length || 0) <= 1) return
  if (!confirm(`确认删除工作区「${ws.name}」？\n此操作将删除工作区内所有会话和文件，不可恢复。`)) return
  try {
    await api.delete(`/api/workspaces/${ws.id}`)
    await loadWorkspaces()
    // 如果删除的是当前工作区，切换到第一个
    if (store.currentWorkspace?.id === ws.id) {
      if (store.workspaces && store.workspaces.length > 0) {
        store.setWorkspace(store.workspaces[0])
      }
    }
  } catch (e) {
    console.error('[Workspace] delete failed:', e)
  }
}

async function createWorkspaceFromManager() {
  if (!newWsName.value.trim()) return
  try {
    const data = await api.post('/api/workspaces', {
      name: newWsName.value.trim()
    })
    const newWs = data?.workspace
    if (newWs?.id) {
      showNewWsInManager.value = false
      newWsName.value = ''
      await loadWorkspaces()
      store.setWorkspace(newWs)
    }
  } catch (e) {
    console.error('[Workspace] create failed:', e)
  }
}

function switchAndClose(ws) {
  store.setWorkspace(ws)
  showWsManager.value = false
}

// 监听 showNewWsInput，自动 focus 输入框
watch(showNewWsInput, async (val) => {
  if (val) {
    await nextTick()
    newWsInputEl.value?.focus()
  }
})

// 点击外部关闭下拉
function handleClickOutside(e) {
  if (!e.target.closest('[data-ws-picker]')) {
    wsPickerOpen.value = false
  }
}

onMounted(async () => {
  document.addEventListener('click', handleClickOutside)
  if (store.isLoggedIn) {
    await loadWorkspaces()
  }
})

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside)
})
</script>