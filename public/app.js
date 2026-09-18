/* srv ops console — list/detail shell.
   Implements `Srv Console B.dc.html`. Vanilla, no build step.
   Rendering rule (see docs dev-notes): the list and the detail re-render
   independently, and the detail's terminal is never re-rendered while a run
   streams — lines are appended to it in place. */

const MAX_TERM_LINES = 4000
const LIVE_GRACE_MS = 30000
const TEST_ALL_STUCK_TIMEOUT_MS = 15000
const HISTORY_PAGE = 500
const SERVER_RUNS = 6

const IMPORT_SAMPLE = `[
  {
    "id": "srv-c3",
    "host": "10.0.3.11",
    "port": 22,
    "username": "deploy",
    "authMethod": "key",
    "keyPath": "~/.ssh/id_ed25519",
    "jumpChain": ["bastion-eu"]
  }
]`

const state = {
  view: localStorage.getItem('srv.lastView') || 'live',
  query: '',
  histStatus: 'any',
  servers: [],
  tests: new Map(), // server id -> { state: 'testing'|'online'|'offline'|'untested', error? }
  live: new Map(), // requestId -> run
  history: [],          // run metadata only — output is fetched per run
  historyLoaded: false,
  historyTotal: 0,
  runOutputs: new Map(), // run id -> full record with output
  serverRuns: new Map(), // server id -> recent runs for that server
  srvStatus: 'any',
  selRun: null,
  selHist: localStorage.getItem('srv.selHist') || null,
  selServer: localStorage.getItem('srv.selServer') || null,
  draft: false,
  form: blankForm(),
  formError: null,
  testResult: null, // { state: 'pending'|'ok'|'fail', text }
  importOpen: false,
  confirmId: null,
  paletteOpen: false,
  paletteQuery: '',
  palIndex: 0,
  toasts: [],
}

// DOM nodes that live for the whole session
const el = {
  app: document.getElementById('app'),
  conn: document.getElementById('conn'),
  tabLiveBadge: document.getElementById('tab-live-badge'),
  tabServerCount: document.getElementById('tab-server-count'),
  overline: document.getElementById('list-overline'),
  title: document.getElementById('list-title'),
  search: document.getElementById('list-search'),
  histStatus: document.getElementById('hist-status'),
  testAll: document.getElementById('test-all'),
  srvStatus: document.getElementById('srv-status'),
  tallies: document.getElementById('tallies'),
  listMore: document.getElementById('list-more'),
  listMoreNote: document.getElementById('list-more-note'),
  loadMore: document.getElementById('load-more'),
  themeToggle: document.getElementById('theme-toggle'),
  addServer: document.getElementById('add-server'),
  listScroll: document.getElementById('list-scroll'),
  listRows: document.getElementById('list-rows'),
  importBlock: document.getElementById('import-block'),
  importToggle: document.getElementById('import-toggle'),
  importBody: document.getElementById('import-body'),
  importText: document.getElementById('import-text'),
  detail: document.getElementById('detail'),
  detailPane: document.getElementById('detail-pane'),
  paneBack: document.getElementById('pane-back'),
  paneBackLabel: document.getElementById('pane-back-label'),
  toasts: document.getElementById('toasts'),
  palette: document.getElementById('palette'),
  paletteOverlay: document.getElementById('palette-overlay'),
  paletteScrim: document.getElementById('palette-scrim'),
  paletteInput: document.getElementById('palette-input'),
  paletteList: document.getElementById('palette-list'),
  confirm: document.getElementById('confirm-dialog'),
  confirmOverlay: document.getElementById('confirm-overlay'),
  confirmScrim: document.getElementById('confirm-scrim'),
  confirmTitle: document.getElementById('confirm-title'),
}

// terminal DOM mirror for the currently rendered run
let term = { key: null, container: null, rows: [], stick: true }
let palRows = []

// ---------- small helpers ----------

function blankForm() {
  return { id: '', host: '', port: '22', username: '', authMethod: 'key', secret: '', hops: [] }
}

function h(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ))
}

function pad2(n) { return String(n).padStart(2, '0') }

