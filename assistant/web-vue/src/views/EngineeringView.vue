<template>
  <div class="flex flex-1 min-h-0 gap-0 rounded-3xl overflow-hidden"
    @click="contextMenu.visible = false">

    <!-- 左侧文件树 -->
    <div class="w-52 flex flex-col overflow-hidden shrink-0"
      style="background:#1e1e2e;">
      <!-- 工具栏 -->
      <div class="flex items-center justify-between px-3 py-2.5
                  border-b border-white/5">
        <span class="text-[10px] font-mono text-white/30 uppercase
                     tracking-widest">文件</span>
        <div class="flex items-center gap-1">
          <button @click="handleNewFileRoot"
            class="p-1.5 rounded hover:bg-white/10 text-white/40
                   hover:text-white/70 transition-colors" title="新建文件">
            <FilePlus class="w-3.5 h-3.5"/>
          </button>
          <button @click="handleNewFolderRoot"
            class="p-1.5 rounded hover:bg-white/10 text-white/40
                   hover:text-white/70 transition-colors" title="新建目录">
            <FolderPlus class="w-3.5 h-3.5"/>
          </button>
          <button @click="refreshTree"
            class="p-1.5 rounded hover:bg-white/10 text-white/40
                   hover:text-white/70 transition-colors" title="刷新">
            <RefreshCw class="w-3.5 h-3.5"/>
          </button>
        </div>
      </div>
      <!-- 新建输入框 -->
      <div v-if="showNewFileInput" class="px-2 py-1.5 border-b border-white/5">
        <input v-model="newFileName" ref="newFileInputEl"
          class="w-full bg-white/10 text-white text-[11px] px-2 py-1
                 rounded outline-none border border-white/20 font-mono"
          placeholder="文件名..."
          @keydown.enter="createFile"
          @keydown.esc="showNewFileInput = false"
          @blur="showNewFileInput = false"/>
      </div>
      <div v-if="showNewFolderInput" class="px-2 py-1.5 border-b border-white/5">
        <input v-model="newFolderName" ref="newFolderInputEl"
          class="w-full bg-white/10 text-white text-[11px] px-2 py-1
                 rounded outline-none border border-white/20 font-mono"
          placeholder="目录名..."
          @keydown.enter="createFolder"
          @keydown.esc="showNewFolderInput = false"
          @blur="showNewFolderInput = false"/>
      </div>
      <!-- 文件树 -->
      <div class="flex-1 overflow-y-auto no-scrollbar py-1">
        <div v-if="!fileTree.length"
          class="text-center text-white/30 text-[11px] font-mono py-8">
          暂无文件
        </div>
        <FileTreeNode
          v-for="node in fileTree" :key="node.path"
          :node="node"
          :current-path="currentFilePath"
          :renaming-path="renamingPath"
          :workspace-id="store.currentWorkspace?.id"
          @open="openFile"
          @toggle="toggleDir"
          @contextmenu="showContextMenu"
          @renamed="handleRenamed"
          @cancel-rename="renamingPath = ''"/>
      </div>
    </div>

    <!-- 中间：编辑器 + 终端 -->
    <div class="flex-1 flex flex-col min-h-0 min-w-0">

      <!-- 编辑器面板 -->
      <div class="flex flex-col min-h-0" :style="`height:${editorHeight}%`">
        <!-- 编辑器工具栏 -->
        <div class="flex items-center justify-between px-4 py-2 shrink-0
                    bg-[#2d2d3e] border-b border-white/5">
          <div class="flex items-center gap-2 flex-1 min-w-0">
            <FileCode class="w-4 h-4 text-white/40 shrink-0"/>
            <span class="text-[12px] text-white/70 font-mono truncate">
              {{ currentFilePath || '未打开文件' }}
            </span>
            <span v-if="isDirty"
              class="w-2 h-2 rounded-full bg-amber-400 shrink-0"/>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <span class="text-[10px] font-mono text-white/30 transition-opacity"
              :class="saveStatus ? 'opacity-100' : 'opacity-0'">
              {{ saveStatus }}
            </span>
            <button @click="saveFile"
              :disabled="!currentFilePath || !isDirty"
              class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg
                     bg-oxygen-blue/20 hover:bg-oxygen-blue/30
                     text-oxygen-blue text-[11px] font-bold transition-colors
                     disabled:opacity-30">
              <Save class="w-3.5 h-3.5"/>
              <span>保存</span>
              <span class="opacity-50 text-[9px]">⌘S</span>
            </button>
          </div>
        </div>
        <!-- Monaco 编辑器 -->
        <div class="flex-1 relative min-h-0">
          <div v-if="!currentFilePath"
            class="absolute inset-0 flex flex-col items-center
                   justify-center opacity-20">
            <FileCode class="w-12 h-12 mb-3 text-white"/>
            <p class="text-sm text-white">点击左侧文件开始编辑</p>
            <p class="text-[10px] font-mono text-white mt-1 opacity-50">
              Ctrl+S 保存
            </p>
          </div>
          <div ref="monacoEl" class="absolute inset-0"/>
        </div>
      </div>

      <!-- Diff 视图覆盖层 -->
      <div v-if="diffVisible"
        class="absolute inset-0 z-50 flex flex-col bg-[#1e1e2e] border border-white/10 rounded-2xl shadow-2xl">
        <!-- Diff 工具栏 -->
        <div class="flex items-center justify-between px-4 py-2 shrink-0
                    border-b border-white/10">
          <div class="flex items-center gap-2">
            <FileCode class="w-4 h-4 text-white/40 shrink-0"/>
            <span class="text-[12px] text-white/70 font-mono truncate">
              {{ diffFilePath }}
            </span>
            <span class="text-[10px] text-oxygen-blue/60 font-mono ml-2">
              修改预览
            </span>
          </div>
          <div class="flex items-center gap-2">
            <button @click="acceptDiff"
              class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg
                     bg-green-500/20 hover:bg-green-500/30
                     text-green-400 text-[11px] font-bold transition-colors">
              <Check class="w-3.5 h-3.5"/>
              <span>接受全部</span>
            </button>
            <button @click="rejectDiff"
              class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg
                     bg-red-500/20 hover:bg-red-500/30
                     text-red-400 text-[11px] font-bold transition-colors">
              <X class="w-3.5 h-3.5"/>
              <span>拒绝</span>
            </button>
          </div>
        </div>
        <!-- Diff 编辑器 -->
        <div ref="diffEl" class="flex-1 min-h-0"/>
      </div>

      <!-- 拖拽分割线 -->
      <div class="h-1 bg-black cursor-row-resize hover:bg-oxygen-blue/30
                  transition-colors shrink-0"
        @mousedown="startResize"/>

      <!-- 终端面板 -->
      <div class="flex flex-col min-h-0"
        :style="`height:${100 - editorHeight}%`"
        style="background:#000;">
        <!-- Tab 栏 -->
        <div class="flex items-center gap-1 px-2 py-1.5 shrink-0
                    border-b border-white/5"
          style="background:#1a1a2e;">
          <button v-for="(term, idx) in terminals" :key="term.id"
            @click="selectTerminal(idx)"
            :class="['flex items-center gap-1.5 px-3 py-1 rounded-lg text-[11px]',
                     'font-mono transition-colors',
                     currentTerminalIdx === idx
                       ? 'bg-white/15 text-white'
                       : 'text-white/40 hover:text-white/70 hover:bg-white/5']">
            <Terminal class="w-3 h-3"/>
            <span>终端 {{ idx + 1 }}</span>
            <button @click.stop="closeTerminal(idx)"
              class="ml-1 hover:text-red-400 transition-colors opacity-60">
              <X class="w-3 h-3"/>
            </button>
          </button>
          <button @click="createTerminal"
            :disabled="terminals.length >= 5"
            class="flex items-center gap-1 px-2.5 py-1 rounded-lg
                   bg-oxygen-blue/20 hover:bg-oxygen-blue/30
                   text-oxygen-blue text-[10px] font-bold transition-colors
                   disabled:opacity-30 ml-1">
            <Plus class="w-3 h-3"/>
            <span>新建</span>
          </button>
          <div class="ml-auto flex items-center gap-1">
            <span class="text-[10px] font-mono text-white/20">
              {{ terminals.length }} / 5
            </span>
          </div>
        </div>
        <!-- xterm 容器 -->
        <div class="flex-1 relative min-h-0">
          <div v-if="!terminals.length"
            class="absolute inset-0 flex flex-col items-center
                   justify-center opacity-20">
            <Terminal class="w-10 h-10 mb-2 text-white"/>
            <p class="text-xs text-white">点击"新建终端"开始</p>
          </div>
          <div v-for="(term, idx) in terminals" :key="term.id"
            :ref="el => { if(el) terminalEls[idx] = el }"
            class="absolute inset-0 p-1"
            :class="currentTerminalIdx === idx ? 'block' : 'hidden'"/>
        </div>
        <!-- 搜索框 -->
        <div v-if="searchVisible"
          class="flex items-center gap-2 px-3 py-2 border-t border-white/10 shrink-0"
          style="background:#252535;">
          <input ref="searchInputEl"
            v-model="searchQuery"
            @input="onSearchInput"
            @keydown="handleSearchInput"
            placeholder="搜索..."
            class="flex-1 bg-white/10 text-white text-[11px] px-3 py-1.5
                   rounded outline-none border border-white/20 font-mono
                   placeholder-white/30 focus:border-oxygen-blue/50"/>
          <button @click="doSearch('prev')"
            class="p-1.5 rounded hover:bg-white/10 text-white/50 hover:text-white/80 transition-colors"
            title="上一个">
            <ChevronUp class="w-3.5 h-3.5"/>
          </button>
          <button @click="doSearch('next')"
            class="p-1.5 rounded hover:bg-white/10 text-white/50 hover:text-white/80 transition-colors"
            title="下一个">
            <ChevronDown class="w-3.5 h-3.5"/>
          </button>
          <button @click="hideSearch"
            class="p-1.5 rounded hover:bg-white/10 text-white/50 hover:text-white/80 transition-colors"
            title="关闭 (Esc)">
            <X class="w-3.5 h-3.5"/>
          </button>
        </div>
        <!-- 底部状态栏 -->
        <div class="flex items-center justify-between px-3 py-1
                    border-t border-white/5 shrink-0"
          style="background:#1a1a2e;">
          <div class="flex items-center gap-3">
            <span class="text-[10px] font-mono text-white/30 truncate max-w-48">
              {{ cwd || '—' }}
            </span>
          </div>
          <button @click="clearTerminal"
            class="flex items-center gap-1 px-2 py-1 rounded
                   bg-white/5 hover:bg-white/10 text-white/40
                   hover:text-white/70 text-[10px] transition-colors">
            <Trash2 class="w-3 h-3"/>
          </button>
        </div>
      </div>
    </div>

    <!-- 右侧 Git 历史面板 -->
    <div class="w-56 flex flex-col overflow-hidden shrink-0"
      style="background:#1e1e2e; border-left: 1px solid rgba(255,255,255,0.05)">

      <!-- 标题栏 -->
      <div class="flex items-center justify-between px-3 py-2.5
                  border-b border-white/5 shrink-0">
        <div class="flex items-center gap-1.5">
          <GitBranch class="w-3.5 h-3.5 text-white/40"/>
          <span class="text-[10px] font-mono text-white/40 uppercase tracking-wider">
            Git 历史
          </span>
        </div>
        <button @click="loadGitHistory"
          class="p-1 rounded hover:bg-white/10 text-white/30
                 hover:text-white/60 transition-colors">
          <RefreshCw class="w-3 h-3"/>
        </button>
      </div>

      <!-- commit 列表 -->
      <div class="flex-1 overflow-y-auto no-scrollbar py-1">
        <div v-if="!gitCommits.length"
          class="text-[10px] font-mono text-white/20 text-center py-6">
          暂无提交记录
        </div>

        <div v-for="(commit, idx) in gitCommits" :key="commit.hash"
          class="group relative px-3 py-2 hover:bg-white/5
                 cursor-pointer transition-colors border-b border-white/3">

          <!-- commit 信息 -->
          <div class="flex items-center gap-2 mb-0.5">
            <span class="text-[9px] font-mono text-oxygen-blue shrink-0">
              {{ commit.hash }}
            </span>
            <span v-if="idx === 0"
              class="text-[8px] font-mono bg-green-500/20 text-green-400
                     px-1 rounded">
              HEAD
            </span>
          </div>
          <p class="text-[10px] font-mono text-white/60 truncate leading-relaxed">
            {{ commit.message.replace('[AI] ', '') }}
          </p>
          <p class="text-[9px] font-mono text-white/20 mt-0.5">
            {{ commit.date }}
          </p>

          <!-- hover 时显示回滚按钮 -->
          <button v-if="idx > 0"
            @click.stop="handleRevert(commit)"
            class="absolute right-2 top-1/2 -translate-y-1/2
                   opacity-0 group-hover:opacity-100 transition-opacity
                   flex items-center gap-1 px-2 py-1 rounded-lg
                   bg-amber-500/20 hover:bg-amber-500/30
                   text-amber-400 text-[9px] font-mono">
            <RotateCcw class="w-3 h-3"/>
            回滚
          </button>
        </div>
      </div>

      <!-- 底部：操作按钮 -->
      <div class="px-3 py-2 border-t border-white/5 shrink-0 space-y-1.5">
        <p class="text-[9px] font-mono text-white/20">
          {{ gitCommits.length ? `${gitCommits.length} 次提交` : '未初始化 Git' }}
        </p>
        <button v-if="!gitCommits.length"
          @click="handleInitGit"
          :disabled="gitLoading"
          class="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg
                 bg-oxygen-blue/20 hover:bg-oxygen-blue/30
                 text-oxygen-blue text-[10px] font-bold transition-colors
                 disabled:opacity-50">
          <GitBranch class="w-3 h-3"/>
          <span>{{ gitLoading ? '初始化中...' : '初始化 Git' }}</span>
        </button>
        <button v-else
          @click="handleSaveProgress"
          :disabled="gitLoading"
          class="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg
                 bg-green-500/20 hover:bg-green-500/30
                 text-green-400 text-[10px] font-bold transition-colors
                 disabled:opacity-50">
          <Save class="w-3 h-3"/>
          <span>{{ gitLoading ? '保存中...' : '保存进度' }}</span>
        </button>
      </div>
    </div>

    <!-- 保存进度模态框 -->
    <Teleport to="body">
      <div v-if="saveProgressModal.visible"
        class="fixed inset-0 z-[100] flex items-center justify-center"
        @click.self="saveProgressModal.visible = false">
        <!-- 背景遮罩 -->
        <div class="absolute inset-0 bg-black/60 backdrop-blur-sm"/>

        <!-- 模态框内容 -->
        <div class="relative w-80 rounded-2xl shadow-2xl overflow-hidden"
          style="background: #2d2d3e; border: 1px solid rgba(255,255,255,0.1)">
          <!-- 标题栏 -->
          <div class="flex items-center justify-between px-5 py-4 border-b border-white/10">
            <div class="flex items-center gap-2">
              <Save class="w-4 h-4 text-green-400"/>
              <span class="text-sm font-medium text-white">保存进度</span>
            </div>
            <button @click="saveProgressModal.visible = false"
              class="p-1 rounded-lg hover:bg-white/10 text-white/40 hover:text-white/70 transition-colors">
              <X class="w-4 h-4"/>
            </button>
          </div>

          <!-- 表单内容 -->
          <div class="px-5 py-4 space-y-4">
            <!-- 标签输入 -->
            <div>
              <label class="block text-[11px] font-medium text-white/60 mb-1.5">
                版本标签 <span class="text-white/30">(可选)</span>
              </label>
              <input v-model="saveProgressModal.tag"
                placeholder="如 v1.0、release、feature"
                class="w-full px-3 py-2 rounded-lg text-[12px] text-white
                       bg-white/5 border border-white/10
                       placeholder-white/30
                       focus:outline-none focus:border-oxygen-blue/50
                       focus:bg-white/10 transition-colors"/>
            </div>

            <!-- 描述输入 -->
            <div>
              <label class="block text-[11px] font-medium text-white/60 mb-1.5">
                提交描述 <span class="text-red-400">*</span>
              </label>
              <textarea v-model="saveProgressModal.message"
                rows="3"
                placeholder="描述本次保存的内容..."
                class="w-full px-3 py-2 rounded-lg text-[12px] text-white
                       bg-white/5 border border-white/10 resize-none
                       placeholder-white/30
                       focus:outline-none focus:border-oxygen-blue/50
                       focus:bg-white/10 transition-colors"/>
            </div>

            <!-- 改动统计 -->
            <div v-if="saveProgressModal.stats"
              class="flex items-center gap-3 text-[10px] text-white/40">
              <span class="flex items-center gap-1">
                <FileCode class="w-3 h-3"/>
                {{ saveProgressModal.stats.files }} 个文件
              </span>
              <span class="flex items-center gap-1">
                <Plus class="w-3 h-3 text-green-400"/>
                {{ saveProgressModal.stats.insertions }} 行
              </span>
              <span class="flex items-center gap-1">
                <Minus class="w-3 h-3 text-red-400"/>
                {{ saveProgressModal.stats.deletions }} 行
              </span>
            </div>
          </div>

          <!-- 底部按钮 -->
          <div class="flex items-center justify-end gap-2 px-5 py-3
                      border-t border-white/10 bg-black/20">
            <button @click="saveProgressModal.visible = false"
              class="px-4 py-1.5 rounded-lg text-[11px] font-medium
                     text-white/60 hover:text-white hover:bg-white/10 transition-colors">
              取消
            </button>
            <button @click="confirmSaveProgress"
              :disabled="!saveProgressModal.message.trim() || saveProgressModal.loading"
              class="flex items-center gap-1.5 px-4 py-1.5 rounded-lg
                     text-[11px] font-bold
                     bg-green-500 hover:bg-green-400
                     text-white transition-colors
                     disabled:opacity-50 disabled:cursor-not-allowed">
              <span v-if="saveProgressModal.loading">保存中...</span>
              <span v-else>保存</span>
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 右键菜单 -->
    <div v-if="contextMenu.visible"
      :style="{ top: contextMenu.y + 'px', left: contextMenu.x + 'px' }"
      class="fixed z-50 bg-[#2d2d3e] rounded-xl shadow-2xl border border-white/10
             py-1.5 min-w-36 text-[12px]"
      @click.stop>
      <button v-if="contextMenu.node?.type === 'directory'"
        @click="handleNewFile(contextMenu.node)"
        class="w-full flex items-center gap-2 px-3 py-2 hover:bg-white/10
               text-white/70 hover:text-white transition-colors">
        <FilePlus class="w-3.5 h-3.5 opacity-40"/> 新建文件
      </button>
      <button v-if="contextMenu.node?.type === 'directory'"
        @click="handleNewFolder(contextMenu.node)"
        class="w-full flex items-center gap-2 px-3 py-2 hover:bg-white/10
               text-white/70 hover:text-white transition-colors">
        <FolderPlus class="w-3.5 h-3.5 opacity-40"/> 新建目录
      </button>
      <button @click="handleRename(contextMenu.node)"
        class="w-full flex items-center gap-2 px-3 py-2 hover:bg-white/10
               text-white/70 hover:text-white transition-colors">
        <Pencil class="w-3.5 h-3.5 opacity-40"/> 重命名
      </button>
      <div class="border-t border-white/10 my-1"/>
      <button @click="handleDelete(contextMenu.node)"
        class="w-full flex items-center gap-2 px-3 py-2
               hover:bg-red-500/20 text-red-400 transition-colors">
        <Trash2 class="w-3.5 h-3.5"/> 删除
      </button>
    </div>

  </div>
