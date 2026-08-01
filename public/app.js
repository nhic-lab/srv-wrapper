const state = { servers: [], activeRuns: new Map() }

async function loadServers() {
  const res = await fetch('/api/servers')
  state.servers = await res.json()
  renderServerList()
}

function renderServerList() {
  const el = document.getElementById('server-list')
  el.innerHTML = state.servers.map((s) => {
    const hasActive = [...state.activeRuns.values()].some((r) => r.serverId === s.id)
    const dotColor = hasActive ? 'var(--green)' : 'var(--t-900)'
    return `<div class="vsrv"><span class="vdot" style="background:${dotColor}"></span> ${escapeHtml(s.id)}</div>`
  }).join('')
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
    const form = new FormData(e.target)
    const payload = Object.fromEntries(form.entries())
    payload.port = Number(payload.port)
    const res = await fetch('/api/servers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    })
    if (res.ok) { e.target.reset(); loadServers() }
  })

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
