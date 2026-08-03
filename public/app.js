const state = {
  servers: [],
  activeRuns: new Map(), // requestId -> { serverId, agentLabel, output, startedAt }
  history: [],
  historyLoaded: false,
  view: localStorage.getItem('srv.lastView') || 'live',
  editingServerId: null,
}

const liveCards = new Map() // requestId -> { root, body, stickToBottom }

// ---------- helpers ----------

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function pad2(n) {
  return String(n).padStart(2, '0')
}

function formatTimestamp(ms) {
  if (!ms) return 'n/a'
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

function formatElapsed(startedAt) {
  const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${seconds % 60}s`
}

function formatDuration(startedAt, endedAt) {
  if (!startedAt || !endedAt) return null
  const seconds = Math.round((endedAt - startedAt) / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${seconds % 60}s`
}

function showToast(message, kind = 'default') {
  const el = document.createElement('div')
  el.className = `toast${kind !== 'default' ? ` ${kind}` : ''}`
  el.textContent = message
  document.getElementById('toasts').appendChild(el)
  setTimeout(() => {
    el.style.transition = 'opacity 200ms ease'
    el.style.opacity = '0'
    setTimeout(() => el.remove(), 200)
  }, 4200)
}

function isTypingTarget(el) {
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
}

const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function trapFocus(container, e) {
  if (e.key !== 'Tab') return
  const focusable = [...container.querySelectorAll(FOCUSABLE_SELECTOR)].filter((el) => el.offsetParent !== null)
  if (!focusable.length) return
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault()
    first.focus()
  }
}

function activeOverlayContainer() {
  if (!document.getElementById('palette').hidden) return document.getElementById('palette')
  if (!document.getElementById('server-slideover').hidden) return document.getElementById('server-slideover')
  if (!document.getElementById('confirm-dialog').hidden) return document.getElementById('confirm-dialog')
  return null
}

// ---------- servers: load + sidebar ----------

async function loadServers() {
  try {
    const res = await fetch('/api/servers')
    state.servers = await res.json()
  } catch {
    showToast('Could not reach the daemon to list servers.', 'error')
    state.servers = state.servers.length ? state.servers : []
  }
  renderServerList()
  renderRegisteredServers()
}

function activeServerIds() {
  return new Set([...state.activeRuns.values()].map((r) => r.serverId))
}

function renderServerList() {
  const query = document.getElementById('server-search').value.trim().toLowerCase()
  const active = activeServerIds()
  const matches = (s) => !query || s.id.toLowerCase().includes(query)

  const activeSection = document.getElementById('active-section')
  const activeServers = state.servers.filter((s) => active.has(s.id))
  activeSection.hidden = activeServers.length === 0
  document.getElementById('active-server-list').innerHTML = activeServers
    .filter(matches)
    .map((s) => srvRowHtml(s, true)).join('')

  const listEl = document.getElementById('server-list')
  if (!state.servers.length) {
    listEl.innerHTML = '<div class="srv-empty">No servers yet — add one from the Servers view.</div>'
  } else {
    const rows = state.servers.map((s) => srvRowHtml(s, active.has(s.id), !matches(s)))
    listEl.innerHTML = rows.join('')
    if (query && !state.servers.some(matches)) {
      listEl.innerHTML = `<div class="srv-empty">No servers match "${escapeHtml(query)}".</div>`
    }
  }

  document.querySelectorAll('.srv-row').forEach((row) => {
    const activate = () => {
      switchView('live')
      row.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
    row.addEventListener('click', activate)
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        activate()
      }
    })
  })
}

function srvRowHtml(s, isActive, hidden = false) {
  return `<div class="srv-row${hidden ? ' no-match' : ''}" data-id="${escapeHtml(s.id)}" role="button" tabindex="0" title="${escapeHtml(s.id)}">
    <span class="dot${isActive ? ' run' : ''}"></span><span class="srv-row-label">${escapeHtml(s.id)}</span>
  </div>`
}

