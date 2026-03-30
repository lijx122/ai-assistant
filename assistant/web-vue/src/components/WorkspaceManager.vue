<template>
  <div class="fixed inset-0 bg-black/20 backdrop-blur-sm z-50
              flex items-center justify-center p-5"
       @click.self="$emit('close')">
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
        <button @click="$emit('close')"
          class="p-2 rounded-xl hover:bg-slate-100 transition-colors">
          <X class="w-4 h-4 opacity-40"/>
        </button>
      </div>

      <!-- 工作区列表 -->
      <div class="flex-1 overflow-y-auto no-scrollbar space-y-2">
        <div v-for="ws in store.workspaces" :key="ws.id"
          class="flex items-center gap-3 p-3 rounded-2xl bg-slate-50
                 hover:bg-slate-100 transition-colors group">
          <div class="w-8 h-8 rounded-xl flex items-center justify-center shrink-0"
            :class="ws.id === store.currentWorkspace?.id
              ? 'bg-oxygen-blue/15' : 'bg-white'">
            <Folder class="w-4 h-4"
              :class="ws.id === store.currentWorkspace?.id
                ? 'text-oxygen-blue' : 'opacity-40'"/>
          </div>
          <div class="flex-1 min-w-0">
            <p class="text-sm font-medium truncate">{{ ws.name }}</p>
            <p class="text-[10px] font-mono opacity-30 truncate">
              {{ ws.root_path?.split('/').pop() || ws.id.slice(0, 8) }}
            </p>
          </div>
          <span v-if="ws.id === store.currentWorkspace?.id"
            class="text-[9px] font-mono bg-oxygen-blue/10
                   text-oxygen-blue px-2 py-0.5 rounded-full shrink-0">
            当前
          </span>
          <div class="flex items-center gap-1 shrink-0
                      opacity-0 group-hover:opacity-100 transition-opacity">
            <button v-if="ws.id !== store.currentWorkspace?.id"
              @click="switchAndClose(ws)"
              class="p-1.5 rounded-lg hover:bg-white transition-colors">
              <ArrowRightCircle class="w-3.5 h-3.5 text-oxygen-blue"/>
            </button>
            <button @click="deleteWorkspace(ws)"
              :disabled="store.workspaces?.length <= 1"
              class="p-1.5 rounded-lg hover:bg-red-50 transition-colors
                     disabled:opacity-20 disabled:cursor-not-allowed">
              <Trash2 class="w-3.5 h-3.5 text-red-400"/>
            </button>
          </div>
        </div>
      </div>

      <!-- 新建工作区 -->
      <div class="shrink-0 border-t border-slate-100 pt-4">
        <button @click="showNewWsInManager = true"
          class="flex items-center gap-2 px-4 py-2.5 rounded-2xl
                 bg-oxygen-blue/10 hover:bg-oxygen-blue/20
                 text-oxygen-blue text-sm font-medium transition-colors">
          <Plus class="w-4 h-4"/>新建工作区
        </button>
        <div v-if="showNewWsInManager" class="flex gap-2 mt-3">
          <input v-model="newWsName" ref="newWsManagerInputEl"
            class="flex-1 bg-white px-4 py-2.5 rounded-2xl border
                   border-slate-100 text-sm font-mono outline-none
                   focus:border-oxygen-blue/40 min-w-0"
            placeholder="输入工作区名称..."
            @keydown.enter="createWorkspaceFromManager"
            @keydown.esc="showNewWsInManager = false"/>
          <button @click="createWorkspaceFromManager"
            :disabled="!newWsName.trim()"
            class="px-4 py-2.5 rounded-2xl bg-deep-charcoal text-white
                   text-sm font-bold hover:opacity-80 disabled:opacity-40">
            创建
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, nextTick } from 'vue'
import { useAppStore } from '../stores/app'
import { api } from '../api'
import { FolderOpen, Folder, ArrowRightCircle, Trash2, Plus, X } from 'lucide-vue-next'

const emit = defineEmits(['close'])

const store = useAppStore()
const showNewWsInManager = ref(false)
const newWsName = ref('')
const newWsManagerInputEl = ref(null)

function switchAndClose(ws) {
  store.setWorkspace(ws)
  emit('workspace-switched', ws)
}

async function loadWorkspaces() {
  const data = await api.get('/api/workspaces')
  if (data?.workspaces) {
    store.setWorkspaces(data.workspaces)
  }
}

async function deleteWorkspace(ws) {
  if ((store.workspaces?.length || 0) <= 1) return
  if (!confirm(`确认删除工作区「${ws.name}」？\n此操作将删除工作区内所有会话和文件，不可恢复。`)) return
  try {
    await api.delete(`/api/workspaces/${ws.id}`)
    await loadWorkspaces()
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
</script>