function fmtStamp(ms) {
  if (!ms) return '—'
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

function fmtDate(ms) {
  if (!ms) return '—'
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function fmtSecs(sec) {
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}m ${s < 10 ? '0' + s : s}s`
}

function fmtElapsed(startedAt) {
  return fmtSecs(Math.max(0, Math.round((Date.now() - startedAt) / 1000)))
}

function fmtDuration(startedAt, endedAt) {
  if (!startedAt || !endedAt) return null
  const ms = endedAt - startedAt
  if (ms < 1000) return `${ms}ms`
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${(ms / 1000).toFixed(1)}s`
  return fmtSecs(sec)
}

function relTime(ms) {
  if (!ms) return '—'
  const diff = Date.now() - ms
  if (diff < 45000) return 'just now'
  const min = Math.round(diff / 60000)
  if (min < 60) return `${min} min ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return hr === 1 ? '1 hr ago' : `${hr} hr ago`
  const day = Math.round(hr / 24)
  return day === 1 ? 'yesterday' : `${day} days ago`
}

// Remote output carries ANSI colour/cursor escapes that would otherwise render
// as literal garbage in the terminal panel.
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g

function clean(str) {
  return String(str).replace(ANSI_RE, '').replace(/\r/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
}

function fmtBytes(n) {
  if (n == null) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function serverById(id) {
  return state.servers.find((s) => s.id === id)
}

function addrOf(id) {
  const s = serverById(id)
  return s ? `${s.username}@${s.host}:${s.port}` : '—'
}

function icon(paths, size = 14, extra = '') {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}>${paths}</svg>`
}

const ICON = {
  plus: '<path d="M5 12h14M12 5v14"></path>',
  x: '<path d="M18 6 6 18M6 6l12 12"></path>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path>',
  zap: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"></path>',
}

function toast(text, tone = 'neutral') {
  const id = 't' + Date.now() + Math.random()
  state.toasts.push({ id, text, tone })
  renderToasts()
  setTimeout(() => dismissToast(id), 4200)
}

function dismissToast(id) {
  const i = state.toasts.findIndex((t) => t.id === id)
  if (i === -1) return
  state.toasts.splice(i, 1)
  renderToasts()
}

function renderToasts() {
  el.toasts.innerHTML = state.toasts.map((t) => `
    <div class="toast facet-8">
      <span class="toast-dot ${t.tone === 'ok' ? 'ok' : t.tone === 'fail' ? 'fail' : ''}"></span>
      <span class="toast-text">${h(t.text)}</span>
      <button type="button" class="toast-x" data-id="${h(t.id)}" title="Dismiss" aria-label="Dismiss">${icon(ICON.x, 13)}</button>
    </div>`).join('')
  el.toasts.querySelectorAll('.toast-x').forEach((b) => {
    b.addEventListener('click', () => dismissToast(b.dataset.id))
  })
}

// ---------- jump chain preview (mirrors the daemon's validator; the daemon
// re-validates authoritatively on submit) ----------

function resolveJumpPathLocal(targetId, proposedChain) {
  const seen = new Set([targetId])
  const path = []
  const expand = (id) => {
    if (seen.has(id)) throw new Error(`"${id}" would be reached more than once`)
    seen.add(id)
    const rec = serverById(id)
    if (!rec) throw new Error(`unknown server id "${id}"`)
    ;(rec.jumpChain || []).forEach(expand)
    path.push(id)
  }
  proposedChain.forEach(expand)
  path.push(targetId)
  return path
}

function formTargetId() {
  return state.draft ? (state.form.id.trim() || 'new-server') : (state.selServer || 'this server')
}

function hopChoices(idx) {
  const target = formTargetId()
  const chain = state.form.hops
  return state.servers.filter((s) => {
    if (s.id === target) return false
    if (chain.some((id, j) => j !== idx && id === s.id)) return false
    try {
      resolveJumpPathLocal(target, chain.map((id, j) => (j === idx ? s.id : id)))
      return true
    } catch { return false }
  })
}

// ---------- data loading ----------

async function loadServers() {
  try {
    const res = await fetch('/api/servers')
    state.servers = await res.json()
  } catch {
    toast('Could not reach the daemon to list servers.', 'fail')
    return
  }
  const ids = new Set(state.servers.map((s) => s.id))
  for (const id of [...state.tests.keys()]) if (!ids.has(id)) state.tests.delete(id)
  if (state.selServer && !ids.has(state.selServer)) state.selServer = null
  renderTabs()
  renderList()
  if (state.view === 'servers') renderDetail()
}

/**
 * Loads a page of run *metadata*. Output is never included here — fetching it
 * for every run is what used to make this request fail outright once stored
 * output passed V8's string ceiling.
 */
let historyInFlight = false

async function loadHistory({ append = false } = {}) {
  if (append && historyInFlight) return
  const offset = append ? state.history.length : 0
  // A refresh (e.g. after a run finishes) must not throw away pages the user
  // already loaded, so it re-reads the whole loaded window, not just page one.
  const limit = append ? HISTORY_PAGE : Math.max(HISTORY_PAGE, state.history.length)
  historyInFlight = true
  try {
    const res = await fetch(`/api/history?limit=${limit}&offset=${offset}`)
    if (!res.ok) throw new Error(`request failed (${res.status})`)
    const rows = await res.json()
    const total = Number(res.headers.get('X-Total-Count'))
    state.historyTotal = Number.isFinite(total) ? total : rows.length
    state.history = append ? state.history.concat(rows) : rows
    state.historyLoaded = true
  } catch (err) {
    if (!state.historyLoaded) toast(`Could not load history: ${err.message}`, 'fail')
    return
  } finally {
    historyInFlight = false
  }
  if (state.view === 'history') { renderList(); renderDetail() }
  else if (state.view === 'servers') renderDetail()
}

/**
 * Fetches (and caches) one run's output. The cache is bounded: each entry can
 * be up to the 256 KB output cap, and a dashboard left open for a day would
 * otherwise accumulate every run the user clicked.
 */
const RUN_CACHE_MAX = 20

async function loadRunOutput(id) {
  if (state.runOutputs.has(id)) return state.runOutputs.get(id)
  const res = await fetch(`/api/history/${encodeURIComponent(id)}`)
  if (!res.ok) throw new Error(`could not load output (${res.status})`)
  const run = await res.json()
  state.runOutputs.set(id, run)
  // Map preserves insertion order, so the oldest key is the first one.
  while (state.runOutputs.size > RUN_CACHE_MAX) {
    state.runOutputs.delete(state.runOutputs.keys().next().value)
  }
  return run
}

/** Recent runs for one server, via the endpoint's serverId filter. */
async function loadServerRuns(id) {
  try {
    const res = await fetch(`/api/history?serverId=${encodeURIComponent(id)}&limit=${SERVER_RUNS}`)
    if (!res.ok) throw new Error(String(res.status))
    state.serverRuns.set(id, await res.json())
  } catch {
    state.serverRuns.set(id, [])
  }
  if (state.view === 'servers' && state.selServer === id) renderServerRuns()
}

// ---------- run/line model ----------

function newRun(requestId, msg) {
  return {
    requestId,
    serverId: msg.serverId || '—',
    agentLabel: msg.agentLabel || '—',
    command: msg.command || null,
    lines: [],
    open: null,
    startedAt: Date.now(),
    done: false,
    exitCode: undefined,
    error: null,
  }
}

/* Appends a chunk to a run's line list. Returns the DOM ops needed to mirror
   the change, so the terminal can be updated without a full rebuild. */
function ingest(run, stream, rawChunk) {
  const chunk = clean(rawChunk)
  const ops = []
  let buf = chunk
  while (buf.length) {
    const nl = buf.indexOf('\n')
    const piece = nl === -1 ? buf : buf.slice(0, nl)
    if (piece || nl === -1) {
      if (run.open && run.open.stream === stream) {
        run.lines[run.open.idx].text += piece
        ops.push({ type: 'update', idx: run.open.idx })
      } else {
        run.lines.push({ stream, text: piece })
        run.open = { stream, idx: run.lines.length - 1 }
        ops.push({ type: 'append', idx: run.lines.length - 1 })
      }
    }
    if (nl === -1) break
    if (run.open && run.open.stream === stream) run.open = null
    else if (!piece) {
      run.lines.push({ stream, text: '' })
      ops.push({ type: 'append', idx: run.lines.length - 1 })
    }
    buf = buf.slice(nl + 1)
  }
  if (run.lines.length > MAX_TERM_LINES) {
    const drop = run.lines.length - MAX_TERM_LINES
    run.lines.splice(0, drop)
    if (run.open) run.open.idx -= drop
    return [{ type: 'rebuild' }]
  }
  return ops
}

function historyLines(record) {
  const text = clean(record.output || '')
  if (!text) return []
  const parts = text.split('\n')
  if (parts.length && parts[parts.length - 1] === '') parts.pop()
  return parts.map((t) => ({ stream: 'out', text: t }))
}

// ---------- status vocabulary ----------

function liveBadge(run) {
  if (!run.done) return { label: 'running', tone: 'running' }
  if (run.error) return { label: 'failed', tone: 'fail' }
  if (run.exitCode === 0) return { label: 'exit 0', tone: 'ok' }
  if (typeof run.exitCode === 'number') return { label: `exit ${run.exitCode}`, tone: 'fail' }
  return { label: 'done', tone: 'untested' }
}

/* History rows carry exitCode === null both for runs still open and for runs
   the daemon closed without a code (a failed connection, a stopped session).
   endedAt is what separates the two. */
function histBadge(r) {
  if (r.endedAt == null) return { label: 'running', tone: 'running' }
  if (r.exitCode === 0) return { label: 'exit 0', tone: 'ok' }
  if (r.exitCode == null) return { label: 'no exit code', tone: 'fail' }
  return { label: `exit ${r.exitCode}`, tone: 'fail' }
}

/**
 * Reachability for one server. An in-flight/just-finished result from this
 * session wins; otherwise it falls back to what the daemon persisted, so the
 * online/offline filter still means something after a refresh or restart.
 */
function testMeta(id) {
  const live = state.tests.get(id)
  const rec = serverById(id)
  let s = 'untested'
  let error
  let at
  if (live && live.state === 'testing') {
    s = 'testing'
  } else if (live) {
    s = live.state
    error = live.error
    at = live.at
  } else if (rec && rec.lastTestAt) {
    s = rec.lastTestOk ? 'online' : 'offline'
    error = rec.lastTestError
    at = rec.lastTestAt
  }
  return {
    state: s,
    label: { online: 'reachable', offline: 'unreachable', testing: 'testing…', untested: 'not tested' }[s],
    tone: { online: 'ok', offline: 'fail', testing: 'testing', untested: 'untested' }[s],
    error,
    at,
  }
}

const TALLY_LABELS = { online: 'Online', offline: 'Offline', untested: 'Not tested', testing: 'Testing' }

function renderTallies() {
  if (state.view !== 'servers' || !state.servers.length) {
    el.tallies.hidden = true
    return
  }
  const counts = { online: 0, offline: 0, untested: 0, testing: 0 }
  state.servers.forEach((srv) => { counts[testMeta(srv.id).state] += 1 })

  const parts = ['online', 'offline', 'untested']
    .map((k) => `<button type="button" class="tally" data-k="${k}" aria-pressed="${state.srvStatus === k}">
      <span class="tally-dot ${k}"></span>${TALLY_LABELS[k]}<span class="tally-n">${counts[k]}</span>
    </button>`)
  // "Testing" is a transient state, not a filter — render it as a plain readout
  if (counts.testing) {
    parts.push(`<div class="tally" aria-live="polite">
      <span class="tally-dot testing"></span>${TALLY_LABELS.testing}<span class="tally-n">${counts.testing}</span>
    </div>`)
  }
  el.tallies.hidden = false
  el.tallies.innerHTML = parts.join('')
  el.tallies.querySelectorAll('.tally[data-k]').forEach((b) => {
    b.addEventListener('click', () => {
      state.srvStatus = state.srvStatus === b.dataset.k ? 'any' : b.dataset.k
      el.srvStatus.value = state.srvStatus
      renderList()
      renderTallies()
    })
  })
}

// ---------- view switching ----------

function switchView(view) {
  if (state.view === view) return
  state.view = view
  state.query = ''
  state.srvStatus = 'any'
  el.srvStatus.value = 'any'
  state.draft = false
  state.formError = null
  state.testResult = null
  el.search.value = ''
  el.app.dataset.view = view
  el.app.dataset.pane = 'list'
  localStorage.setItem('srv.lastView', view)
  if (view === 'history') loadHistory()
  renderChrome()
  renderList()
  renderDetail()
}

function renderChrome() {
  const v = state.view
  document.querySelectorAll('.tab').forEach((t) => {
    const active = t.dataset.view === v
    t.classList.toggle('active', active)
    if (active) t.setAttribute('aria-current', 'true')
    else t.removeAttribute('aria-current')
  })
  el.overline.textContent = v === 'live' ? 'Watching' : v === 'history' ? 'Audit' : 'Registry'
  el.title.textContent = v === 'live' ? 'Live activity' : v === 'history' ? 'History' : 'Servers'
  el.search.placeholder = v === 'live'
    ? 'Filter running by id or agent'
    : v === 'history' ? 'Filter by id, agent or command' : 'Search id, host or user'
  el.histStatus.hidden = v !== 'history'
  el.srvStatus.hidden = v !== 'servers'
  el.testAll.hidden = v !== 'servers'
  el.addServer.hidden = v !== 'servers'
  el.importBlock.hidden = v !== 'servers'
  el.paneBackLabel.textContent = v === 'live' ? 'All runs' : v === 'history' ? 'All history' : 'All servers'
}

function renderTabs() {
  const running = [...state.live.values()].filter((r) => !r.done).length
  el.tabLiveBadge.hidden = running === 0
  el.tabLiveBadge.textContent = String(running)
  el.tabServerCount.textContent = String(state.servers.length)
}

// ---------- list ----------

function liveRuns() {
  return [...state.live.values()].sort((a, b) => b.startedAt - a.startedAt)
}

function sortedHistory() {
  return [...state.history].sort((a, b) => b.startedAt - a.startedAt)
}

function buildRows() {
  const q = state.query.trim().toLowerCase()
  if (state.view === 'live') {
    return liveRuns()
      .filter((r) => !q || `${r.serverId} ${r.agentLabel}`.toLowerCase().includes(q))
      .map((r) => {
        const b = liveBadge(r)
        return {
          key: r.requestId,
          active: state.selRun === r.requestId,
          dot: r.done ? (b.tone === 'fail' ? 'failed' : 'ended') : 'live',
          title: r.serverId,
          sub: r.command || 'interactive session',
          meta: r.done ? 'moving to history' : fmtElapsed(r.startedAt),
          live: !r.done,
          startedAt: r.startedAt,
          badge: r.done
            ? `<span class="chip ${b.tone}">${h(b.label)}</span>`
            : `<span class="agent-chip" title="${h(r.agentLabel)}">${h(r.agentLabel)}</span>`,
          pick: () => { state.selRun = r.requestId; afterPick() },
        }
      })
  }
  if (state.view === 'history') {
    return sortedHistory()
      .filter((r) => {
        if (state.histStatus === 'ok' && r.exitCode !== 0) return false
        if (state.histStatus === 'fail' && !(r.exitCode > 0)) return false
        if (state.histStatus === 'running' && r.endedAt != null) return false
        if (!q) return true
        return `${r.serverId} ${r.agentLabel} ${r.command || ''}`.toLowerCase().includes(q)
      })
      .map((r) => {
        const b = histBadge(r)
        return {
          key: r.id,
          active: state.selHist === r.id,
          dot: b.tone === 'ok' ? 'online' : b.tone === 'running' ? 'live' : 'offline',
          title: r.serverId,
          sub: r.command || 'interactive session',
          meta: relTime(r.startedAt),
          badge: `<span class="chip ${b.tone}">${h(b.label)}</span>`,
          pick: () => { state.selHist = r.id; localStorage.setItem('srv.selHist', r.id); afterPick() },
        }
      })
  }
  return state.servers
    .filter((s) => !q || `${s.id} ${s.host} ${s.username}`.toLowerCase().includes(q))
    .filter((s) => {
      if (state.srvStatus === 'any') return true
      const st = testMeta(s.id).state
      // keep rows visible while their check is in flight, so a Test all does
      // not empty the list out from under you
      return st === 'testing' || st === state.srvStatus
    })
    .map((s) => {
      const hops = (s.jumpChain || []).length
      return {
        key: s.id,
        active: state.selServer === s.id && !state.draft,
        dot: `lg ${testMeta(s.id).state}`,
        title: s.id,
        sub: `${s.username}@${s.host}:${s.port}`,
        meta: hops ? (hops === 1 ? '1 hop' : `${hops} hops`) : 'direct',
        badge: '',
        pick: () => {
          state.selServer = s.id
          localStorage.setItem('srv.selServer', s.id)
          state.draft = false
          syncForm(s.id)
          afterPick()
        },
      }
    })
}

function afterPick() {
  el.app.dataset.pane = 'detail'
  renderList()
  renderDetail()
}

const SRV_STATUS_TEXT = { online: 'online', offline: 'offline', untested: 'still untested' }

function emptyListText() {
  if (state.query.trim()) return `Nothing matches “${h(state.query.trim())}”.`
  // An empty list caused by a filter must not read like an empty registry.
  if (state.view === 'servers' && state.srvStatus !== 'any') {
    return `No servers are ${SRV_STATUS_TEXT[state.srvStatus]}.`
  }
  if (state.view === 'history' && state.histStatus !== 'any') {
    return 'No runs match that outcome.'
  }
  if (state.view === 'live') return 'Nothing running right now.'
  if (state.view === 'history') return state.historyLoaded ? 'No runs recorded yet.' : 'Loading…'
  return 'No servers registered yet.'
}

function renderList() {
  const rows = buildRows()

  // keep a valid selection so the detail pane always has something to show
  if (state.view === 'live') {
    if (!rows.some((r) => r.key === state.selRun)) state.selRun = rows.length ? rows[0].key : null
  } else if (state.view === 'history') {
    if (!rows.some((r) => r.key === state.selHist)) state.selHist = rows.length ? rows[0].key : null
  } else if (!state.draft) {
    if (!rows.some((r) => r.key === state.selServer)) {
      state.selServer = rows.length ? rows[0].key : null
      if (state.selServer) syncForm(state.selServer)
    }
  }

  const scroll = el.listScroll.scrollTop
  if (!rows.length) {
    el.listRows.innerHTML = `<div class="list-empty">${emptyListText()}</div>`
    el.listScroll.scrollTop = 0
  } else {
    el.listRows.innerHTML = rows.map((r) => `
      <button type="button" class="row${r.active ? ' active' : ''}" data-key="${h(r.key)}">
        <span class="row-dot ${r.dot}"></span>
        <span class="row-main">
          <span class="row-top">
            <span class="row-title">${h(r.title)}</span>
            ${r.badge}
          </span>
          <span class="row-sub">${h(r.sub)}</span>
        </span>
        <span class="row-meta"${r.live ? ` data-elapsed="${r.startedAt}"` : ''}>${h(r.meta)}</span>
      </button>`).join('')
    el.listScroll.scrollTop = scroll
    const byKey = new Map(rows.map((r) => [r.key, r]))
    el.listRows.querySelectorAll('.row').forEach((node) => {
      node.addEventListener('click', () => {
        const row = byKey.get(node.dataset.key)
        if (row) row.pick()
      })
    })
  }
  renderListMore()
  renderTabs()
  renderTallies()
}

/** "Load older runs" footer — history is paged, so older runs stay reachable. */
function renderListMore() {
  const more = state.view === 'history' && state.history.length < state.historyTotal
  el.listMore.hidden = !more
  if (more) {
    el.listMoreNote.textContent = `showing ${state.history.length} of ${state.historyTotal}`
  }
}

// ---------- detail ----------

function emptyState(title, body) {
  return `<div class="empty-state"><div>
    <svg class="empty-zigzag" width="120" height="12" viewBox="0 0 120 12" aria-hidden="true"><path d="M0 10 L12 2 L24 10 L36 2 L48 10 L60 2 L72 10 L84 2 L96 10 L108 2 L120 10" fill="none" stroke="#E8A33D" stroke-width="2"></path></svg>
    <h2 class="empty-title">${h(title)}</h2>
    <p class="empty-body">${h(body)}</p>
  </div></div>`
}

function renderDetail() {
  term = { key: null, container: null, rows: [], stick: true }
  el.detailPane.scrollTop = 0

  if (state.view === 'live') {
    const run = state.selRun ? state.live.get(state.selRun) : null
    if (!run) {
      el.detail.innerHTML = emptyState('Nothing running', 'Runs appear the moment an agent opens a session on one of your servers.')
      return
    }
    const b = liveBadge(run)
    renderRunDetail({
      key: run.requestId,
      badge: b,
      id: run.requestId,
      serverId: run.serverId,
      stampLine: run.done
        ? (run.error ? `Failed · ${run.error}` : 'Finished · kept here for 30s, then History')
        : 'Streaming from the daemon',
      agentLabel: run.agentLabel,
      kindLabel: run.command ? 'Single exec' : 'Interactive session',
      addr: addrOf(run.serverId),
      timeLabel: run.done ? 'Ran for' : 'Elapsed',
      timeValue: fmtElapsed(run.startedAt),
      liveElapsed: !run.done ? run.startedAt : null,
      command: run.command,
      lines: run.lines,
      live: true,
    })
    return
  }

  if (state.view === 'history') {
    const r = state.selHist ? state.history.find((x) => x.id === state.selHist) : null
    if (!r) {
      el.detail.innerHTML = emptyState('No run selected', 'Pick a run on the left to read its output.')
      return
    }
    const duration = fmtDuration(r.startedAt, r.endedAt)
    const cached = state.runOutputs.get(r.id)
    renderRunDetail({
      key: r.id,
      badge: histBadge(r),
      id: r.id,
      serverId: r.serverId,
      stampLine: `${fmtStamp(r.startedAt)}${duration ? ` · ${duration}` : ''}`,
      agentLabel: r.agentLabel,
      kindLabel: r.kind === 'session' ? 'Interactive session' : 'Single exec',
      addr: addrOf(r.serverId),
      timeLabel: r.endedAt == null ? 'Started' : 'Finished',
      timeValue: r.endedAt == null ? relTime(r.startedAt) : `${relTime(r.startedAt)}${duration ? ` · ${duration}` : ''}`,
      liveElapsed: null,
      command: r.command,
      lines: cached ? historyLines(cached) : [],
      live: false,
      outputBytes: r.outputBytes,
      truncated: r.truncated,
      pendingOutput: !cached && r.hasOutput,
    })

    if (!cached && r.hasOutput) {
      const wanted = r.id
      loadRunOutput(r.id)
        .then((run) => {
          // the user may have picked another run while this was in flight
          if (state.view !== 'history' || state.selHist !== wanted || term.key !== wanted) return
          paintTerm(historyLines(run))
        })
        .catch((err) => {
          if (term.key !== wanted || !term.container) return
          term.container.innerHTML = ''
          const note = document.createElement('div')
          note.className = 'term-loading'
          note.textContent = err.message
          term.container.appendChild(note)
        })
    }
    return
  }

  renderServerDetail()
}

function renderRunDetail(d) {
  const hasErr = d.lines.some((l) => l.stream === 'err')
  el.detail.innerHTML = `
    <div>
      <div class="run-head">
        <span class="chip ${d.badge.tone}">${h(d.badge.label)}</span>
        <span class="run-id">${h(d.id)}</span>
      </div>
      <h2 class="detail-h2">${h(d.serverId)}</h2>
      <p class="detail-lead">${h(d.stampLine)}</p>
      <div class="factgrid">
        <div class="fact"><div class="fact-label">Agent</div><div class="fact-value">${h(d.agentLabel)}</div></div>
        <div class="fact"><div class="fact-label">Mode</div><div class="fact-value">${h(d.kindLabel)}</div></div>
        <div class="fact"><div class="fact-label">Target</div><div class="fact-value mono">${h(d.addr)}</div></div>
        <div class="fact"><div class="fact-label">${h(d.timeLabel)}</div><div class="fact-value strong"${d.liveElapsed ? ` data-elapsed="${d.liveElapsed}"` : ''}>${h(d.timeValue)}</div></div>
      </div>
      <div class="cmdbar">
        <span class="cmd-label">Command</span>
        <code class="cmd-code">${h(d.command || '— none; the agent is driving an interactive shell')}</code>
      </div>
      <div class="outbar">
        <span class="out-label">Output</span>
        ${d.outputBytes ? `<span class="out-size">${h(fmtBytes(d.outputBytes))}</span>` : ''}
        ${hasErr ? `
        <span class="legend"><span class="legend-swatch"></span>stdout</span>
        <span class="legend"><span class="legend-swatch err"></span>stderr</span>` : ''}
        <button type="button" class="btn-copy" id="copy-output">${icon(ICON.copy, 13)} Copy</button>
      </div>
      ${d.truncated ? `<div class="term-notice">
        ${icon('<circle cx="12" cy="12" r="10"></circle><path d="M12 8v4M12 16h.01"></path>', 15)}
        <span>This run produced ${h(fmtBytes(d.outputBytes))}. The first and last 128 KB are kept; the middle was elided so the audit log stays usable.</span>
      </div>` : ''}
      <div class="term facet-14" id="term"></div>
    </div>`

  term = { key: d.key, container: document.getElementById('term'), rows: [], stick: true }
  if (d.pendingOutput) {
    const note = document.createElement('div')
    note.className = 'term-loading'
    note.textContent = 'loading output…'
    term.container.appendChild(note)
  } else {
    paintTerm(d.lines)
  }

  term.container.addEventListener('scroll', () => {
    const c = term.container
    term.stick = c.scrollHeight - c.scrollTop - c.clientHeight < 24
  })

  document.getElementById('copy-output').addEventListener('click', async () => {
    let lines = d.lines
    if (!lines.length && d.pendingOutput) {
      try {
        lines = historyLines(await loadRunOutput(d.id))
      } catch (err) {
        toast(err.message, 'fail')
        return
      }
    }
    try {
      await navigator.clipboard.writeText(lines.map((l) => l.text).join('\n'))
      toast(`Output of ${d.id} copied to clipboard`, 'ok')
    } catch {
      toast('Could not copy — clipboard access denied.', 'fail')
    }
  })
}

function termRow(line, n) {
  const row = document.createElement('div')
  row.className = `term-line${line.stream === 'err' ? ' err' : ''}`
  const num = document.createElement('span')
  num.className = 'term-n'
  num.textContent = String(n)
  const txt = document.createElement('span')
  txt.className = 'term-text'
  txt.textContent = line.text
  row.appendChild(num)
  row.appendChild(txt)
  return row
}

function paintTerm(lines) {
  if (!term.container) return
  term.container.innerHTML = ''
  term.rows = []
  if (!lines.length) {
    const empty = document.createElement('div')
    empty.className = 'term-empty'
    empty.textContent = 'no output yet'
    term.container.appendChild(empty)
    return
  }
  const frag = document.createDocumentFragment()
  lines.forEach((l, i) => {
    const row = termRow(l, i + 1)
    term.rows.push(row)
    frag.appendChild(row)
  })
  term.container.appendChild(frag)
  term.container.scrollTop = term.container.scrollHeight
}

function applyTermOps(run, ops) {
  if (!term.container || term.key !== run.requestId) return
  if (ops.some((o) => o.type === 'rebuild')) {
    paintTerm(run.lines)
    return
  }
  if (!term.rows.length && run.lines.length) {
    paintTerm(run.lines)
  } else {
    for (const op of ops) {
      if (op.type === 'append') {
        const row = termRow(run.lines[op.idx], op.idx + 1)
        term.rows.push(row)
        term.container.appendChild(row)
      } else {
        const row = term.rows[op.idx]
        if (row) row.lastChild.textContent = run.lines[op.idx].text
        else paintTerm(run.lines)
      }
    }
  }
  if (term.stick) term.container.scrollTop = term.container.scrollHeight
}

// ---------- servers detail ----------

function syncForm(id) {
  const s = serverById(id)
  state.formError = null
  state.testResult = null
  if (!s) { state.form = blankForm(); return }
  state.form = {
    id: s.id,
    host: s.host,
    port: String(s.port),
    username: s.username,
    authMethod: s.authMethod,
    secret: s.authMethod === 'key' ? (s.keyPath || '') : '',
    hops: (s.jumpChain || []).slice(),
  }
}

function pathPreview() {
  const target = formTargetId()
  const hops = state.form.hops.filter(Boolean)
  if (!hops.length) return { text: `you  →  ${target}`, bad: false }
  try {
    const path = resolveJumpPathLocal(state.draft ? target : (state.selServer || target), hops)
    const display = [...path.slice(0, -1), target]
    return { text: ['you', ...display].join('  →  '), bad: false }
  } catch (err) {
    return { text: `Cycle detected: ${err.message}`, bad: true }
  }
}

function renderServerDetail() {
  if (!state.draft && !state.selServer) {
    el.detail.innerHTML = state.servers.length
      ? emptyState('No server selected', 'Pick a server on the left to see its record.')
      : emptyState('No servers yet', 'Register a server to give an agent an id it can run commands against.')
    return
  }

  const s = state.draft ? null : serverById(state.selServer)
  if (!state.draft && !s) {
    el.detail.innerHTML = emptyState('No server selected', 'Pick a server on the left to see its record.')
    return
  }

  const t = state.draft ? { state: 'untested', label: 'not tested', tone: 'untested', error: null } : testMeta(s.id)
  const f = state.form
  const isKey = f.authMethod === 'key'
  if (s && !state.serverRuns.has(s.id)) loadServerRuns(s.id)
  const pp = pathPreview()

  el.detail.innerHTML = `
    <div>
      <div class="srv-head">
        <span class="srv-dot ${t.state}"></span>
        <h2 class="detail-h2 mono">${h(state.draft ? 'new server' : s.id)}</h2>
        <span class="chip ${t.tone}">${h(t.label)}</span>
        ${t.at ? `<span class="srv-checked">checked ${h(relTime(t.at))}</span>` : ''}
        ${state.draft ? '' : `<button type="button" class="btn-plain" id="srv-test"${t.state === 'testing' ? ' disabled' : ''}>${t.state === 'testing' ? 'Testing…' : 'Test'}</button>`}
        ${state.draft
          ? '<button type="button" class="btn-del" id="srv-discard">Discard</button>'
          : '<button type="button" class="btn-del" id="srv-delete">Delete</button>'}
      </div>
      <p class="detail-lead wide">Agents only ever see this id. Everything below stays on this machine.</p>

      ${t.error ? `<div class="alert facet-14">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#B3372B" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><path d="M12 8v4M12 16h.01"></path></svg>
        <span class="alert-text">${h(t.error)}</span>
      </div>` : ''}

      <div class="record">
        <div class="factgrid wide">
          <div class="fact"><div class="fact-label">Address</div><div class="fact-value mono">${h(state.draft ? '—' : `${s.username}@${s.host}:${s.port}`)}</div></div>
          <div class="fact"><div class="fact-label">Registered</div><div class="fact-value mono">${h(state.draft ? '—' : fmtDate(s.createdAt))}</div></div>
          <div class="fact"><div class="fact-label">Last edited</div><div class="fact-value mono">${h(state.draft ? '—' : fmtDate(s.updatedAt))}</div></div>
        </div>
        <div class="record-fp">
          <div class="fact-label">Host key fingerprint</div>
          <div class="record-fp-value">${h(state.draft || !s.hostKeyFingerprint ? 'Recorded on first successful connection' : s.hostKeyFingerprint)}</div>
        </div>
      </div>

      <div class="section-rule">
        <span class="section-label">Connection</span>
        <span class="rule"></span>
        <span class="section-note">Edits save to the daemon on submit</span>
      </div>

      <div class="editwrap">
        <div class="editshadow" aria-hidden="true"></div>
        <div class="editcard">
          ${state.draft ? `
          <div class="fieldrow one">
            <label class="field">
              <span class="field-label">Server id</span>
              <input class="input" id="f-id" value="${h(f.id)}" placeholder="srv-c3" autocomplete="off" spellcheck="false" />
            </label>
          </div>` : ''}
          <div class="fieldrow three">
            <label class="field">
              <span class="field-label">Host</span>
              <input class="input" id="f-host" value="${h(f.host)}" placeholder="10.0.0.4" autocomplete="off" spellcheck="false" />
            </label>
            <label class="field">
              <span class="field-label">Port</span>
              <input class="input" id="f-port" value="${h(f.port)}" inputmode="numeric" autocomplete="off" />
            </label>
            <label class="field">
              <span class="field-label">Username</span>
              <input class="input" id="f-user" value="${h(f.username)}" placeholder="deploy" autocomplete="off" spellcheck="false" />
            </label>
          </div>
          <div class="fieldrow two">
            <label class="field">
              <span class="field-label">Auth method</span>
              <select class="select" id="f-auth">
                <option value="key"${isKey ? ' selected' : ''}>Private key</option>
                <option value="password"${isKey ? '' : ' selected'}>Password</option>
              </select>
            </label>
            <label class="field">
              <span class="field-label" id="f-secret-label">${isKey ? 'Key path' : 'Password'}</span>
              <input class="input" id="f-secret" value="${h(f.secret)}" type="${isKey ? 'text' : 'password'}"
                placeholder="${isKey ? '~/.ssh/id_ed25519' : '••••••••'}" autocomplete="${isKey ? 'off' : 'new-password'}" spellcheck="false" />
            </label>
          </div>

          <div class="hops-head">
            <span class="section-label">Via jump hosts</span>
            <button type="button" class="btn-hop" id="add-hop">${icon(ICON.plus, 12)} Add hop</button>
          </div>
          <div id="hops"></div>
          <div class="pathpreview${pp.bad ? ' bad' : ''}" id="path-preview">${h(pp.text)}</div>

          ${state.testResult ? `<div class="testbox ${state.testResult.state === 'ok' ? 'ok' : state.testResult.state === 'fail' ? 'fail' : ''}">
            <span>${h(state.testResult.text)}</span>
          </div>` : ''}
          ${state.formError ? `<div class="form-error"><span>${h(state.formError)}</span></div>` : ''}

          <div class="editactions">
            <button type="button" class="btn-test-conn" id="f-test">${icon(ICON.zap, 15)} Test connection</button>
            <span class="spacer"></span>
            ${state.draft ? '<button type="button" class="btn-ghost" id="f-cancel">Discard</button>' : ''}
            <button type="button" class="btn-primary facet-8" id="f-submit">${state.draft ? 'Register server' : 'Save changes'}</button>
          </div>
        </div>
      </div>

      ${state.draft ? '' : `
      <div class="section-rule">
        <span class="section-label">Recent runs on this server</span>
        <span class="rule"></span>
      </div>
      <div id="srv-runs"></div>`}
    </div>`

  renderHops()
  renderServerRuns()
  wireServerDetail()
}

function renderServerRuns() {
  const box = document.getElementById('srv-runs')
  if (!box) return
  const id = state.selServer
  const runs = state.serverRuns.get(id)
  if (!runs) {
    box.innerHTML = '<div class="runs-none">Loading…</div>'
    return
  }
  if (!runs.length) {
    box.innerHTML = '<div class="runs-none">No runs recorded against this id yet.</div>'
    return
  }
  box.innerHTML = runs.map((r) => {
    const b = histBadge(r)
    return `<button type="button" class="runs-row" data-run="${h(r.id)}">
      <span class="chip ${b.tone}">${h(b.label)}</span>
      <code class="runs-row-cmd">${h(r.command || 'interactive session')}</code>
      <span class="runs-row-rel">${h(relTime(r.startedAt))}</span>
    </button>`
  }).join('')
  box.querySelectorAll('.runs-row').forEach((btn) => {
    btn.addEventListener('click', () => openHistoryRun(btn.dataset.run))
  })
}

/**
 * Jumps to a run in History. The run may be older than the loaded page, so its
 * metadata is fetched and prepended when missing.
 */
async function openHistoryRun(runId) {
  state.selHist = runId
  localStorage.setItem('srv.selHist', runId)
  if (!state.history.some((r) => r.id === runId)) {
    try {
      const run = await loadRunOutput(runId)
      state.history.unshift({
        id: run.id, serverId: run.serverId, agentLabel: run.agentLabel, kind: run.kind,
        command: run.command, exitCode: run.exitCode, startedAt: run.startedAt, endedAt: run.endedAt,
        outputBytes: run.outputBytes, truncated: run.truncated, hasOutput: (run.output || '').length > 0,
      })
    } catch { /* fall through: History will just auto-select its first row */ }
  }
  switchView('history')
  el.app.dataset.pane = 'detail'
  renderList()
  renderDetail()
}

function renderHops() {
  const box = document.getElementById('hops')
  if (!box) return
  box.innerHTML = state.form.hops.map((val, idx) => {
    const opts = hopChoices(idx)
    const known = opts.some((o) => o.id === val)
    return `<div class="hop">
      <span class="hop-n">${idx + 1}</span>
      <select class="hop-select" data-idx="${idx}">
        ${known ? '' : `<option value="${h(val)}" selected>${h(val)}</option>`}
        ${opts.map((o) => `<option value="${h(o.id)}"${o.id === val ? ' selected' : ''}>${h(o.id)}</option>`).join('')}
      </select>
      <button type="button" class="hop-remove" data-idx="${idx}" title="Remove hop" aria-label="Remove hop ${idx + 1}">${icon(ICON.x, 13)}</button>
    </div>`
  }).join('')

  box.querySelectorAll('.hop-select').forEach((sel) => {
    sel.addEventListener('change', () => {
      state.form.hops[Number(sel.dataset.idx)] = sel.value
      renderHops()
      updatePathPreview()
    })
  })
  box.querySelectorAll('.hop-remove').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.form.hops.splice(Number(btn.dataset.idx), 1)
      renderHops()
      updatePathPreview()
    })
  })

  const add = document.getElementById('add-hop')
  if (add) add.disabled = hopChoices(state.form.hops.length).length === 0
}