function renderRegisteredServers() {
  const el = document.getElementById('registered-servers')
  if (!state.servers.length) {
    el.innerHTML = `<div class="empty">No servers registered yet.<br>Click <strong>+ Add server</strong> above to register your first one.</div>`
    return
  }
  el.innerHTML = state.servers.map((s) => `
    <div class="server-row" data-id="${escapeHtml(s.id)}">
      <div class="meta">
        <div class="id">${escapeHtml(s.id)}</div>
        <div class="detail">${escapeHtml(s.username)}@${escapeHtml(s.host)}:${escapeHtml(s.port)} · ${escapeHtml(s.authMethod)}</div>
      </div>
      <div class="actions">
        <button type="button" class="btn btn-ghost" data-action="edit">Edit</button>
        <button type="button" class="btn btn-danger" data-action="delete">Delete</button>
      </div>
    </div>
  `).join('')

  el.querySelectorAll('.server-row').forEach((row) => {
    const id = row.dataset.id
    row.querySelector('[data-action="edit"]').addEventListener('click', () => openServerForm(id))
    row.querySelector('[data-action="delete"]').addEventListener('click', () => confirmDeleteServer(id))
  })
}

// ---------- server slide-over form ----------

function openServerForm(id = null) {
  state.editingServerId = id
  showServerFormError(null)
  const form = document.getElementById('server-form')
  form.reset()
  if (id) {
    const server = state.servers.find((s) => s.id === id)
    if (!server) return
    form.elements.id.value = server.id
    form.elements.id.disabled = true
    form.elements.host.value = server.host
    form.elements.port.value = server.port
    form.elements.username.value = server.username
    form.elements.authMethod.value = server.authMethod
    form.elements.secret.placeholder = 'leave blank to keep the current password or key passphrase'
    form.elements.secret.required = false
    document.getElementById('server-form-title').textContent = `Edit ${server.id}`
    document.getElementById('server-form-submit').textContent = 'Save changes'
  } else {
    form.elements.id.disabled = false
    form.elements.secret.placeholder = 'password or key passphrase'
    form.elements.secret.required = true
    document.getElementById('server-form-title').textContent = 'Register a server'
    document.getElementById('server-form-submit').textContent = 'Add server'
  }
  document.getElementById('server-scrim').hidden = false
  const panel = document.getElementById('server-slideover')
  panel.hidden = false
  panel.setAttribute('aria-hidden', 'false')
  setTimeout(() => form.elements.id.focus(), 50)
}

function closeServerForm() {
  document.getElementById('server-scrim').hidden = true
  const panel = document.getElementById('server-slideover')
  panel.hidden = true
  panel.setAttribute('aria-hidden', 'true')
  state.editingServerId = null
}

function showServerFormError(message) {
  const el = document.getElementById('server-form-error')
  if (!message) { el.hidden = true; el.textContent = ''; return }
  el.hidden = false
  el.textContent = message
}

function setupServerForm() {
  document.getElementById('open-add-server').addEventListener('click', () => openServerForm())
  document.getElementById('server-form-cancel').addEventListener('click', closeServerForm)
  document.getElementById('server-form-close').addEventListener('click', closeServerForm)
  document.getElementById('server-scrim').addEventListener('click', closeServerForm)

  document.getElementById('server-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    showServerFormError(null)
    const formEl = e.target
    const wasDisabled = formEl.elements.id.disabled
    if (wasDisabled) formEl.elements.id.disabled = false
    const form = new FormData(formEl)
    if (wasDisabled) formEl.elements.id.disabled = true
    const payload = Object.fromEntries(form.entries())
    payload.port = Number(payload.port)
    payload.isEdit = Boolean(state.editingServerId)

    let res
    try {
      res = await fetch('/api/servers', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      })
    } catch (err) {
      showServerFormError(`Request failed: ${err.message}`)
      return
    }
    if (res.ok) {
      const wasEdit = Boolean(state.editingServerId)
      closeServerForm()
      await loadServers()
      showToast(wasEdit ? `Saved changes to ${payload.id}.` : `Added ${payload.id}.`, 'success')
    } else {
      let message = `Request failed (${res.status})`
      try {
        const body = await res.json()
        if (body?.error) message = body.error
      } catch {
        // response wasn't JSON — keep the generic status message above
      }
      showServerFormError(message)
    }
  })
}

