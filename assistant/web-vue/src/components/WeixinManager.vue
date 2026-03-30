<template>
  <div class="tactile-container p-6">
    <div class="flex items-center justify-between mb-5">
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 bg-green-100 rounded-2xl flex items-center justify-center">
          <MessageCircle class="w-5 h-5 text-green-600"/>
        </div>
        <div>
          <p class="font-bold">微信渠道</p>
          <p class="text-[10px] font-mono opacity-40">iLink Bot API</p>
        </div>
      </div>
      <button @click="startLogin"
        :disabled="isLoggingIn"
        class="flex items-center gap-2 px-4 py-2 rounded-2xl bg-green-500 text-white text-sm font-bold hover:opacity-80 disabled:opacity-40">
        <Plus class="w-4 h-4"/>
        {{ isLoggingIn ? '扫码中...' : '添加微信号' }}
      </button>
    </div>

    <!-- 已登录账号列表 -->
    <div class="space-y-3 mb-5">
      <div v-if="!accounts.length"
        class="text-center opacity-30 py-6 text-sm">
        暂无已连接的微信账号
      </div>
      <div v-for="account in accounts" :key="account.id"
        class="flex items-center justify-between p-4 rounded-2xl bg-slate-50">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-full bg-green-100 flex items-center justify-center">
            <MessageCircle class="w-5 h-5 text-green-600"/>
          </div>
          <div>
            <p class="text-sm font-medium">
              {{ account.name || account.id.slice(-8) }}
            </p>
            <div class="flex items-center gap-1.5 mt-0.5">
              <span :class="['w-1.5 h-1.5 rounded-full',
                             account.status === 'active'
                               ? 'bg-green-500' : 'bg-red-400']"/>
              <span class="text-[10px] font-mono opacity-40">
                {{ account.status === 'active' ? '已连接' : '已断开' }}
              </span>
              <span class="text-[10px] font-mono opacity-30">
                · 最后活跃 {{ formatTime(account.last_used_at) }}
              </span>
            </div>
          </div>
        </div>
        <button @click="disconnect(account.id)"
          class="p-2 rounded-xl hover:bg-red-50 text-red-400 transition-colors">
          <Unlink class="w-4 h-4"/>
        </button>
      </div>
    </div>

    <!-- 二维码弹窗 -->
    <div v-if="showQrcode"
      class="fixed inset-0 bg-black/20 backdrop-blur-sm z-50 flex items-center justify-center"
      @click.self="showQrcode = false">
      <div class="tactile-container p-8 flex flex-col items-center gap-5 max-w-xs">
        <div class="flex items-center gap-3 w-full">
          <div class="w-10 h-10 bg-green-100 rounded-2xl flex items-center justify-center">
            <QrCode class="w-5 h-5 text-green-600"/>
          </div>
          <div>
            <p class="font-bold">扫码登录微信</p>
            <p class="text-[10px] font-mono opacity-40">使用微信扫描下方二维码</p>
          </div>
        </div>

        <!-- 二维码图片 -->
        <div class="relative">
          <img v-if="qrcodeImg"
            :src="qrcodeImg.startsWith('data:') ? qrcodeImg : `data:image/png;base64,${qrcodeImg}`"
            class="w-48 h-48 rounded-2xl"
            alt="微信登录二维码"/>
          <img v-else-if="qrcodeUrl"
            :src="qrcodeUrl"
            class="w-48 h-48 rounded-2xl"
            alt="微信登录二维码"/>
          <div v-if="loginStatus === 'confirmed'"
            class="absolute inset-0 bg-green-500/90 rounded-2xl flex items-center justify-center">
            <div class="text-white text-center">
              <CheckCircle class="w-10 h-10 mx-auto mb-2"/>
              <p class="font-bold">登录成功</p>
            </div>
          </div>
          <div v-if="loginStatus === 'expired'"
            class="absolute inset-0 bg-slate-900/80 rounded-2xl flex items-center justify-center cursor-pointer"
            @click="startLogin">
            <div class="text-white text-center">
              <RefreshCw class="w-8 h-8 mx-auto mb-2"/>
              <p class="text-sm">二维码已过期</p>
              <p class="text-xs opacity-60">点击刷新</p>
            </div>
          </div>
        </div>

        <div class="text-center">
          <div v-if="loginStatus === 'pending'"
            class="flex items-center gap-2 text-sm text-slate-500">
            <div class="w-2 h-2 rounded-full bg-amber-400 animate-pulse"/>
            等待扫码...
          </div>
          <div v-if="loginStatus === 'confirmed'"
            class="text-green-600 text-sm font-medium">
            登录成功，正在连接...
          </div>
        </div>

        <button @click="showQrcode = false"
          class="w-full py-2.5 rounded-2xl border border-slate-200 text-sm hover:bg-slate-50">
          取消
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { useAppStore } from '../stores/app'
import { api } from '../api'
import { MessageCircle, Plus, Unlink, QrCode,
         CheckCircle, RefreshCw } from 'lucide-vue-next'

const store = useAppStore()
const accounts = ref([])
const isLoggingIn = ref(false)
const showQrcode = ref(false)
const qrcodeImg = ref('')
const qrcodeUrl = ref('')
const loginStatus = ref('pending')  // pending/confirmed/expired
let currentSessionId = ref('')

async function loadAccounts() {
  try {
    const data = await api.get('/api/weixin/accounts')
    if (data?.accounts) {
      accounts.value = data.accounts
    }
  } catch (e) {
    console.error('[Weixin] Load accounts failed:', e)
  }
}

async function startLogin() {
  isLoggingIn.value = true
  loginStatus.value = 'pending'
  showQrcode.value = true
  qrcodeImg.value = ''
  qrcodeUrl.value = ''

  try {
    const data = await api.post('/api/weixin/login', {})
    currentSessionId.value = data.sessionId
    qrcodeImg.value = data.qrcodeImgBase64 || ''
    qrcodeUrl.value = data.qrcodeUrl || ''
    console.log('[Weixin] Login response:', {
      sessionId: data.sessionId,
      hasImg: !!data.qrcodeImgBase64,
      imgLen: data.qrcodeImgBase64?.length || 0,
      hasUrl: !!data.qrcodeUrl,
      qrcodeUrl: data.qrcodeUrl
    })
  } catch (e) {
    console.error('[Weixin] Login failed:', e)
    showQrcode.value = false
  } finally {
    isLoggingIn.value = false
  }
}

async function disconnect(accountId) {
  if (!confirm('确认断开此微信账号？')) return
  try {
    await api.delete(`/api/weixin/accounts/${accountId}`)
    await loadAccounts()
  } catch (e) {
    console.error('[Weixin] Disconnect failed:', e)
  }
}

function handleWsMessage(msg) {
  if (msg.type === 'weixin_login_success' &&
      msg.sessionId === currentSessionId.value) {
    loginStatus.value = 'confirmed'
    setTimeout(async () => {
      showQrcode.value = false
      await loadAccounts()
    }, 1500)
  }
  if (msg.type === 'weixin_login_expired' &&
      msg.sessionId === currentSessionId.value) {
    loginStatus.value = 'expired'
  }
  if (msg.type === 'weixin_account_status') {
    loadAccounts()
  }
}

function onWSEvent(e) {
  handleWsMessage(e.detail)
}

function formatTime(ts) {
  if (!ts) return '从未'
  return new Date(ts).toLocaleString('zh-CN', {
    month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit'
  })
}

onMounted(() => {
  loadAccounts()
  window.addEventListener('weixin-ws', onWSEvent)
})

onUnmounted(() => {
  window.removeEventListener('weixin-ws', onWSEvent)
})
</script>