function updatePathPreview() {
  const node = document.getElementById('path-preview')
  if (!node) return
  const pp = pathPreview()
  node.textContent = pp.text
  node.classList.toggle('bad', pp.bad)
}

function wireServerDetail() {
  const on = (id, ev, fn) => {
    const node = document.getElementById(id)
    if (node) node.addEventListener(ev, fn)
  }

  on('f-id', 'input', (e) => { state.form.id = e.target.value; updatePathPreview(); renderHops() })
  on('f-host', 'input', (e) => { state.form.host = e.target.value })
  on('f-port', 'input', (e) => { state.form.port = e.target.value })
  on('f-user', 'input', (e) => { state.form.username = e.target.value })
  on('f-secret', 'input', (e) => { state.form.secret = e.target.value })

  on('f-auth', 'change', (e) => {
    state.form.authMethod = e.target.value
    const isKey = state.form.authMethod === 'key'
    state.form.secret = isKey && !state.draft ? ((serverById(state.selServer) || {}).keyPath || '') : ''
    const label = document.getElementById('f-secret-label')
    const input = document.getElementById('f-secret')
    if (label) label.textContent = isKey ? 'Key path' : 'Password'
    if (input) {
      input.type = isKey ? 'text' : 'password'
      input.placeholder = isKey ? '~/.ssh/id_ed25519' : '••••••••'
      input.autocomplete = isKey ? 'off' : 'new-password'
      input.value = state.form.secret
    }
  })

  on('add-hop', 'click', () => {
    const opts = hopChoices(state.form.hops.length)
    if (!opts.length) return
    state.form.hops.push(opts[0].id)
    renderHops()
    updatePathPreview()
  })

  on('srv-test', 'click', () => testServer(state.selServer))
  on('srv-delete', 'click', () => openConfirm(state.selServer))
  on('srv-discard', 'click', discardDraft)
  on('f-cancel', 'click', discardDraft)
  on('f-test', 'click', testFormConnection)
  on('f-submit', 'click', submitForm)

}