</template>

<script setup>
import { ref, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { useAppStore } from '../stores/app'
import { api } from '../api'
import * as monaco from 'monaco-editor'
import { editor as MonacoEditor } from 'monaco-editor'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import '@xterm/xterm/css/xterm.css'
import {
  FilePlus, FolderPlus, RefreshCw, FileCode,
  Save, Terminal, Plus, X, Trash2, Pencil, ChevronUp, ChevronDown, Check,
  GitBranch, RotateCcw, Minus
} from 'lucide-vue-next'
import FileTreeNode from '../components/FileTreeNode.vue'

const store = useAppStore()

// ── 文件树状态 ──
const fileTree = ref([])
const currentFilePath = ref('')
const currentDir = ref('')
const expandedDirs = ref(new Set())
const showNewFileInput = ref(false)
const showNewFolderInput = ref(false)
const newFileName = ref('')
const newFolderName = ref('')
const newFileInputEl = ref(null)
const newFolderInputEl = ref(null)

// ── 编辑器状态 ──
const monacoEl = ref(null)
const isDirty = ref(false)
const saveStatus = ref('')
const editorHeight = ref(60)
let monacoEditor = null

// ── 终端状态 ──
const terminals = ref([])
const terminalEls = ref([])
const currentTerminalIdx = ref(0)
const cwd = ref('')

// ── 搜索状态 ──
const searchVisible = ref(false)
const searchQuery = ref('')
const searchInputEl = ref(null)

// ── Diff 视图状态 ──
const diffVisible = ref(false)
const diffOldContent = ref('')
const diffNewContent = ref('')
const diffFilePath = ref('')
const diffEl = ref(null)

// ── Git 历史状态 ──
const gitCommits = ref([])
const gitLoading = ref(false)
const saveProgressModal = ref({
  visible: false,
  tag: '',
  message: '',
  loading: false,
  stats: null
})

// ── localStorage 工具函数（记录用户主动关闭的终端）──
function getClosedTerminalIds() {
  try {
    const raw = localStorage.getItem('closed_terminal_ids')
    return new Set(raw ? JSON.parse(raw) : [])
  } catch { return new Set() }
}

function saveClosedTerminalIds(ids) {
  try {
    const arr = [...ids].slice(-100) // 只保留最近 100 个
    localStorage.setItem('closed_terminal_ids', JSON.stringify(arr))
  } catch {}
}

function addClosedTerminalId(id) {
  const closedIds = getClosedTerminalIds()
  closedIds.add(id)
  saveClosedTerminalIds(closedIds)
}

// ── 右键菜单状态 ──
const contextMenu = ref({ visible: false, x: 0, y: 0, node: null })
const renamingPath = ref('')

// ── 文件树 ──

async function loadFileTree(path = '.') {
  if (!store.currentWorkspace) return
  const data = await api.get(
    `/api/files?workspaceId=${store.currentWorkspace.id}&path=${encodeURIComponent(path)}`)
  if (path === '.') {
    fileTree.value = buildTree(data?.files || [])
  }
  return data?.files || []
}

function buildTree(files) {
  return files.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    return a.name.localeCompare(b.name)
  }).map(f => ({
    ...f,
    type: f.isDirectory ? 'directory' : 'file',
    children: f.isDirectory ? [] : null
  }))
}

