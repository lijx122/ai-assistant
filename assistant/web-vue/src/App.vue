<template>
  <!-- 登录界面（保持不变） -->
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
        <input v-model="loginUser" type="text" autocomplete="off"
          class="w-full bg-white px-4 py-2.5 rounded-2xl border border-slate-100
                 text-sm font-mono outline-none focus:border-oxygen-blue/40"/>
      </div>
      <div>
        <p class="text-[10px] font-mono opacity-40 mb-1.5">密码</p>
        <input v-model="loginPass" type="password" autocomplete="new-password"
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

  <!-- ═══════════════════════════════════════════════════════════════ -->
  <!-- 桌面布局（≥1024px）：原有布局不变                              -->
  <!-- ═══════════════════════════════════════════════════════════════ -->
  <div v-else-if="isDesktop"
    class="flex h-screen p-5 gap-5 bg-limestone font-['Plus_Jakarta_Sans']">

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
                <div v-if="!showNewWsInput"
                  @click.stop="showNewWsInput = true"
                  class="flex items-center gap-2 px-3 py-2 rounded-xl
                         hover:bg-slate-50 text-[11px] font-mono opacity-50
                         cursor-pointer transition-opacity hover:opacity-70">
                  <Plus class="w-3 h-3"/>新建工作区
                </div>
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
          <span class="w-px h-4 bg-slate-200"></span>
          <div class="flex items-center gap-1.5 text-[10px] font-mono opacity-35">
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
          <span class="w-px h-4 bg-slate-200"></span>
          <div class="text-right">
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

    <!-- 工作区管理 Modal（桌面版） -->
    <Transition name="fade">
      <WorkspaceManager v-if="showWsManager && isDesktop"
      @close="showWsManager = false"
      @workspace-switched="showWsManager = false" />
    </Transition>
  </div>

  <!-- ═══════════════════════════════════════════════════════════════ -->
  <!-- 平板布局（768-1023px）：收窄侧边栏，内容区全宽                  -->
  <!-- ═══════════════════════════════════════════════════════════════ -->
  <div v-else-if="isTablet"
    class="flex h-screen bg-limestone font-['Plus_Jakarta_Sans']">

    <!-- 收窄侧边栏（只有图标） -->
    <nav class="w-14 bg-white flex flex-col items-center py-6 gap-4
                border-r border-slate-100 shrink-0">
      <div class="w-9 h-9 bg-deep-charcoal rounded-xl flex items-center
                  justify-center text-white font-bold italic text-sm mb-2">W</div>

      <button @click="currentView='intelligence'"
        :class="['p-2.5 rounded-xl transition-colors',
                 currentView==='intelligence'
                   ? 'bg-oxygen-blue/10 text-oxygen-blue'
                   : 'text-slate-400 hover:bg-slate-50']">
        <MessageCircle class="w-5 h-5"/>
      </button>
      <button @click="currentView='engineering'"
        :class="['p-2.5 rounded-xl transition-colors',
                 currentView==='engineering'
                   ? 'bg-oxygen-blue/10 text-oxygen-blue'
                   : 'text-slate-400 hover:bg-slate-50']">
        <Code2 class="w-5 h-5"/>
      </button>
      <button @click="currentView='automation'"
        :class="['p-2.5 rounded-xl transition-colors',
                 currentView==='automation'
                   ? 'bg-oxygen-blue/10 text-oxygen-blue'
                   : 'text-slate-400 hover:bg-slate-50']">
        <CalendarClock class="w-5 h-5"/>
      </button>
      <button @click="currentView='observability'"
        :class="['p-2.5 rounded-xl transition-colors',
                 currentView==='observability'
                   ? 'bg-oxygen-blue/10 text-oxygen-blue'
                   : 'text-slate-400 hover:bg-slate-50']">
        <BarChartBig class="w-5 h-5"/>
      </button>
      <button @click="currentView='logs'"
        :class="['p-2.5 rounded-xl transition-colors',
                 currentView==='logs'
                   ? 'bg-oxygen-blue/10 text-oxygen-blue'
                   : 'text-slate-400 hover:bg-slate-50']">
        <ScrollText class="w-5 h-5"/>
      </button>

      <button @click="doLogout"
        class="mt-auto p-2.5 rounded-xl text-slate-400 hover:bg-slate-50">
        <LogOut class="w-5 h-5"/>
      </button>
    </nav>

    <!-- 主内容区（全宽） -->
    <div class="flex-1 flex flex-col overflow-hidden min-w-0">
      <!-- 简化 header -->
      <header class="h-14 flex items-center justify-between px-4
                     bg-white border-b border-slate-100 shrink-0">
        <div class="flex items-center gap-2 cursor-pointer"
          @click="drawerOpen = true; drawerContent = 'workspaces'">
          <span class="w-2 h-2 rounded-full bg-green-500"/>
          <span class="text-sm font-semibold font-mono">
            {{ store.currentWorkspace?.name || '选择工作区' }}
          </span>
          <ChevronDown class="w-4 h-4 opacity-40"/>
        </div>
        <div class="flex items-center gap-3 text-[10px] font-mono">
          <span class="flex items-center gap-1 opacity-40">
            <span class="w-1.5 h-1.5 rounded-full bg-green-500"/>运行器
          </span>
          <div class="w-8 h-8 rounded-full bg-slate-200 flex items-center
                      justify-center text-[10px] font-bold">A</div>
        </div>
      </header>
      <component :is="currentComponent" class="flex-1 min-h-0"/>
    </div>
  </div>

  <!-- ═══════════════════════════════════════════════════════════════ -->
  <!-- 手机布局（<768px）：底部导航栏 + 全屏视图                        -->
  <!-- ═══════════════════════════════════════════════════════════════ -->
  <div v-else
    class="flex flex-col h-screen bg-limestone font-['Plus_Jakarta_Sans']">
    <!-- 顶部 header -->
    <header class="h-14 flex items-center justify-between px-4
                   bg-white border-b border-slate-100 shrink-0 z-10">
      <button @click="drawerOpen = true; drawerContent = 'menu'"
        class="p-2 rounded-lg hover:bg-slate-100">
        <Menu class="w-5 h-5"/>
      </button>
      <span class="text-sm font-semibold font-mono">
        {{ store.currentWorkspace?.name || 'AI Workbench' }}
      </span>
      <div class="w-8 h-8 rounded-full bg-slate-200 flex items-center
                  justify-center text-[10px] font-bold">A</div>
    </header>

    <!-- 主内容（全屏） -->
    <div class="flex-1 min-h-0 overflow-hidden">
      <component :is="currentComponent" class="h-full"/>
    </div>

    <!-- 底部导航栏 -->
    <nav class="h-16 bg-white border-t border-slate-100 flex items-center
                justify-around px-2 shrink-0 safe-area-pb">
      <button @click="currentView = 'intelligence'"
        :class="['flex flex-col items-center gap-1 p-2 rounded-xl flex-1',
                 currentView === 'intelligence'
                   ? 'text-oxygen-blue'
                   : 'text-slate-400']">
        <MessageCircle class="w-5 h-5"/>
        <span class="text-[9px] font-mono">对话</span>
      </button>
      <button @click="currentView = 'engineering'"
        :class="['flex flex-col items-center gap-1 p-2 rounded-xl flex-1',
                 currentView === 'engineering'
                   ? 'text-oxygen-blue'
                   : 'text-slate-400']">
        <Code2 class="w-5 h-5"/>
        <span class="text-[9px] font-mono">工程</span>
      </button>
      <button @click="currentView = 'automation'"
        :class="['flex flex-col items-center gap-1 p-2 rounded-xl flex-1',
                 currentView === 'automation'
                   ? 'text-oxygen-blue'
                   : 'text-slate-400']">
        <CalendarClock class="w-5 h-5"/>
        <span class="text-[9px] font-mono">任务</span>
      </button>
      <button @click="currentView = 'observability'"
        :class="['flex flex-col items-center gap-1 p-2 rounded-xl flex-1',
                 currentView === 'observability'
                   ? 'text-oxygen-blue'
                   : 'text-slate-400']">
        <BarChartBig class="w-5 h-5"/>
        <span class="text-[9px] font-mono">仪表</span>
      </button>
      <button @click="currentView = 'logs'"
        :class="['flex flex-col items-center gap-1 p-2 rounded-xl flex-1',
                 currentView === 'logs'
                   ? 'text-oxygen-blue'
                   : 'text-slate-400']">
        <ScrollText class="w-5 h-5"/>
        <span class="text-[9px] font-mono">日志</span>
      </button>
    </nav>
  </div>

  <!-- ═══════════════════════════════════════════════════════════════ -->
  <!-- 抽屉（平板/手机端菜单）                                         -->
  <!-- ═══════════════════════════════════════════════════════════════ -->
  <Transition name="slide">
    <div v-if="drawerOpen"
      class="fixed inset-0 z-50 flex"
      @click.self="drawerOpen = false">
      <div class="w-72 bg-white h-full shadow-2xl flex flex-col p-6">
        <div class="flex items-center justify-between mb-6">
          <div class="w-9 h-9 bg-deep-charcoal rounded-xl flex items-center
                      justify-center text-white font-bold italic">W</div>
          <button @click="drawerOpen = false">
            <X class="w-5 h-5 opacity-40"/>
          </button>
        </div>

        <!-- 工作区列表 -->
        <p class="text-[9px] font-mono opacity-30 uppercase tracking-widest mb-3">
          工作区
        </p>
        <div class="space-y-1 mb-6">
          <button v-for="ws in store.workspaces" :key="ws.id"
            @click="selectWorkspace(ws); drawerOpen = false"
            :class="['w-full text-left px-3 py-2.5 rounded-xl text-sm',
                     ws.id === store.currentWorkspace?.id
                       ? 'bg-oxygen-blue/10 text-oxygen-blue font-medium'
                       : 'hover:bg-slate-50']">
            {{ ws.name }}
          </button>
        </div>

        <div class="mt-auto">
          <button @click="showWsManager = true; drawerOpen = false"
            class="w-full flex items-center gap-2 px-3 py-2.5 rounded-xl
                   hover:bg-slate-50 text-sm mb-2">
            <Settings class="w-4 h-4 opacity-60"/>管理工作区
          </button>
          <button @click="doLogout"
            class="w-full flex items-center gap-2 px-3 py-2.5 rounded-xl
                   text-red-400 hover:bg-red-50 text-sm">
            <LogOut class="w-4 h-4"/>退出登录
          </button>
        </div>
      </div>
      <!-- 遮罩 -->
      <div class="flex-1 bg-black/20 backdrop-blur-sm"/>
    </div>
  </Transition>

  <!-- 工作区管理 Modal（移动端） -->
  <Transition name="fade">
    <WorkspaceManager v-if="showWsManager && !isDesktop"
      @close="showWsManager = false"
      @workspace-switched="showWsManager = false" />
  </Transition>