function discardDraft() {
  state.draft = false
  state.formError = null
  state.testResult = null
  if (state.selServer) syncForm(state.selServer)
  renderList()
  renderDetail()
}

function startDraft() {
  state.draft = true
  state.form = blankForm()
  state.formError = null
  state.testResult = null
  el.app.dataset.pane = 'detail'
  renderList()
  renderDetail()
  const idInput = document.getElementById('f-id')
  if (idInput) idInput.focus()
}

// ---------- form payload / submit ----------

function formPayload() {
  const f = state.form
  const payload = {
    id: (state.draft ? f.id : state.selServer || '').trim(),
    host: f.host.trim(),
    port: Number(f.port),
    username: f.username.trim(),
    authMethod: f.authMethod,
    jumpChain: f.hops.filter(Boolean),
  }
  if (f.authMethod === 'key') {
    payload.keyPath = f.secret.trim()
    payload.secret = ''
  } else {
    payload.secret = f.secret
  }
  return payload
}

function validateLocally(payload) {
  if (!payload.id) return 'A server id is required.'
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(payload.id)) return 'Server id may only contain letters, numbers, dot, dash and underscore.'
  if (!payload.host) return 'A host is required.'
  if (!Number.isInteger(payload.port) || payload.port < 1 || payload.port > 65535) return 'Port must be a whole number between 1 and 65535.'
  if (!payload.username) return 'A username is required.'
  if (payload.authMethod === 'key' && !payload.keyPath) return 'A key path is required for private-key auth.'
  if (payload.authMethod === 'password' && state.draft && !payload.secret) return 'A password is required.'
  if (pathPreview().bad) return 'Resolve the jump-host cycle before saving.'
  return null
}