// ---------- bulk import ----------

function setupBulkImport() {
  document.getElementById('bulk-submit').addEventListener('click', async () => {
    const textarea = document.getElementById('bulk-json')
    const raw = textarea.value
    textarea.classList.remove('invalid')
    let servers
    try {
      servers = JSON.parse(raw)
    } catch (err) {
      textarea.classList.add('invalid')
      showToast(`Invalid JSON: ${err.message}`, 'error')
      return
    }
    if (!Array.isArray(servers)) {
      textarea.classList.add('invalid')
      showToast('Expected a JSON array of server objects.', 'error')
      return
    }

    let res
    try {
      res = await fetch('/api/servers/bulk', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ servers }),
      })
    } catch (err) {
      showToast(`Bulk import request failed: ${err.message}`, 'error')
      return
    }

    let result
    try {
      result = await res.json()
    } catch {
      showToast(`Bulk import failed (${res.status}).`, 'error')
      return
    }

    if (!res.ok) {
      showToast(result.error ?? `Bulk import failed (${res.status}).`, 'error')
      return
    }

    if (result.failed.length) {
      showToast(`${result.succeeded.length} added, ${result.failed.length} failed: ` +
        result.failed.map((f) => `${f.id ?? '?'} (${f.error})`).join(', '), 'error')
    } else {
      showToast(`${result.succeeded.length} server(s) imported.`, 'success')
      textarea.value = ''
    }
    await loadServers()
  })
}

// ---------- confirm dialog ----------

let pendingConfirm = null

function askConfirm(message, onConfirm) {
  pendingConfirm = onConfirm
  document.getElementById('confirm-message').innerHTML = message
  document.getElementById('confirm-scrim').hidden = false
  document.getElementById('confirm-dialog').hidden = false
}

function closeConfirm() {
  document.getElementById('confirm-scrim').hidden = true
  document.getElementById('confirm-dialog').hidden = true
  pendingConfirm = null
}

function setupConfirmDialog() {
  document.getElementById('confirm-ok').addEventListener('click', () => {
    const fn = pendingConfirm
    closeConfirm()
    if (fn) fn()
  })
  document.getElementById('confirm-cancel').addEventListener('click', closeConfirm)
  document.getElementById('confirm-scrim').addEventListener('click', closeConfirm)
}

function confirmDeleteServer(id) {
  askConfirm(`Delete server <strong>${escapeHtml(id)}</strong>? This removes its registry entry and stored secret.`, async () => {
    try {
      await fetch(`/api/servers/${encodeURIComponent(id)}`, { method: 'DELETE' })
      await loadServers()
      showToast(`Deleted ${id}.`, 'success')
    } catch (err) {
      showToast(`Failed to delete ${id}: ${err.message}`, 'error')
    }
  })
}

// ---------- live feed ----------

function renderLiveSummary() {
  document.getElementById('live-summary').textContent = `${state.activeRuns.size} running`
}

function liveEmptyHtml() {
  return `<div class="empty">No active runs right now.<br>Kick one off from an agent with <strong>srv exec &lt;server-id&gt; "&lt;command&gt;"</strong> — it'll stream here live.</div>`
}