async function toggleDir(node) {
  if (node.type !== 'directory') return
  const path = node.path
  if (expandedDirs.value.has(path)) {
    expandedDirs.value.delete(path)
    node.children = []
    node.expanded = false
  } else {
    expandedDirs.value.add(path)
    const files = await loadFileTree(path)
    node.children = buildTree(files)
    node.expanded = true
  }
}

async function refreshTree() {
  expandedDirs.value.clear()
  await loadFileTree('.')
}

// ── 文件操作 ──

async function openFile(node) {
  if (node.type === 'directory') return
  if (isDirty.value) {
    if (!confirm('有未保存的更改，确认切换文件？')) return
  }
  const data = await api.get(
    `/api/files/content?workspaceId=${store.currentWorkspace.id}`+
    `&path=${encodeURIComponent(node.path)}`)
  if (data) {
    currentFilePath.value = node.path
    const language = data.language || 'plaintext'
    if (monacoEditor) {
      const model = monaco.editor.createModel(data.content || '', language)
      monacoEditor.setModel(model)
      isDirty.value = false
    }
  }
}

async function saveFile() {
  if (!currentFilePath.value || !monacoEditor) return
  const content = monacoEditor.getValue()
  try {
    await api.put('/api/files/content', {
      workspaceId: store.currentWorkspace.id,
      path: currentFilePath.value,
      content,
    })
    isDirty.value = false
    saveStatus.value = '已保存'
    setTimeout(() => saveStatus.value = '', 2000)
  } catch {
    saveStatus.value = '保存失败'
  }
}