async function submitForm() {
  const payload = formPayload()
  payload.isEdit = !state.draft
  const problem = validateLocally(payload)
  if (problem) {
    state.formError = problem
    renderDetail()
    return
  }
  const btn = document.getElementById('f-submit')
  if (btn) { btn.disabled = true; btn.textContent = state.draft ? 'Registering…' : 'Saving…' }

  let res
  try {
    res = await fetch('/api/servers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    })
  } catch (err) {
    state.formError = `Request failed: ${err.message}`
    renderDetail()
    return
  }
  if (!res.ok) {
    let message = `Request failed (${res.status})`
    try { const body = await res.json(); if (body && body.error) message = body.error } catch { /* keep status */ }
    state.formError = message
    renderDetail()
    return
  }
  const wasDraft = state.draft
  state.draft = false
  state.formError = null
  state.testResult = null
  state.selServer = payload.id
  localStorage.setItem('srv.selServer', payload.id)
  await loadServers()
  syncForm(payload.id)
  renderList()
  renderDetail()
  toast(wasDraft ? 'Server registered' : `${payload.id} updated`, 'ok')
}

async function testFormConnection() {
  const payload = formPayload()
  const problem = validateLocally(payload)
  if (problem) {
    state.formError = problem
    renderDetail()
    return
  }
  state.formError = null
  state.testResult = { state: 'pending', text: 'Opening connection…' }
  renderDetail()
  const btn = document.getElementById('f-test')
  if (btn) btn.disabled = true

  try {
    const res = await fetch('/api/servers/test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      state.testResult = { state: 'fail', text: body.error || `Request failed (${res.status})` }
    } else if (body.ok) {
      state.testResult = { state: 'ok', text: 'Connection succeeded' }
    } else {
      state.testResult = { state: 'fail', text: body.error || 'Connection failed' }
    }
  } catch (err) {
    state.testResult = { state: 'fail', text: `Request failed: ${err.message}` }
  }
  renderDetail()
}

// ---------- connection tests ----------

async function testServer(id) {
  if (!id) return
  state.tests.set(id, { state: 'testing' })
  renderList()
  if (state.view === 'servers') renderDetail()
  try {
    const res = await fetch(`/api/servers/${encodeURIComponent(id)}/test`, { method: 'POST' })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body.error || `request failed (${res.status})`)
    state.tests.set(id, body.ok ? { state: 'online', at: Date.now() } : { state: 'offline', error: body.error, at: Date.now() })
  } catch (err) {
    state.tests.set(id, { state: 'offline', error: err.message, at: Date.now() })
  }
  renderList()
  if (state.view === 'servers') renderDetail()
}

