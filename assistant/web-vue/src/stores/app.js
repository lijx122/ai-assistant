import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export const useAppStore = defineStore('app', () => {
  const token = ref(localStorage.getItem('assistant_token') || '')
  const currentWorkspace = ref(null)
  const currentSession = ref(null)
  const workspaces = ref([])
  const sessions = ref([])
  const messages = ref([])
  const isStreaming = ref(false)

  const isLoggedIn = computed(() => !!token.value)

  function setToken(t) {
    token.value = t
    if (t) localStorage.setItem('assistant_token', t)
    else localStorage.removeItem('assistant_token')
  }

  function setWorkspace(ws) { currentWorkspace.value = ws }
  function setWorkspaces(list) { workspaces.value = list }
  function setSession(s) { currentSession.value = s }
  function setSessions(list) { sessions.value = list }
  function setMessages(list) { messages.value = list }
  function addMessage(msg) { messages.value.push(msg) }
  function updateLastMessage(delta) {
    const last = messages.value[messages.value.length - 1]
    if (last && last.role === 'assistant') {
      last.content = (last.content || '') + delta
    }
  }

  return {
    token, currentWorkspace, currentSession,
    workspaces, sessions, messages, isStreaming,
    isLoggedIn,
    setToken, setWorkspace, setWorkspaces,
    setSession, setSessions, setMessages,
    addMessage, updateLastMessage
  }
})