function handleNewFileRoot() {
  currentDir.value = '.'
  showNewFileInput.value = true
  nextTick(() => newFileInputEl.value?.focus())
}

function handleNewFolderRoot() {
  currentDir.value = '.'
  showNewFolderInput.value = true
  nextTick(() => newFolderInputEl.value?.focus())
}

function handleNewFile(parentNode) {
  contextMenu.value.visible = false
  currentDir.value = parentNode.path
  showNewFileInput.value = true
  nextTick(() => newFileInputEl.value?.focus())
}

function handleNewFolder(parentNode) {
  contextMenu.value.visible = false
  currentDir.value = parentNode.path
  showNewFolderInput.value = true
  nextTick(() => newFolderInputEl.value?.focus())
}

async function createFile() {
  if (!newFileName.value.trim()) return
  const path = currentDir.value === '.'
    ? newFileName.value
    : `${currentDir.value}/${newFileName.value}`
  try {
    await api.post('/api/files', {
      workspaceId: store.currentWorkspace.id,
      path, content: ''
    })
    newFileName.value = ''
    showNewFileInput.value = false
    await refreshTree()
  } catch (e) {
    console.error('[File] Create error:', e)
  }
}

async function createFolder() {
  if (!newFolderName.value.trim()) return
  const path = currentDir.value === '.'
    ? newFolderName.value
    : `${currentDir.value}/${newFolderName.value}`
  try {
    await api.post('/api/files/dir', {
      workspaceId: store.currentWorkspace.id,
      path
    })
    newFolderName.value = ''
    showNewFolderInput.value = false
    await refreshTree()
  } catch (e) {
    console.error('[Folder] Create error:', e)
  }
}