function createLiveCard(requestId, run) {
  const root = document.createElement('div')
  root.className = 'card'
  root.innerHTML = `
    <div class="top">
      <span class="id">${escapeHtml(run.serverId)}</span>
      <span class="status status-run">running</span>
    </div>
    <div class="agent">agent: ${escapeHtml(run.agentLabel)}${run.command ? ` · ${escapeHtml(run.command)}` : ''}</div>
    <div class="meta-row"><span class="elapsed" data-started="${run.startedAt}">0s</span></div>
    <div class="term">
      <div class="term-body"></div>
      <button type="button" class="jump-latest" hidden>New output ↓</button>
    </div>
  `
  const body = root.querySelector('.term-body')
  const jumpBtn = root.querySelector('.jump-latest')
  body.textContent = run.output
  body.addEventListener('scroll', () => {
    const entry = liveCards.get(requestId)
    if (!entry) return
    entry.stickToBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 24
    if (entry.stickToBottom) jumpBtn.hidden = true
  })
  jumpBtn.addEventListener('click', () => {
    body.scrollTop = body.scrollHeight
    jumpBtn.hidden = true
    const entry = liveCards.get(requestId)
    if (entry) entry.stickToBottom = true
  })
  const entry = { root, body, jumpBtn, stickToBottom: true }
  liveCards.set(requestId, entry)
  document.getElementById('live-feed').appendChild(root)
  body.scrollTop = body.scrollHeight
  return entry
}

function appendLiveChunk(requestId, run, chunk) {
  let entry = liveCards.get(requestId)
  if (!entry) entry = createLiveCard(requestId, run)
  entry.body.textContent += chunk
  if (entry.stickToBottom) entry.body.scrollTop = entry.body.scrollHeight
  else entry.jumpBtn.hidden = false
}

function removeLiveCard(requestId) {
  const entry = liveCards.get(requestId)
  if (entry) entry.root.remove()
  liveCards.delete(requestId)
}

function renderLiveFeed() {
  const feed = document.getElementById('live-feed')
  if (state.activeRuns.size === 0) {
    liveCards.clear()
    feed.innerHTML = liveEmptyHtml()
    renderLiveSummary()
    return
  }
  if (feed.querySelector('.empty')) feed.innerHTML = ''
  renderLiveSummary()
}

// ---------- history ----------

function historyEmptyHtml() {
  return `<div class="empty">Nothing here yet — completed and past runs will show up as they happen.</div>`
}

function passesHistoryFilters(run) {
  const q = document.getElementById('history-search').value.trim().toLowerCase()
  const exitFilter = document.getElementById('history-exit-filter').value
  if (q && !(`${run.serverId} ${run.command ?? ''}`.toLowerCase().includes(q))) return false
  if (exitFilter === 'ok' && run.exitCode !== 0) return false
  if (exitFilter === 'err' && !(run.exitCode !== 0 && run.exitCode != null)) return false
  if (exitFilter === 'running' && run.exitCode != null) return false
  return true
}

function renderHistory() {
  const el = document.getElementById('history-feed')
  const sorted = [...state.history].sort((a, b) => b.startedAt - a.startedAt).filter(passesHistoryFilters)
  if (!state.history.length) { el.innerHTML = historyEmptyHtml(); return }
  if (!sorted.length) { el.innerHTML = `<div class="empty">No runs match your filters.</div>`; return }

  el.innerHTML = sorted.map((r, i) => {
    const duration = formatDuration(r.startedAt, r.endedAt)
    const statusClass = r.exitCode == null ? 'status-run' : (r.exitCode === 0 ? 'status-idle' : 'status-err')
    const statusLabel = r.exitCode == null ? 'running' : `exit ${r.exitCode}`
    const long = (r.output ?? '').length > 400
    return `
    <div class="card" data-idx="${i}">
      <div class="top">
        <span class="id">${escapeHtml(r.serverId)}</span>
        <span class="status ${statusClass}">${escapeHtml(statusLabel)}</span>
      </div>
      <div class="agent">agent: ${escapeHtml(r.agentLabel)}${r.command ? ` · ${escapeHtml(r.command)}` : ''}</div>
      <div class="meta-row">
        <span>${escapeHtml(formatTimestamp(r.startedAt))}</span>
        ${duration ? `<span class="sep">·</span><span>${escapeHtml(duration)}</span>` : '<span class="sep">·</span><span>still running</span>'}
      </div>
      <div class="term">
        <div class="term-body${long ? ' collapsed' : ''}" data-idx="${i}">${escapeHtml(r.output ?? '')}</div>
        ${long ? `<div class="term-actions"><button type="button" data-action="toggle" data-idx="${i}">Expand</button><button type="button" data-action="copy" data-idx="${i}">Copy</button></div>` : `<div class="term-actions"><button type="button" data-action="copy" data-idx="${i}">Copy</button></div>`}
      </div>
    </div>`
  }).join('')

  el.querySelectorAll('[data-action="toggle"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const body = el.querySelector(`.term-body[data-idx="${btn.dataset.idx}"]`)
      const collapsed = body.classList.toggle('collapsed')
      btn.textContent = collapsed ? 'Expand' : 'Collapse'
    })
  })
  el.querySelectorAll('[data-action="copy"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const body = el.querySelector(`.term-body[data-idx="${btn.dataset.idx}"]`)
      try {
        await navigator.clipboard.writeText(body.textContent)
        showToast('Copied output to clipboard.', 'success')
      } catch {
        showToast('Could not copy — clipboard access denied.', 'error')
      }
    })
  })
}

