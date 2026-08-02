const state = { servers: [], activeRuns: new Map() }

async function loadServers() {
  const res = await fetch('/api/servers')
  state.servers = await res.json()
  renderServerList()
  renderRegisteredServers()
}

function renderServerList() {
  const el = document.getElementById('server-list')
  el.innerHTML = state.servers.map((s) => {
    const hasActive = [...state.activeRuns.values()].some((r) => r.serverId === s.id)
    const dotColor = hasActive ? 'var(--green)' : 'var(--t-900)'
    return `<div class="vsrv"><span class="vdot" style="background:${dotColor}"></span> ${escapeHtml(s.id)}</div>`
  }).join('')
}

function renderRegisteredServers() {
  const el = document.getElementById('registered-servers')
  if (!state.servers.length) {
    el.innerHTML = '<p style="color:var(--t-900)">No servers registered yet.</p>'
    return
  }
  el.innerHTML = state.servers.map((s) => `
    <div class="server-row" data-id="${escapeHtml(s.id)}">
      <div class="meta">
        <div class="id">${escapeHtml(s.id)}</div>
        <div class="detail">${escapeHtml(s.username)}@${escapeHtml(s.host)}:${escapeHtml(s.port)} · ${escapeHtml(s.authMethod)}</div>
      </div>
      <div class="actions">
        <button type="button" class="btn-ghost" data-action="edit">Edit</button>
        <button type="button" class="btn-danger" data-action="delete">Delete</button>
      </div>
    </div>
  `).join('')

  el.querySelectorAll('.server-row').forEach((row) => {
    const id = row.dataset.id
    row.querySelector('[data-action="edit"]').addEventListener('click', () => startEditServer(id))
    row.querySelector('[data-action="delete"]').addEventListener('click', () => deleteServer(id))
  })
}

function startEditServer(id) {
  const server = state.servers.find((s) => s.id === id)
  if (!server) return
  const form = document.getElementById('server-form')
  form.elements.id.value = server.id
  form.elements.id.disabled = true
  form.elements.host.value = server.host
  form.elements.port.value = server.port
  form.elements.username.value = server.username
  form.elements.authMethod.value = server.authMethod
  form.elements.secret.value = ''
  form.elements.secret.placeholder = 're-enter password or key passphrase to update'
  document.getElementById('server-form-title').textContent = `Edit ${server.id}`
  document.getElementById('server-form-submit').textContent = 'Save changes'
  document.getElementById('server-form-cancel').hidden = false
  form.scrollIntoView({ behavior: 'smooth' })
}

function resetServerForm() {
  const form = document.getElementById('server-form')
  form.reset()
  form.elements.id.disabled = false
  form.elements.secret.placeholder = 'password or key passphrase'
  document.getElementById('server-form-title').textContent = 'Register a server'
  document.getElementById('server-form-submit').textContent = 'Add server'
  document.getElementById('server-form-cancel').hidden = true
}

async function deleteServer(id) {
  if (!confirm(`Delete server "${id}"? This removes its registry entry and stored secret.`)) return
  await fetch(`/api/servers/${encodeURIComponent(id)}`, { method: 'DELETE' })
  loadServers()
}

function renderLiveFeed() {
  const el = document.getElementById('live-feed')
  const runs = [...state.activeRuns.values()]
  document.getElementById('live-summary').textContent = `${runs.length} running`
  el.innerHTML = runs.map((r) => `
    <div class="vcard">
      <div class="top">
        <span class="id">${escapeHtml(r.serverId)}</span>
        <span class="status status-run">running</span>
      </div>
      <div class="agent">agent: ${escapeHtml(r.agentLabel)}</div>
      <div class="vlog">${escapeHtml(r.output)}</div>
    </div>
  `).join('') || '<p style="color:var(--t-900)">No active runs.</p>'
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function connectLiveSocket() {
  const ws = new WebSocket(`ws://${location.host}/api/live`)
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data)
    if (msg.type === 'stream') {
      const run = state.activeRuns.get(msg.requestId) ?? { serverId: msg.serverId, agentLabel: msg.agentLabel, output: '' }
      run.output += msg.chunk
      state.activeRuns.set(msg.requestId, run)
    } else if (msg.type === 'done') {
      state.activeRuns.delete(msg.requestId)
    }
    renderLiveFeed()
    renderServerList()
  }
}

async function loadHistory() {
  const res = await fetch('/api/history')
  const runs = await res.json()
  document.getElementById('history-feed').innerHTML = runs.map((r) => `
    <div class="vcard">
      <div class="top">
        <span class="id">${escapeHtml(r.serverId)}</span>
        <span class="${r.exitCode === 0 ? 'status status-idle' : 'status status-err'}">${escapeHtml(r.exitCode ?? 'n/a')}</span>
      </div>
      <div class="agent">agent: ${escapeHtml(r.agentLabel)} · ${escapeHtml(r.command ?? '')}</div>
      <div class="vlog">${escapeHtml(r.output)}</div>
    </div>
  `).join('')
}

function setupNav() {
  document.querySelectorAll('.nav-item').forEach((item) => {
    item.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach((i) => i.classList.remove('active'))
      item.classList.add('active')
      const view = item.dataset.view
      document.getElementById('view-live').hidden = view !== 'live'
      document.getElementById('view-history').hidden = view !== 'history'
      document.getElementById('view-servers').hidden = view !== 'servers'
      if (view === 'history') loadHistory()
    })
  })
}

function setupServerForm() {
  document.getElementById('server-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    const formEl = e.target
    // FormData skips disabled fields, but a disabled id field during edit still needs to be sent.
    const wasDisabled = formEl.elements.id.disabled
    if (wasDisabled) formEl.elements.id.disabled = false
    const form = new FormData(formEl)
    if (wasDisabled) formEl.elements.id.disabled = true
    const payload = Object.fromEntries(form.entries())
    payload.port = Number(payload.port)
    const res = await fetch('/api/servers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    })
    if (res.ok) { resetServerForm(); loadServers() }
  })

  document.getElementById('server-form-cancel').addEventListener('click', () => resetServerForm())

  document.getElementById('bulk-submit').addEventListener('click', async () => {
    const raw = document.getElementById('bulk-json').value
    let servers
    try {
      servers = JSON.parse(raw)
    } catch {
      document.getElementById('bulk-result').textContent = 'Invalid JSON'
      return
    }
    const res = await fetch('/api/servers/bulk', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ servers }),
    })
    const result = await res.json()
    document.getElementById('bulk-result').textContent =
      `${result.succeeded.length} added, ${result.failed.length} failed` +
      (result.failed.length ? ': ' + result.failed.map((f) => `${f.id ?? '?'} (${f.error})`).join(', ') : '')
    loadServers()
  })
}

loadServers()
setupNav()
setupServerForm()
connectLiveSocket()
renderLiveFeed()
