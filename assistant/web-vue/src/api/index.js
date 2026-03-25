import { useAppStore } from '../stores/app'

function headers() {
  const store = useAppStore()
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${store.token}`
  }
}

export async function apiFetch(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    credentials: 'include',
    headers: { ...headers(), ...options.headers }
  })
  if (res.status === 401) {
    useAppStore().setToken('')
    return null
  }
  if (!res.ok) throw new Error(`${res.status}`)
  return res.json()
}

export const api = {
  get: (path) => apiFetch(path),
  post: (path, body) => apiFetch(path, {
    method: 'POST', body: JSON.stringify(body)
  }),
  put: (path, body) => apiFetch(path, {
    method: 'PUT', body: JSON.stringify(body)
  }),
  patch: (path, body) => apiFetch(path, {
    method: 'PATCH', body: JSON.stringify(body)
  }),
  delete: (path) => apiFetch(path, { method: 'DELETE' }),
}