async function loadHistory() {
  const el = document.getElementById('history-feed')
  if (!state.historyLoaded) el.innerHTML = skeletonHtml(3)
  try {
    const res = await fetch('/api/history')
    state.history = await res.json()
    state.historyLoaded = true
  } catch {
    showToast('Could not load history from the daemon.', 'error')
  }
  renderHistory()
}

function skeletonHtml(count) {
  return Array.from({ length: count }).map(() => `
    <div class="skeleton"><div class="skel-bar" style="width:40%"></div><div class="skel-bar" style="width:70%"></div><div class="skel-bar" style="width:90%"></div></div>
  `).join('')
}

// ---------- nav / views ----------

function switchView(view) {
  state.view = view
  localStorage.setItem('srv.lastView', view)
  document.querySelectorAll('.nav-item').forEach((i) => i.classList.toggle('active', i.dataset.view === view))
  document.getElementById('view-live').hidden = view !== 'live'
  document.getElementById('view-history').hidden = view !== 'history'
  document.getElementById('view-servers').hidden = view !== 'servers'
  if (view === 'history') loadHistory()
}

function setupNav() {
  document.querySelectorAll('.nav-item').forEach((item) => {
    item.addEventListener('click', () => switchView(item.dataset.view))
  })
  switchView(state.view)
}

function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      openPalette()
      return
    }
    if (e.key === 'Escape') {
      if (!document.getElementById('palette').hidden) closePalette()
      else if (!document.getElementById('server-slideover').hidden) closeServerForm()
      else if (!document.getElementById('confirm-dialog').hidden) closeConfirm()
      return
    }
    const overlay = activeOverlayContainer()
    if (overlay) { trapFocus(overlay, e); return }
    if (isTypingTarget(document.activeElement)) return
    if (e.key === '1') switchView('live')
    else if (e.key === '2') switchView('history')
    else if (e.key === '3') switchView('servers')
  })
}

// ---------- command palette ----------

function paletteActions() {
  const actions = [
    { tag: 'view', label: 'Go to Live', run: () => switchView('live') },
    { tag: 'view', label: 'Go to History', run: () => switchView('history') },
    { tag: 'view', label: 'Go to Servers', run: () => switchView('servers') },
    { tag: 'action', label: 'Register a server', run: () => { switchView('servers'); openServerForm() } },
  ]
  state.servers.forEach((s) => {
    actions.push({ tag: 'server', label: s.id, run: () => { switchView('live') } })
  })
  return actions
}

let paletteIndex = 0
let paletteFiltered = []

