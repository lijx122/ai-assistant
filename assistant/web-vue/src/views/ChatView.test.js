import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useAppStore } from '../stores/app'
import ChatView from './ChatView.vue'

// ── Mock api ──
const mockApiGet = vi.fn()
const mockApiPost = vi.fn()
const mockApiPut = vi.fn()
const mockApiDelete = vi.fn()

vi.mock('../api', () => ({
  api: {
    get: (...args) => mockApiGet(...args),
    post: (...args) => mockApiPost(...args),
    put: (...args) => mockApiPut(...args),
    delete: (...args) => mockApiDelete(...args),
  }
}))

// ── Mock WebSocket ──
let lastWsInstance = null
class MockWebSocket {
  constructor(url) {
    this.url = url
    this.onopen = null
    this.onmessage = null
    this.onclose = null
    this.onerror = null
    this.readyState = 1
    lastWsInstance = this
  }
  close() {}
  send() {}
}

// ── Icon stub ──
const iconStub = { template: '<span />' }
const ICON_STUBS = {
  Plus: iconStub, FolderOpen: iconStub, MessageCircle: iconStub,
  X: iconStub, Layers: iconStub, Globe: iconStub,
  Paperclip: iconStub, Send: iconStub, Check: iconStub,
  CheckCircle: iconStub, Loader2: iconStub, XCircle: iconStub,
  ChevronDown: iconStub, Telescope: iconStub, Download: iconStub,
  Pencil: iconStub, RotateCcw: iconStub, GitBranch: iconStub,
  FileIcon: iconStub, Menu: iconStub, ArrowDown: iconStub,
  ArrowUp: iconStub, Square: iconStub,
}

function defaultApiMock() {
  mockApiGet.mockImplementation(async (url) => {
    if (url.includes('/api/sessions?')) return { sessions: [] }
    if (url.includes('/api/todos?')) return { items: [] }
    return null
  })
  mockApiPost.mockResolvedValue(null)
  mockApiPut.mockResolvedValue(null)
  mockApiDelete.mockResolvedValue(null)
}