function handleRename(node) {
  contextMenu.value.visible = false
  renamingPath.value = node.path
}

async function handleRenamed({ oldPath, newPath }) {
  renamingPath.value = ''
  if (currentFilePath.value === oldPath) {
    currentFilePath.value = newPath
  }
  await refreshTree()
}

async function handleDelete(node) {
  contextMenu.value.visible = false
  const msg = node.type === 'directory'
    ? `确认删除目录 "${node.name}" 及其所有内容？`
    : `确认删除文件 "${node.name}"？`
  if (!confirm(msg)) return

  try {
    await api.delete(
      `/api/files?workspaceId=${store.currentWorkspace.id}`+
      `&path=${encodeURIComponent(node.path)}`)
    if (currentFilePath.value === node.path) {
      currentFilePath.value = ''
      monacoEditor?.setValue('')
      isDirty.value = false
    }
    await refreshTree()
  } catch (e) {
    console.error('[Delete] Error:', e)
  }
}

function showContextMenu(e, node) {
  contextMenu.value = { visible: true, x: e.clientX, y: e.clientY, node }
}

// ── Monaco Editor 初始化 ──

function initMonaco() {
  if (!monacoEl.value) return
  monacoEditor = monaco.editor.create(monacoEl.value, {
    value: '',
    language: 'plaintext',
    theme: 'vs-dark',
    fontSize: 13,
    fontFamily: 'JetBrains Mono, monospace',
    lineNumbers: 'on',
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    automaticLayout: true,
    wordWrap: 'on',
    padding: { top: 12 },
  })
  monacoEditor.onDidChangeModelContent(() => {
    isDirty.value = true
  })
  monacoEditor.addCommand(
    monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
    saveFile
  )
}