</template>

<script setup>
import { ref, computed, markRaw, onMounted, onUnmounted, watch, nextTick, provide } from 'vue'
import { useAppStore } from './stores/app'
import { api } from './api'
import {
  MessageCircle, Code2, CalendarClock, BarChartBig,
  ScrollText, LayoutList, LogOut, ChevronDown, Plus, Lock,
  Settings, FolderOpen, Folder, ArrowRightCircle, Pencil, Trash2, X, Menu
} from 'lucide-vue-next'
import ChatView from './views/ChatView.vue'
import TasksView from './views/TasksView.vue'
import DashboardView from './views/DashboardView.vue'
import EngineeringView from './views/EngineeringView.vue'
import LogsView from './views/LogsView.vue'
import PlanView from './views/PlanView.vue'
import WorkspaceManager from './components/WorkspaceManager.vue'

// 注册本地组件
defineOptions({
  components: { WorkspaceManager }
})

const store = useAppStore()

// ── 响应式状态 ──
const windowWidth = ref(window.innerWidth)
const isMobile = computed(() => windowWidth.value < 768)
const isTablet = computed(() => windowWidth.value >= 768 && windowWidth.value < 1024)
const isDesktop = computed(() => windowWidth.value >= 1024)

// 移动端抽屉状态
const drawerOpen = ref(false)
const drawerContent = ref(null) // 'sessions' | 'workspaces' | 'menu' | null

function onResize() { windowWidth.value = window.innerWidth }
onMounted(() => window.addEventListener('resize', onResize))
onUnmounted(() => window.removeEventListener('resize', onResize))

// Provide 给子组件
provide('isMobile', isMobile)
provide('isTablet', isTablet)

const currentView = ref('intelligence')
const wsPickerOpen = ref(false)
const loginUser = ref('')
const loginPass = ref('')
const loginErr = ref('')
const showNewWsInput = ref(false)
const newWsName = ref('')
const newWsInputEl = ref(null)
// 工作区管理 Modal
const showWsManager = ref(false)

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
