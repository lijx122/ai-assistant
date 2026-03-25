<template>
  <div>
    <div
      :style="{ paddingLeft: depth * 12 + 8 + 'px' }"
      :class="['flex items-center gap-1.5 py-0.5 px-2 cursor-pointer',
               'text-[12px] font-mono transition-colors select-none',
               isActive
                 ? 'bg-white/15 text-white'
                 : 'text-white/60 hover:bg-white/8 hover:text-white/90']"
      @click="handleClick"
      @contextmenu.prevent="$emit('contextmenu', $event, node)">
      <!-- 目录箭头 -->
      <ChevronRight v-if="node.type === 'directory'"
        class="w-3 h-3 shrink-0 transition-transform"
        :class="node.expanded ? 'rotate-90' : ''"/>
      <span v-else class="w-3 shrink-0"/>
      <!-- 图标 -->
      <Folder v-if="node.type === 'directory'"
        class="w-3.5 h-3.5 shrink-0 text-amber-400"/>
      <FileCode v-else class="w-3.5 h-3.5 shrink-0"
        :class="fileIconColor(node.name)"/>
      <!-- 名称 / 重命名输入框 -->
      <input v-if="isRenaming"
        v-model="renameValue"
        ref="renameInputEl"
        class="flex-1 bg-white/20 text-white text-[12px] px-1.5 rounded
               outline-none border border-oxygen-blue/60 w-full font-mono"
        @keydown.enter.stop="doRename"
        @keydown.esc.stop="cancelRename"
        @blur="doRename"
        @click.stop/>
      <span v-else class="truncate">{{ node.name }}</span>
    </div>
    <!-- 子节点 -->
    <div v-if="node.expanded && node.children?.length">
      <FileTreeNode
        v-for="child in node.children" :key="child.path"
        :node="child"
        :depth="depth + 1"
        :current-path="currentPath"
        :renaming-path="renamingPath"
        :workspace-id="workspaceId"
        @open="$emit('open', $event)"
        @toggle="$emit('toggle', $event)"
        @contextmenu="$emit('contextmenu', $event, $arguments[1])"
        @renamed="$emit('renamed', $event)"
        @cancel-rename="$emit('cancelRename')"/>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick } from 'vue'
import { ChevronRight, Folder, FileCode } from 'lucide-vue-next'
import { api } from '../api'

const props = defineProps({
  node: Object,
  depth: { type: Number, default: 0 },
  currentPath: String,
  renamingPath: String,
  workspaceId: String,
})
const emit = defineEmits(['open', 'toggle', 'contextmenu', 'renamed', 'cancelRename'])

const renameValue = ref('')
const renameInputEl = ref(null)

const isActive = computed(() =>
  props.node.type === 'file' && props.currentPath === props.node.path)

const isRenaming = computed(() =>
  props.renamingPath === props.node.path)

watch(isRenaming, (val) => {
  if (val) {
    renameValue.value = props.node.name
    nextTick(() => {
      renameInputEl.value?.focus()
      renameInputEl.value?.select()
    })
  }
})

function handleClick() {
  if (props.node.type === 'directory') {
    emit('toggle', props.node)
  } else {
    emit('open', props.node)
  }
}

async function doRename() {
  const newName = renameValue.value.trim()
  if (!newName || newName === props.node.name) {
    cancelRename()
    return
  }

  // 构建新路径
  const pathParts = props.node.path.split('/')
  pathParts[pathParts.length - 1] = newName
  const newPath = pathParts.join('/')

  try {
    await api.patch('/api/files/rename', {
      workspaceId: props.workspaceId,
      oldPath: props.node.path,
      newPath,
    })
    emit('renamed', { oldPath: props.node.path, newPath, newName })
  } catch (e) {
    console.error('[Rename] failed:', e)
    // 失败时也通知父组件清除 renamingPath
    emit('cancelRename')
  }
}

function cancelRename() {
  renameValue.value = props.node.name
  emit('cancelRename')
}

function fileIconColor(name) {
  const ext = name.split('.').pop()?.toLowerCase()
  const map = {
    js: 'text-yellow-400', ts: 'text-blue-400', vue: 'text-green-400',
    py: 'text-blue-300', json: 'text-amber-300', md: 'text-white/60',
    css: 'text-purple-400', html: 'text-orange-400', sh: 'text-green-300',
  }
  return map[ext] || 'text-white/40'
}
</script>