// ── 终端 ──

async function createTerminal() {
  if (!store.currentWorkspace || terminals.value.length >= 5) return

  try {
    const data = await api.post('/api/terminal', {
      workspaceId: store.currentWorkspace.id
    })
    // 后端返回 { terminal: { id, ... } }
    const terminalId = data?.terminal?.id
    if (!terminalId) {
      console.error('[Terminal] No terminalId returned:', data)
      return
    }

    // 初始化 xterm 实例
    const xterm = new XTerm({
      theme: {
        background: '#000000',
        foreground: '#d4d4d4',
        cursor: '#7091F5',
        selectionBackground: 'rgba(112,145,245,0.3)',
      },
      fontSize: 13,
      fontFamily: '"JetBrains Mono", "Fira Code", monospace',
      cursorBlink: true,
      scrollback: 1000,
    })
    const fitAddon = new FitAddon()
    xterm.loadAddon(fitAddon)

    // 加入列表，触发 DOM 渲染
    const term = {
      id: terminalId,
      xterm,
      fitAddon,
      searchAddon: null,
      ws: null,
    }
    terminals.value.push(term)
    currentTerminalIdx.value = terminals.value.length - 1

    // 等待 DOM 渲染完成（关键！）
    await nextTick()
    await nextTick()

    // 找到对应 DOM 元素
    const el = terminalEls.value[currentTerminalIdx.value]
    if (!el) {
      console.error('[Terminal] DOM 元素未找到，index:', currentTerminalIdx.value, 'els:', terminalEls.value)
      terminals.value.pop()
      return
    }

    // 挂载 xterm
    xterm.open(el)
    await nextTick()
    fitAddon.fit()

    // 加载搜索插件
    const searchAddon = new SearchAddon()
    xterm.loadAddon(searchAddon)
    term.searchAddon = searchAddon

    // 注册 Ctrl+F 搜索快捷键
    xterm.attachCustomKeyEventHandler((e) => {
      if (e.ctrlKey && e.key === 'f') {
        e.preventDefault()
        showSearch()
        return false
      }
      if (e.key === 'Escape' && searchVisible.value) {
        hideSearch()
        return false
      }
      return true
    })

    // 连接 WS（挂载成功后再连）
    connectTerminalWS(term)

  } catch (e) {
    console.error('[Terminal] Create error:', e)
  }
}

function connectTerminalWS(term) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const wsUrl = `${proto}://${location.host}/ws/terminal/${term.id}`
  const ws = new WebSocket(wsUrl)
  term.ws = ws

  ws.onopen = () => {
    console.log('[Terminal] WS connected:', term.id)
    // 输入：纯字符串
    term.xterm.onData(data => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data)
      }
    })
    // 发送初始 resize
    const dims = term.fitAddon.proposeDimensions()
    if (dims) {
      ws.send(JSON.stringify({
        type: 'resize',
        cols: dims.cols,
        rows: dims.rows
      }))
    }
  }

  // 输出：纯字符串
  ws.onmessage = (evt) => {
    term.xterm.write(evt.data)
  }

  ws.onclose = (e) => {
    console.log('[Terminal] WS closed:', term.id, e.code)
    term.xterm.write('\r\n\x1b[33m[连接断开]\x1b[0m\r\n')
    // 不主动 DELETE，让后端 30min 超时自动清理
  }

  ws.onerror = (e) => {
    console.error('[Terminal] WS error:', e)
  }
}

function selectTerminal(idx) {
  currentTerminalIdx.value = idx
  nextTick(() => {
    const term = terminals.value[idx]
    if (term) {
      term.fitAddon.fit()
      term.xterm.focus()
    }
  })
}

async function closeTerminal(idx) {
  const term = terminals.value[idx]
  if (!term) return

  // 记录到 localStorage（兜底：即使后端 DELETE 延迟，刷新后也不恢复）
  addClosedTerminalId(term.id)

  // 用户主动关闭：通知后端销毁 session
  try {
    await api.delete(`/api/terminal/${term.id}`)
    console.log('[Terminal] Deleted session:', term.id)
  } catch (e) {
    console.warn('[Terminal] Delete failed:', e)
  }

  term.ws?.close()
  term.xterm.dispose()
  terminals.value.splice(idx, 1)
  terminalEls.value.splice(idx, 1)
  if (currentTerminalIdx.value >= terminals.value.length) {
    currentTerminalIdx.value = Math.max(0, terminals.value.length - 1)
  }
}

function clearTerminal() {
  const term = terminals.value[currentTerminalIdx.value]
  if (term) term.xterm.clear()
}

