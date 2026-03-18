// ─────────────────────────────────────────────
// API 请求封装
// ─────────────────────────────────────────────
const api = async (path, opts = {}) => {
  const method = opts.method || 'GET'
  const bodyStr = opts.body ? JSON.stringify(opts.body).substring(0, 100) : ''
  devLog('API', method, path, bodyStr)

  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  })
  if (res.status === 401) { showLogin(); return null }
  // 业务错误（4xx）正常返回 JSON，只有服务器错误（5xx）才抛出
  if (res.status >= 500) throw new Error(`${res.status} ${await res.text()}`)
  const data = await res.json()
  devLog('API', 'response', path, res.status)
  return data
}