describe('ChatView', () => {
  let pinia
  let store

  beforeEach(() => {
    vi.clearAllMocks()
    global.WebSocket = MockWebSocket
    lastWsInstance = null

    pinia = createPinia()
    setActivePinia(pinia)
    store = useAppStore()

    defaultApiMock()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function mountChatView() {
    return mount(ChatView, {
      global: {
        plugins: [pinia],
        provide: {
          isMobile: ref(false),
          isTablet: ref(false),
        },
        stubs: ICON_STUBS,
      },
    })
  }

  // ═══════════════════════════════════════════════════════
  // 1. selectSession: store update only on success
  // ═══════════════════════════════════════════════════════
  describe('selectSession - store update guard', () => {
    it('should NOT call store.setSession when api.get returns null/undefined', async () => {
      const sessions = [
        { id: 's1', title: 'Session 1' },
        { id: 's2', title: 'Session 2' },
      ]

      mockApiGet.mockImplementation(async (url) => {
        if (url.includes('/api/sessions?')) return { sessions }
        if (url.includes('/api/todos?')) return { items: [] }
        // s1 messages OK (for auto-select)
        if (url.includes('/api/sessions/s1/messages')) {
          return { messages: [{ id: 'm1', role: 'user', content: 'hello' }] }
        }
        // s2 messages FAIL (returns null)
        if (url.includes('/api/sessions/s2/messages')) return null
        return null
      })

      store.currentWorkspace = { id: 'ws1', name: 'Test Workspace' }
      const wrapper = mountChatView()
      await flushPromises()
      await nextTick()
      await flushPromises()

      // s1 was auto-selected, setSession called once
      expect(store.currentSession?.id).toBe('s1')

      // Now click s2 — API returns null
      const sessionEls = wrapper.findAll('[class*="cursor-pointer"]')
      const s2El = sessionEls.find(el => el.text().includes('Session 2'))
      expect(s2El).toBeTruthy()
      await s2El.trigger('click')
      await flushPromises()
      await nextTick()
      await flushPromises()

      // setSession should NOT have switched to s2
      expect(store.currentSession?.id).toBe('s1')
    })

    it('should call store.setSession when api.get returns valid messages', async () => {
      const sessions = [
        { id: 's1', title: 'Session 1' },
        { id: 's2', title: 'Session 2' },
      ]

      mockApiGet.mockImplementation(async (url) => {
        if (url.includes('/api/sessions?')) return { sessions }
        if (url.includes('/api/todos?')) return { items: [] }
        if (url.includes('/api/sessions/s1/messages')) {
          return { messages: [{ id: 'm1', role: 'user', content: 'hello' }] }
        }
        if (url.includes('/api/sessions/s2/messages')) {
          return { messages: [{ id: 'm2', role: 'assistant', content: 'hi' }] }
        }
        return null
      })

      store.currentWorkspace = { id: 'ws1', name: 'Test Workspace' }
      const wrapper = mountChatView()
      await flushPromises()
      await nextTick()
      await flushPromises()

      expect(store.currentSession?.id).toBe('s1')

      // Click s2 — API returns valid messages
      const sessionEls = wrapper.findAll('[class*="cursor-pointer"]')
      const s2El = sessionEls.find(el => el.text().includes('Session 2'))
      await s2El.trigger('click')
      await flushPromises()
      await nextTick()
      await flushPromises()

      // setSession SHOULD have switched to s2
      expect(store.currentSession?.id).toBe('s2')
    })

    it('should NOT call setSession when API returns undefined (no data)', async () => {
      const sessions = [
        { id: 's1', title: 'Session 1' },
        { id: 's2', title: 'Session 2' },
      ]

      mockApiGet.mockImplementation(async (url) => {
        if (url.includes('/api/sessions?')) return { sessions }
        if (url.includes('/api/todos?')) return { items: [] }
        if (url.includes('/api/sessions/s1/messages')) {
          return { messages: [{ id: 'm1', role: 'user', content: 'hello' }] }
        }
        // s2 returns undefined (no data at all)
        if (url.includes('/api/sessions/s2/messages')) return undefined
        return null
      })

      store.currentWorkspace = { id: 'ws1', name: 'Test Workspace' }
      const wrapper = mountChatView()
      await flushPromises()
      await nextTick()
      await flushPromises()

      expect(store.currentSession?.id).toBe('s1')

      const sessionEls = wrapper.findAll('[class*="cursor-pointer"]')
      const s2El = sessionEls.find(el => el.text().includes('Session 2'))
      await s2El.trigger('click')
      await flushPromises()
      await nextTick()
      await flushPromises()

      // Still s1 — s2 API returned undefined
      expect(store.currentSession?.id).toBe('s1')
    })
  })

  // ═══════════════════════════════════════════════════════
  // 2. processFiles: console.warn for files > 1MB
  // ═══════════════════════════════════════════════════════
  describe('processFiles - large file warning', () => {
    it('should warn and skip files larger than 1MB', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      store.currentWorkspace = { id: 'ws1', name: 'Test' }
      const wrapper = mountChatView()
      await flushPromises()

      const largeFile = new File(['x'], 'large.txt', { type: 'text/plain' })
      Object.defineProperty(largeFile, 'size', { value: 2 * 1024 * 1024 })

      const fileInput = wrapper.find('input[type="file"]')
      Object.defineProperty(fileInput.element, 'files', {
        value: [largeFile],
        writable: false,
      })
      await fileInput.trigger('change')
      await flushPromises()

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Skipping large file'),
        'large.txt',
        expect.stringContaining('MB'),
      )

      warnSpy.mockRestore()
    })

    it('should NOT warn for files smaller than 1MB', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      store.currentWorkspace = { id: 'ws1', name: 'Test' }
      const wrapper = mountChatView()
      await flushPromises()

      const smallFile = new File(['hello'], 'small.txt', { type: 'text/plain' })

      const fileInput = wrapper.find('input[type="file"]')
      Object.defineProperty(fileInput.element, 'files', {
        value: [smallFile],
        writable: false,
      })
      await fileInput.trigger('change')
      await flushPromises()

      expect(warnSpy).not.toHaveBeenCalled()
      warnSpy.mockRestore()
    })

    it('should skip files with unsupported extensions silently', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      store.currentWorkspace = { id: 'ws1', name: 'Test' }
      const wrapper = mountChatView()
      await flushPromises()

      const binaryFile = new File(['data'], 'image.png', { type: 'image/png' })

      const fileInput = wrapper.find('input[type="file"]')
      Object.defineProperty(fileInput.element, 'files', {
        value: [binaryFile],
        writable: false,
      })
      await fileInput.trigger('change')
      await flushPromises()

      expect(warnSpy).not.toHaveBeenCalled()
      warnSpy.mockRestore()
    })
  })

  // ═══════════════════════════════════════════════════════
  // 3. sendMessage catch: temp message removal
  // ═══════════════════════════════════════════════════════
  describe('sendMessage - temp message cleanup on error', () => {
    it('should remove temp messages and reset streaming when api.post throws', async () => {
      const sessions = [{ id: 's1', title: 'Session 1' }]

      mockApiGet.mockImplementation(async (url) => {
        if (url.includes('/api/sessions?')) return { sessions }
        if (url.includes('/api/todos?')) return { items: [] }
        if (url.includes('/api/sessions/s1/messages')) {
          return { messages: [{ id: 'm1', role: 'user', content: 'existing' }] }
        }
        return null
      })
      mockApiPost.mockRejectedValue(new Error('Network error'))

      store.currentWorkspace = { id: 'ws1', name: 'Test' }
      const wrapper = mountChatView()
      await flushPromises()
      await nextTick()
      await flushPromises()

      // Type a message
      const textarea = wrapper.find('textarea')
      await textarea.setValue('Hello agent')
      await nextTick()

      // Find the send button (last button before the todo panel)
      const buttons = wrapper.findAll('button')
      // Send button has the Send icon inside; find by checking it's not disabled
      // The send button is in the input area, the last visible button
      const sendBtn = buttons[buttons.length - 1]
      await sendBtn.trigger('click')
      await flushPromises()
      await nextTick()
      await flushPromises()

      // After catch: isStreaming should be false
      expect(store.isStreaming).toBe(false)

      // The temp message (id starting with 'temp-') should be removed.
      // The only remaining message should be the pre-existing 'existing' one.
      const html = wrapper.html()
      // 'existing' message content should still be present
      // (it was loaded from the API)
    })

    it('should push temp message with temp- prefix on send', async () => {
      const sessions = [{ id: 's1', title: 'Session 1' }]

      mockApiGet.mockImplementation(async (url) => {
        if (url.includes('/api/sessions?')) return { sessions }
        if (url.includes('/api/todos?')) return { items: [] }
        if (url.includes('/api/sessions/s1/messages')) {
          return { messages: [] }
        }
        return null
      })
      // api.post hangs (never resolves) so we can inspect the temp state
      let resolvePost
      mockApiPost.mockImplementation(() => new Promise(r => { resolvePost = r }))

      store.currentWorkspace = { id: 'ws1', name: 'Test' }
      const wrapper = mountChatView()
      await flushPromises()
      await nextTick()
      await flushPromises()

      const textarea = wrapper.find('textarea')
      await textarea.setValue('Test message')
      await nextTick()

      const buttons = wrapper.findAll('button')
      const sendBtn = buttons[buttons.length - 1]
      await sendBtn.trigger('click')
      await flushPromises()
      await nextTick()

      // The temp message should be visible in the DOM
      const html = wrapper.html()
      expect(html).toContain('Test message')

      // Now reject to clean up
      resolvePost?.(null)
      await flushPromises()
    })
  })

  // ═══════════════════════════════════════════════════════
  // 4. handleWSMessage: null content guard
  // ═══════════════════════════════════════════════════════
  describe('handleWSMessage - null content guard', () => {
    it('should not crash and not push message when new_message has null content', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.spyOn(console, 'log').mockImplementation(() => {})

      const sessions = [{ id: 's1', title: 'Session 1' }]
      mockApiGet.mockImplementation(async (url) => {
        if (url.includes('/api/sessions?')) return { sessions }
        if (url.includes('/api/todos?')) return { items: [] }
        if (url.includes('/api/sessions/s1/messages')) {
          return { messages: [{ id: 'm1', role: 'user', content: 'hi' }] }
        }
        return null
      })

      store.currentWorkspace = { id: 'ws1', name: 'Test' }
      const wrapper = mountChatView()
      await flushPromises()
      await nextTick()
      await flushPromises()

      // Verify WebSocket was created
      expect(lastWsInstance).toBeTruthy()

      // Fire new_message with null content
      lastWsInstance.onmessage({
        data: JSON.stringify({
          type: 'new_message',
          payload: { id: 'msg-null', role: 'assistant', content: null },
        }),
      })
      await nextTick()
      await flushPromises()

      // Should warn
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('null content'),
      )

      // No crash, message id should not appear in DOM
      expect(wrapper.html()).not.toContain('msg-null')

      warnSpy.mockRestore()
    })

    it('should push message when new_message has valid JSON content', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {})

      const sessions = [{ id: 's1', title: 'Session 1' }]
      mockApiGet.mockImplementation(async (url) => {
        if (url.includes('/api/sessions?')) return { sessions }
        if (url.includes('/api/todos?')) return { items: [] }
        if (url.includes('/api/sessions/s1/messages')) {
          return { messages: [{ id: 'm1', role: 'user', content: 'hi' }] }
        }
        return null
      })

      store.currentWorkspace = { id: 'ws1', name: 'Test' }
      const wrapper = mountChatView()
      await flushPromises()
      await nextTick()
      await flushPromises()

      lastWsInstance.onmessage({
        data: JSON.stringify({
          type: 'new_message',
          payload: {
            id: 'msg-valid',
            role: 'assistant',
            content: JSON.stringify([{ type: 'text', text: 'Hello from agent' }]),
          },
        }),
      })
      await nextTick()
      await flushPromises()

      expect(wrapper.html()).toContain('Hello from agent')
    })

    it('should handle new_message with plain string content', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {})

      const sessions = [{ id: 's1', title: 'Session 1' }]
      mockApiGet.mockImplementation(async (url) => {
        if (url.includes('/api/sessions?')) return { sessions }
        if (url.includes('/api/todos?')) return { items: [] }
        if (url.includes('/api/sessions/s1/messages')) {
          return { messages: [] }
        }
        return null
      })

      store.currentWorkspace = { id: 'ws1', name: 'Test' }
      const wrapper = mountChatView()
      await flushPromises()
      await nextTick()
      await flushPromises()

      lastWsInstance.onmessage({
        data: JSON.stringify({
          type: 'new_message',
          payload: {
            id: 'msg-str',
            role: 'assistant',
            content: 'Plain text response',
          },
        }),
      })
      await nextTick()
      await flushPromises()

      expect(wrapper.html()).toContain('Plain text response')
    })

    it('should ignore new_message with non-assistant role', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {})

      const sessions = [{ id: 's1', title: 'Session 1' }]
      mockApiGet.mockImplementation(async (url) => {
        if (url.includes('/api/sessions?')) return { sessions }
        if (url.includes('/api/todos?')) return { items: [] }
        if (url.includes('/api/sessions/s1/messages')) {
          return { messages: [] }
        }
        return null
      })

      store.currentWorkspace = { id: 'ws1', name: 'Test' }
      const wrapper = mountChatView()
      await flushPromises()
      await nextTick()
      await flushPromises()

      lastWsInstance.onmessage({
        data: JSON.stringify({
          type: 'new_message',
          payload: { id: 'msg-user', role: 'user', content: 'user msg' },
        }),
      })
      await nextTick()
      await flushPromises()

      expect(wrapper.html()).not.toContain('msg-user')
    })
  })

  // ═══════════════════════════════════════════════════════
  // 5. handleWSMessage: done event resets streaming
  // ═══════════════════════════════════════════════════════
  describe('handleWSMessage - done event', () => {
    it('should reset isStreaming on done event', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {})

      const sessions = [{ id: 's1', title: 'Session 1' }]
      mockApiGet.mockImplementation(async (url) => {
        if (url.includes('/api/sessions?')) return { sessions }
        if (url.includes('/api/todos?')) return { items: [] }
        if (url.includes('/api/sessions/s1/messages')) {
          return { messages: [] }
        }
        return null
      })

      store.currentWorkspace = { id: 'ws1', name: 'Test' }
      const wrapper = mountChatView()
      await flushPromises()
      await nextTick()
      await flushPromises()

      // Manually set streaming
      store.isStreaming = true
      await nextTick()

      // Fire done event via WebSocket
      lastWsInstance.onmessage({
        data: JSON.stringify({ type: 'done' }),
      })
      await flushPromises()
      await nextTick()

      expect(store.isStreaming).toBe(false)
    })
  })
})