async function restoreTerminals() {
  if (!store.currentWorkspace) return
  try {
    const data = await api.get(
      `/api/terminal?workspaceId=${store.currentWorkspace.id}`)

    // 后端返回 { terminals: [...] }，只包含活跃的 session
    const sessions = data?.terminals || []
    if (!Array.isArray(sessions) || !sessions.length) {
      console.log('[Terminal] No active sessions to restore')
      return
    }

    // 获取用户已关闭的终端 ID
    const closedIds = getClosedTerminalIds()

    // 过滤掉：用户主动关闭的 + 非活跃的
    const activeSessions = sessions.filter(s => {
      if (closedIds.has(s.id)) {
        console.log('[Terminal] Skipping closed session:', s.id)
        return false
      }
      return true
    })

    if (!activeSessions.length) {
      console.log('[Terminal] No sessions to restore after filtering')
      return
    }

    console.log('[Terminal] Restoring', activeSessions.length, 'active sessions')

    for (const session of activeSessions.slice(0, 5)) {
      const terminalId = session.id

      // 初始化 xterm
      const xterm = new XTerm({
        theme: {
          background: '#000000',
          foreground: '#d4d4d4',
          cursor: '#7091F5',
          selectionBackground: 'rgba(112,145,245,0.3)',
        },
        fontSize: 13,
        fontFamily: '"JetBrains Mono", "Fira Code", monospace',
        cursorBlink: true,
        scrollback: 1000,
      })
      const fitAddon = new FitAddon()
      xterm.loadAddon(fitAddon)

      const termObj = { id: terminalId, xterm, fitAddon, searchAddon: null, ws: null }
      terminals.value.push(termObj)
    }

    if (terminals.value.length > 0) {
      currentTerminalIdx.value = 0
      await nextTick()
      await nextTick()

      // 挂载并连接所有恢复的终端
      for (let i = 0; i < terminals.value.length; i++) {
        const el = terminalEls.value[i]
        if (el) {
          terminals.value[i].xterm.open(el)
          terminals.value[i].fitAddon.fit()
          // 加载搜索插件
          const searchAddon = new SearchAddon()
          terminals.value[i].xterm.loadAddon(searchAddon)
          terminals.value[i].searchAddon = searchAddon
          // 注册 Ctrl+F 搜索快捷键
          terminals.value[i].xterm.attachCustomKeyEventHandler((e) => {
            if (e.ctrlKey && e.key === 'f') {
              e.preventDefault()
              showSearch()
              return false
            }
            if (e.key === 'Escape' && searchVisible.value) {
              hideSearch()
              return false
            }
            return true
          })
          connectTerminalWS(terminals.value[i])
        } else {
          console.error('[Terminal] DOM element not found for index', i)
        }
      }
      console.log('[Terminal] Restored', terminals.value.length, 'sessions')
    }

    // 清理：只保留后端实际存在的已关闭 ID（避免 localStorage 无限积累）
    try {
      const allIds = new Set(sessions.map(s => s.id))
      const validClosedIds = new Set([...closedIds].filter(id => allIds.has(id)))
      saveClosedTerminalIds(validClosedIds)
    } catch {}

  } catch (e) {
    console.log('[Terminal] Restore failed:', e.message || e)
  }
}

// 清理 terminalEls 防止索引错位
watch(terminals, () => {
  terminalEls.value = terminalEls.value.slice(0, terminals.value.length)
})

function handleWindowResize() {
  const term = terminals.value[currentTerminalIdx.value]
  if (term?.fitAddon) {
    term.fitAddon.fit()
    const dims = term.fitAddon.proposeDimensions()
    if (dims && term.ws?.readyState === WebSocket.OPEN) {
      term.ws.send(JSON.stringify({
        type: 'resize', cols: dims.cols, rows: dims.rows
      }))
    }
  }
}

// ── 终端搜索 ──

function showSearch() {
  searchVisible.value = true
  searchQuery.value = ''
  nextTick(() => {
    searchInputEl.value?.focus()
  })
}

function hideSearch() {
  searchVisible.value = false
  searchQuery.value = ''
  const term = terminals.value[currentTerminalIdx.value]
  if (term?.searchAddon) {
    term.searchAddon.clearDecorations()
  }
}

function doSearch(direction) {
  const term = terminals.value[currentTerminalIdx.value]
  if (!term?.searchAddon || !searchQuery.value) return
  const found = term.searchAddon.findNext(searchQuery.value, { direction })
  if (!found) {
    term.xterm.clearSelection()
  }
}

function handleSearchInput(e) {
  if (e.key === 'Enter') {
    doSearch('next')
  } else if (e.key === 'Escape') {
    hideSearch()
  }
}

function onSearchInput() {
  const term = terminals.value[currentTerminalIdx.value]
  if (!term?.searchAddon || !searchQuery.value) return
  term.searchAddon.findNext(searchQuery.value, { direction: 'next' })
}

// ── 拖拽分割线 ──

function startResize(e) {
  const startY = e.clientY
  const startH = editorHeight.value
  const container = e.target.closest('.flex-col')
  const totalH = container?.offsetHeight || window.innerHeight

  function onMove(e) {
    const dy = e.clientY - startY
    const newH = startH + (dy / totalH) * 100
    editorHeight.value = Math.min(80, Math.max(20, newH))
  }
  function onUp() {
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
    handleWindowResize()
  }
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}

// ── Monaco Diff 视图 ──

function showDiff(oldContent, newContent, filePath) {
  diffOldContent.value = oldContent
  diffNewContent.value = newContent
  diffFilePath.value = filePath
  diffVisible.value = true
  nextTick(() => {
    if (diffEl.value) {
      const origLang = getLanguageFromPath(filePath)
      diffEditor = MonacoEditor.createDiffEditor(diffEl.value, {
        theme: 'vs-dark',
        fontSize: 13,
        fontFamily: 'JetBrains Mono, monospace',
        readOnly: true,
        renderSideBySide: true,
        automaticLayout: true,
      })
      const originalModel = MonacoEditor.createModel(oldContent, origLang)
      const modifiedModel = MonacoEditor.createModel(newContent, origLang)
      diffEditor.setModel({
        original: originalModel,
        modified: modifiedModel,
      })
    }
  })
}

function hideDiff() {
  diffVisible.value = false
  if (diffEditor) {
    diffEditor.dispose()
    diffEditor = null
  }
}