function openPalette() {
  document.getElementById('palette-scrim').hidden = false
  const palette = document.getElementById('palette')
  palette.hidden = false
  const input = document.getElementById('palette-input')
  input.value = ''
  renderPalette('')
  setTimeout(() => input.focus(), 30)
}

function closePalette() {
  document.getElementById('palette-scrim').hidden = true
  document.getElementById('palette').hidden = true
}

function renderPalette(query) {
  const q = query.trim().toLowerCase()
  paletteFiltered = paletteActions().filter((a) => a.label.toLowerCase().includes(q))
  paletteIndex = 0
  const el = document.getElementById('palette-results')
  if (!paletteFiltered.length) {
    el.innerHTML = '<div class="palette-empty">No matches.</div>'
    return
  }
  el.innerHTML = paletteFiltered.map((a, i) => `
    <div class="palette-item${i === paletteIndex ? ' active' : ''}" data-idx="${i}">
      <span class="label">${escapeHtml(a.label)}</span>
      <span class="tag">${escapeHtml(a.tag)}</span>
    </div>
  `).join('')
  el.querySelectorAll('.palette-item').forEach((item) => {
    item.addEventListener('click', () => runPaletteItem(Number(item.dataset.idx)))
  })
}

function runPaletteItem(idx) {
  const action = paletteFiltered[idx]
  if (!action) return
  closePalette()
  action.run()
}

function setupPalette() {
  document.getElementById('open-palette').addEventListener('click', openPalette)
  document.getElementById('palette-scrim').addEventListener('click', closePalette)
  document.getElementById('palette-input').addEventListener('input', (e) => renderPalette(e.target.value))
  document.getElementById('palette-input').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      paletteIndex = Math.min(paletteIndex + 1, paletteFiltered.length - 1)
      updatePaletteActive()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      paletteIndex = Math.max(paletteIndex - 1, 0)
      updatePaletteActive()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      runPaletteItem(paletteIndex)
    }
  })
}

function updatePaletteActive() {
  document.querySelectorAll('.palette-item').forEach((el, i) => el.classList.toggle('active', i === paletteIndex))
}

// ---------- search wiring ----------

function setupSearch() {
  document.getElementById('server-search').addEventListener('input', renderServerList)
  document.getElementById('history-search').addEventListener('input', renderHistory)
  document.getElementById('history-exit-filter').addEventListener('change', renderHistory)
}

// ---------- websocket / connection status ----------

function setConnState(stateName) {
  document.getElementById('conn-status').dataset.state = stateName
}

function connectLiveSocket() {
  setConnState('connecting')
  const ws = new WebSocket(`ws://${location.host}/api/live`)

  ws.onopen = () => setConnState('connected')
  ws.onclose = () => {
    setConnState('disconnected')
    setTimeout(connectLiveSocket, 2000)
  }
  ws.onerror = () => ws.close()

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data)
    if (msg.type === 'stream') {
      const existing = state.activeRuns.get(msg.requestId)
      const run = existing ?? { serverId: msg.serverId, agentLabel: msg.agentLabel, command: msg.command, output: '', startedAt: Date.now() }
      run.output += msg.chunk
      state.activeRuns.set(msg.requestId, run)
      renderLiveFeed()
      appendLiveChunk(msg.requestId, run, msg.chunk)
      renderServerList()
    } else if (msg.type === 'done') {
      state.activeRuns.delete(msg.requestId)
      removeLiveCard(msg.requestId)
      renderLiveFeed()
      renderServerList()
    }
  }
}

function tickElapsedTimers() {
  document.querySelectorAll('.elapsed').forEach((el) => {
    el.textContent = formatElapsed(Number(el.dataset.started))
  })
}
setInterval(tickElapsedTimers, 1000)

// ---------- boot ----------

document.getElementById('live-feed').innerHTML = liveEmptyHtml()
loadServers()
setupNav()
setupServerForm()
setupBulkImport()
setupConfirmDialog()
setupPalette()
setupSearch()
setupKeyboardShortcuts()
connectLiveSocket()
renderLiveFeed()