async function testAllServers() {
  if (!state.servers.length) return
  const ids = state.servers.map((s) => s.id)
  ids.forEach((id) => state.tests.set(id, { state: 'testing' }))
  el.testAll.disabled = true
  renderList()
  if (state.view === 'servers') renderDetail()
  try {
    const res = await fetch('/api/servers/test-all', { method: 'POST' })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.error || `request failed (${res.status})`)
    }
    toast(`Testing ${ids.length} server${ids.length === 1 ? '' : 's'}…`)
    // Results arrive over the WebSocket. If it drops mid-test they never do,
    // so clear anything still pending well past the daemon's own timeout.
    setTimeout(() => {
      const stuck = ids.filter((id) => (state.tests.get(id) || {}).state === 'testing')
      el.testAll.disabled = false
      if (!stuck.length) return
      stuck.forEach((id) => state.tests.delete(id))
      renderList()
      if (state.view === 'servers') renderDetail()
      toast(`${stuck.length} server${stuck.length === 1 ? '' : 's'} didn't report back — the daemon connection may have dropped.`, 'fail')
    }, TEST_ALL_STUCK_TIMEOUT_MS)
  } catch (err) {
    ids.forEach((id) => state.tests.delete(id))
    el.testAll.disabled = false
    renderList()
    if (state.view === 'servers') renderDetail()
    toast(`Could not start test-all: ${err.message}`, 'fail')
  }
}