async function acceptDiff() {
  if (!diffFilePath.value || !diffNewContent.value) return
  try {
    await api.put('/api/files/content', {
      workspaceId: store.currentWorkspace.id,
      path: diffFilePath.value,
      content: diffNewContent.value,
    })
    hideDiff()
    // 重新加载文件树
    await refreshTree()
    // 如果当前打开的是同一个文件，刷新内容
    if (currentFilePath.value === diffFilePath.value && monacoEditor) {
      const data = await api.get(
        `/api/files/content?workspaceId=${store.currentWorkspace.id}`+
        `&path=${encodeURIComponent(diffFilePath.value)}`)
      if (data?.content !== undefined) {
        monacoEditor.setValue(data.content)
        isDirty.value = false
      }
    }
  } catch (e) {
    console.error('[Diff] Accept failed:', e)
  }
}

function rejectDiff() {
  hideDiff()
}

function getLanguageFromPath(path) {
  const ext = path.split('.').pop()?.toLowerCase()
  const langMap = {
    'js': 'javascript', 'jsx': 'javascript',
    'ts': 'typescript', 'tsx': 'typescript',
    'py': 'python', 'go': 'go', 'rs': 'rust',
    'java': 'java', 'c': 'c', 'cpp': 'cpp', 'h': 'cpp',
    'css': 'css', 'scss': 'scss', 'less': 'less',
    'html': 'html', 'xml': 'xml', 'json': 'json',
    'yaml': 'yaml', 'yml': 'yaml', 'md': 'markdown',
    'sql': 'sql', 'sh': 'shell', 'bash': 'shell',
  }
  return langMap[ext] || 'plaintext'
}

// ── Git 历史 ──

async function loadGitHistory() {
  if (!store.currentWorkspace) return
  try {
    const data = await api.get(
      `/api/workspaces/${store.currentWorkspace.id}/git`)
    if (data?.commits) gitCommits.value = data.commits
  } catch (e) {
    console.error('[Git] Load history failed:', e)
  }
}

// 初始化 Git 仓库
async function handleInitGit() {
  if (!store.currentWorkspace) return
  if (!confirm('初始化 Git 仓库？\n\n将在当前工作区创建 .git 目录。')) return

  gitLoading.value = true
  try {
    const result = await api.post(
      `/api/workspaces/${store.currentWorkspace.id}/git/init`
    )
    if (result.success) {
      await loadGitHistory()
      alert('Git 仓库初始化成功！')
    } else {
      alert('初始化失败：' + (result.message || '未知错误'))
    }
  } catch (e) {
    console.error('[Git] Init failed:', e)
    alert('初始化失败')
  } finally {
    gitLoading.value = false
  }
}

// 保存进度（打开模态框）
async function handleSaveProgress() {
  if (!store.currentWorkspace) return

  // 重置模态框状态
  saveProgressModal.value = {
    visible: true,
    tag: '',
    message: '',
    loading: false,
    stats: null
  }

  // 获取改动统计
  try {
    const result = await api.get(
      `/api/workspaces/${store.currentWorkspace.id}/git/status`
    )
    if (result?.stats) {
      saveProgressModal.value.stats = result.stats
    }
  } catch (e) {
    console.error('[Git] Get status failed:', e)
  }
}

// 确认保存进度
async function confirmSaveProgress() {
  if (!store.currentWorkspace) return
  const { tag, message } = saveProgressModal.value
  if (!message.trim()) return

  saveProgressModal.value.loading = true
  try {
    const result = await api.post(
      `/api/workspaces/${store.currentWorkspace.id}/git/save`,
      { tag, message }
    )
    if (result.success) {
      saveProgressModal.value.visible = false
      await loadGitHistory()
      // 可选：显示成功提示
    } else {
      alert('保存失败：' + (result.message || '未知错误'))
    }
  } catch (e) {
    console.error('[Git] Save failed:', e)
    alert('保存失败')
  } finally {
    saveProgressModal.value.loading = false
  }
}

async function handleRevert(commit) {
  // 显示确认信息
  const diffInfo = commit.filesChanged > 0
    ? `\n\n将影响约 ${commit.filesChanged} 个文件` : ''
  if (!confirm(
    `回滚到：${commit.hash}\n${commit.message}\n\n` +
    `⚠️ 此后的所有改动将丢失${diffInfo}\n\n确认回滚？`
  )) return

  try {
    const result = await api.post(
      `/api/workspaces/${store.currentWorkspace.id}/git/revert`,
      { hash: commit.hash }
    )

    if (result.success) {
      // 刷新文件树和 git 历史
      await refreshTree()
      await loadGitHistory()
      // 如果有打开的文件，提示重新加载
      if (currentFilePath.value) {
        const reloadMsg = '文件已被回滚，是否重新加载编辑器？'
        if (confirm(reloadMsg)) {
          await openFile({ path: currentFilePath.value, type: 'file' })
        }
      }
    } else {
      alert('回滚失败：' + result.message)
    }
  } catch (e) {
    console.error('[Git] Revert failed:', e)
    alert('回滚失败：' + (e.message || '未知错误'))
  }
}

// 监听来自 AI 的文件修改事件（通过 WebSocket）
// 可通过 window.showFileDiff = showDiff 暴露给外部调用

// ── 生命周期 ──

onMounted(async () => {
  window.addEventListener('resize', handleWindowResize)
  await nextTick()
  initMonaco()
  if (store.currentWorkspace) {
    await loadFileTree()
    await restoreTerminals()
    await loadGitHistory()
  }
})

watch(() => store.currentWorkspace, async (ws) => {
  if (ws) {
    await loadFileTree()
    await loadGitHistory()
  }
}, { immediate: false })

onUnmounted(() => {
  window.removeEventListener('resize', handleWindowResize)
  monacoEditor?.dispose()
  terminals.value.forEach(t => {
    t.ws?.close()
    t.xterm.dispose()
  })
})
</script>