// ---------- delete ----------

let pendingDelete = null

function openConfirm(id) {
  if (!id) return
  pendingDelete = id
  el.confirmTitle.textContent = `Delete ${id}?`
  el.confirmOverlay.hidden = false
  document.getElementById('confirm-ok').focus()
}

function closeConfirm() {
  pendingDelete = null
  el.confirmOverlay.hidden = true
}

async function doDelete() {
  const id = pendingDelete
  closeConfirm()
  if (!id) return
  try {
    const res = await fetch(`/api/servers/${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (!res.ok) throw new Error(`request failed (${res.status})`)
  } catch (err) {
    toast(`Failed to delete ${id}: ${err.message}`, 'fail')
    return
  }
  if (state.selServer === id) {
    state.selServer = null
    localStorage.removeItem('srv.selServer')
  }
  await loadServers()
  renderList()
  renderDetail()
  toast(`${id} deleted`)
}

// ---------- bulk import ----------

async function doImport() {
  const raw = el.importText.value
  el.importText.classList.remove('invalid')
  let servers
  try {
    servers = JSON.parse(raw)
  } catch (err) {
    el.importText.classList.add('invalid')
    toast(`Invalid JSON: ${err.message}`, 'fail')
    return
  }
  if (!Array.isArray(servers)) {
    el.importText.classList.add('invalid')
    toast('Expected a JSON array of server objects.', 'fail')
    return
  }

  let result
  try {
    const res = await fetch('/api/servers/bulk', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ servers }),
    })
    result = await res.json().catch(() => null)
    if (!result) throw new Error(`import failed (${res.status})`)
    if (!res.ok) throw new Error(result.error || `import failed (${res.status})`)
  } catch (err) {
    toast(err.message, 'fail')
    return
  }

  if (result.failed && result.failed.length) {
    const first = result.failed[0]
    const extra = result.failed.length > 1 ? ` (+${result.failed.length - 1} more)` : ''
    toast(`${result.succeeded.length} imported · ${result.failed.length} rejected — ${first.id || '?'}: ${first.error}${extra}`, 'fail')
  } else {
    toast(`${result.succeeded.length} server${result.succeeded.length === 1 ? '' : 's'} imported`, 'ok')
    el.importText.value = IMPORT_SAMPLE
  }
  await loadServers()
}

// ---------- command palette ----------

function buildPalette() {
  const q = state.paletteQuery.trim().toLowerCase()
  const rows = [
    { kind: 'view', label: 'Live activity', hint: '1', run: () => switchView('live') },
    { kind: 'view', label: 'History', hint: '2', run: () => switchView('history') },
    { kind: 'view', label: 'Servers', hint: '3', run: () => switchView('servers') },
    { kind: 'action', label: 'Register a server', hint: 'add', run: () => { switchView('servers'); startDraft() } },
  ].filter((r) => !q || r.label.toLowerCase().includes(q))

  state.servers.filter((s) => !q || s.id.toLowerCase().includes(q)).forEach((s) => {
    rows.push({
      kind: 'server',
      label: s.id,
      hint: `${s.username}@${s.host}`,
      run: () => {
        state.selServer = s.id
        localStorage.setItem('srv.selServer', s.id)
        state.draft = false
        syncForm(s.id)
        switchView('servers')
        el.app.dataset.pane = 'detail'
        renderList()
        renderDetail()
      },
    })
  })
  return rows
}

function renderPalette() {
  palRows = buildPalette()
  if (state.palIndex >= palRows.length) state.palIndex = 0
  if (!palRows.length) {
    el.paletteList.innerHTML = '<div class="pal-empty">No matches.</div>'
    return
  }
  el.paletteList.innerHTML = palRows.map((r, i) => `
    <button type="button" class="pal-row${i === state.palIndex ? ' active' : ''}" data-idx="${i}">
      <span class="pal-kind">${h(r.kind)}</span>
      <span class="pal-label">${h(r.label)}</span>
      <span class="pal-hint">${h(r.hint)}</span>
    </button>`).join('')
  el.paletteList.querySelectorAll('.pal-row').forEach((b) => {
    b.addEventListener('click', () => runPalette(Number(b.dataset.idx)))
  })
}

function openPalette() {
  state.paletteOpen = true
  state.paletteQuery = ''
  state.palIndex = 0
  el.paletteInput.value = ''
  el.paletteOverlay.hidden = false
  renderPalette()
  setTimeout(() => el.paletteInput.focus(), 20)
}

function closePalette() {
  state.paletteOpen = false
  el.paletteOverlay.hidden = true
}

function runPalette(idx) {
  const row = palRows[idx]
  if (!row) return
  closePalette()
  row.run()
}

function movePalette(delta) {
  if (!palRows.length) return
  state.palIndex = (state.palIndex + delta + palRows.length) % palRows.length
  el.paletteList.querySelectorAll('.pal-row').forEach((b, i) => b.classList.toggle('active', i === state.palIndex))
  const active = el.paletteList.querySelector('.pal-row.active')
  if (active) active.scrollIntoView({ block: 'nearest' })
}

// ---------- theme ----------

/* The inline script in index.html resolves the theme before first paint; this
   only handles switching and following the system while no explicit choice
   has been made. */
function currentTheme() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme
  el.themeToggle.setAttribute('aria-label', theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme')
  el.themeToggle.setAttribute('aria-pressed', String(theme === 'dark'))
}

function setupTheme() {
  applyTheme(currentTheme())
  el.themeToggle.addEventListener('click', () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark'
    localStorage.setItem('srv.theme', next)
    applyTheme(next)
  })
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  const follow = (e) => {
    if (localStorage.getItem('srv.theme')) return // user chose explicitly
    applyTheme(e.matches ? 'dark' : 'light')
  }
  if (mq.addEventListener) mq.addEventListener('change', follow)
  else if (mq.addListener) mq.addListener(follow)
}

// ---------- focus trap ----------

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function activeOverlay() {
  if (!el.paletteOverlay.hidden) return el.palette
  if (!el.confirmOverlay.hidden) return el.confirm
  return null
}

function trapFocus(container, e) {
  if (e.key !== 'Tab') return
  const items = [...container.querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null)
  if (!items.length) return
  const first = items[0]
  const last = items[items.length - 1]
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
}

// ---------- websocket ----------

let historyRefresh = null

function scheduleHistoryRefresh() {
  clearTimeout(historyRefresh)
  historyRefresh = setTimeout(loadHistory, 400)
}

function setConn(name) {
  el.conn.dataset.state = name
  el.conn.querySelector('.conn-label').textContent =
    name === 'connected' ? 'Daemon connected' : name === 'connecting' ? 'Connecting…' : 'Daemon unreachable'
}

function finishRun(run, exitCode, error) {
  if (run.done) return
  run.done = true
  run.exitCode = exitCode
  run.error = error || null
  run.open = null
  setTimeout(() => {
    // Capture this before renderList(), which reassigns selRun once the run
    // leaves the list — otherwise the detail pane keeps showing a dropped run.
    const wasSelected = state.selRun === run.requestId
    state.live.delete(run.requestId)
    if (state.view === 'live') {
      renderList()
      if (wasSelected) renderDetail()
    }
    renderTabs()
  }, LIVE_GRACE_MS)
}

function connectSocket() {
  setConn('connecting')
  let ws
  try {
    ws = new WebSocket(`ws://${location.host}/api/live`)
  } catch {
    setTimeout(connectSocket, 2000)
    return
  }

  ws.onopen = () => setConn('connected')
  ws.onclose = () => { setConn('disconnected'); setTimeout(connectSocket, 2000) }
  ws.onerror = () => ws.close()

  ws.onmessage = (event) => {
    let msg
    try { msg = JSON.parse(event.data) } catch { return }

    if (msg.type === 'stream') {
      let run = state.live.get(msg.requestId)
      const isNew = !run
      if (!run) {
        run = newRun(msg.requestId, msg)
        state.live.set(msg.requestId, run)
      }
      if (!run.command && msg.command) run.command = msg.command
      const ops = ingest(run, msg.stream === 'stderr' ? 'err' : 'out', msg.chunk || '')
      if (isNew) {
        if (state.view === 'live') {
          const hadSelection = state.selRun && state.live.has(state.selRun)
          renderList()
          if (!hadSelection || state.selRun === msg.requestId) renderDetail()
        } else {
          renderTabs()
        }
      } else if (state.view === 'live' && state.selRun === msg.requestId) {
        applyTermOps(run, ops)
      }
      return
    }

    if (msg.type === 'done') {
      let run = state.live.get(msg.requestId)
      if (!run) {
        run = newRun(msg.requestId, msg)
        state.live.set(msg.requestId, run)
        finishRun(run, msg.exitCode, msg.error)
        if (state.view === 'live') { renderList(); renderDetail() } else renderTabs()
      } else {
        finishRun(run, msg.exitCode, msg.error)
        if (state.view === 'live') {
          renderList()
          if (state.selRun === msg.requestId) renderDetail()
        } else {
          renderTabs()
        }
      }
      scheduleHistoryRefresh()
      return
    }

    if (msg.type === 'server_test_result') {
      const at = msg.at || Date.now()
      state.tests.set(msg.id, msg.ok ? { state: 'online', at } : { state: 'offline', error: msg.error, at })
      // Re-enable "Test all" as soon as the last result lands, rather than
      // making the user wait out the stuck-result fallback.
      if (![...state.tests.values()].some((t) => t.state === 'testing')) el.testAll.disabled = false
      renderList()
      if (state.view === 'servers') renderDetail()
    }
  }
}

// ---------- ticking clocks ----------

setInterval(() => {
  document.querySelectorAll('[data-elapsed]').forEach((node) => {
    node.textContent = fmtElapsed(Number(node.dataset.elapsed))
  })
}, 1000)

// ---------- static wiring ----------

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    // Re-tapping the active tab returns to the list. Without this you can get
    // stranded in the detail pane on a single-column layout.
    if (state.view === tab.dataset.view) el.app.dataset.pane = 'list'
    else switchView(tab.dataset.view)
  })
})

el.search.addEventListener('input', (e) => { state.query = e.target.value; renderList() })
el.histStatus.addEventListener('change', (e) => { state.histStatus = e.target.value; renderList(); renderDetail() })
el.srvStatus.addEventListener('change', (e) => { state.srvStatus = e.target.value; renderList(); renderTallies() })
el.loadMore.addEventListener('click', async () => {
  el.loadMore.disabled = true
  el.loadMore.textContent = 'Loading…'
  await loadHistory({ append: true })
  el.loadMore.disabled = false
  el.loadMore.textContent = 'Load older runs'
})
el.testAll.addEventListener('click', testAllServers)
el.addServer.addEventListener('click', startDraft)
el.paneBack.addEventListener('click', () => { el.app.dataset.pane = 'list' })

el.importToggle.addEventListener('click', () => {
  state.importOpen = !state.importOpen
  el.importBlock.classList.toggle('open', state.importOpen)
  el.importBody.hidden = !state.importOpen
  el.importToggle.setAttribute('aria-expanded', String(state.importOpen))
  if (state.importOpen && !el.importText.value) el.importText.value = IMPORT_SAMPLE
})
document.getElementById('import-submit').addEventListener('click', doImport)

document.getElementById('open-palette').addEventListener('click', openPalette)
el.paletteScrim.addEventListener('click', closePalette)
el.paletteInput.addEventListener('input', (e) => {
  state.paletteQuery = e.target.value
  state.palIndex = 0
  renderPalette()
})
el.paletteInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); movePalette(1) }
  else if (e.key === 'ArrowUp') { e.preventDefault(); movePalette(-1) }
  else if (e.key === 'Enter') { e.preventDefault(); runPalette(state.palIndex) }
})

document.getElementById('confirm-ok').addEventListener('click', doDelete)
document.getElementById('confirm-cancel').addEventListener('click', closeConfirm)
el.confirmScrim.addEventListener('click', closeConfirm)

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    if (state.paletteOpen) closePalette()
    else openPalette()
    return
  }
  if (e.key === 'Escape') {
    if (state.paletteOpen) closePalette()
    else if (!el.confirmOverlay.hidden) closeConfirm()
    else if (state.draft) discardDraft()
    return
  }
  const overlay = activeOverlay()
  if (overlay) { trapFocus(overlay, e); return }
  const tag = (document.activeElement && document.activeElement.tagName) || ''
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (document.activeElement && document.activeElement.isContentEditable)) return
  if (e.key === '1') switchView('live')
  else if (e.key === '2') switchView('history')
  else if (e.key === '3') switchView('servers')
})

// ---------- boot ----------

el.app.dataset.view = state.view
el.importText.value = IMPORT_SAMPLE
setupTheme()
renderChrome()
renderList()
renderDetail()
connectSocket()
loadServers().then(() => {
  if (state.view === 'servers' && state.selServer) syncForm(state.selServer)
  renderList()
  renderDetail()
})
loadHistory()
