import express from 'express'
import cookieParser from 'cookie-parser'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = process.env.PORT || 3000

const ADMIN_USER = 'admin'
const ADMIN_PASS = 'adminferry'

// --- Stores ---
const accessKeys = new Map()   // key -> { label, createdAt, expiresAt, expiryType, active, voteCount }
const adminSessions = new Map()

// Default unlimited key
accessKeys.set('PUTU', {
  label: 'Default (Putu)',
  createdAt: Date.now(),
  expiresAt: Date.now() + 1000 * 60 * 60 * 24 * 365 * 10, // 10 years
  expiryType: 'unlimited',
  active: true,
  voteCount: 0,
})

app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(cookieParser())

// --- Helpers ---
function genKey() { return randomBytes(4).toString('hex').toUpperCase() }

function isKeyValid(key) {
  if (!key || !accessKeys.has(key)) return false
  const e = accessKeys.get(key)
  if (!e.active) return false
  if (Date.now() > e.expiresAt) return false
  return true
}

function isAdmin(req) {
  const sid = req.cookies?.admin_session
  if (!sid || !adminSessions.has(sid)) return false
  const s = adminSessions.get(sid)
  if (Date.now() > s.expiresAt) { adminSessions.delete(sid); return false }
  return true
}

function fmtRemaining(ms) {
  if (ms <= 0) return 'Expired'
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m ${s}s`
}

// Cleanup every 5 min
setInterval(() => {
  const now = Date.now()
  for (const [k, v] of accessKeys) {
    if (!v.active && now - v.createdAt > 86400000) accessKeys.delete(k)
  }
  for (const [k, v] of adminSessions) { if (now > v.expiresAt) adminSessions.delete(k) }
}, 300000)

// ==================== ADMIN AUTH ====================
app.get('/admin', (req, res) => {
  if (isAdmin(req)) return res.redirect('/admin/dashboard')
  res.send(adminLoginHTML())
})

app.post('/admin/login', (req, res) => {
  const { username, password } = req.body
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    const sid = randomBytes(24).toString('hex')
    adminSessions.set(sid, { expiresAt: Date.now() + 4 * 3600000 })
    res.cookie('admin_session', sid, { httpOnly: true, sameSite: 'lax', maxAge: 4 * 3600000 })
    return res.redirect('/admin/dashboard')
  }
  res.send(adminLoginHTML('Username atau password salah'))
})

app.get('/admin/dashboard', (req, res) => {
  if (!isAdmin(req)) return res.redirect('/admin')
  res.send(adminDashboardHTML())
})

app.post('/admin/logout', (req, res) => {
  const sid = req.cookies?.admin_session
  if (sid) adminSessions.delete(sid)
  res.clearCookie('admin_session')
  res.redirect('/admin')
})

// ==================== KEY API ====================

// Batch generate
app.post('/admin/api/keys', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' })
  const { labels, durationMinutes, expiryDate } = req.body
  const now = Date.now()

  let expiresAt, expiryType
  if (expiryDate) {
    expiresAt = new Date(expiryDate).getTime()
    expiryType = 'date'
  } else {
    const dur = parseInt(durationMinutes) || 30
    expiresAt = now + dur * 60000
    expiryType = 'duration'
  }

  const generated = []
  const nameList = (labels || ['Tanpa label']).filter(l => l.trim())
  if (nameList.length === 0) nameList.push('Tanpa label')

  for (const label of nameList) {
    const key = genKey()
    accessKeys.set(key, {
      label: label.trim(),
      createdAt: now,
      expiresAt,
      expiryType,
      active: true,
      voteCount: 0,
    })
    generated.push({ key, label: label.trim(), expiresAt: new Date(expiresAt).toISOString() })
  }

  res.json({ keys: generated })
})

// List
app.get('/admin/api/keys', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' })
  const now = Date.now()
  const keys = []
  for (const [key, v] of accessKeys) {
    const remaining = Math.max(0, v.expiresAt - now)
    const expired = now > v.expiresAt
    keys.push({
      key,
      label: v.label,
      createdAt: new Date(v.createdAt).toISOString(),
      expiresAt: new Date(v.expiresAt).toISOString(),
      expiryType: v.expiryType,
      active: v.active,
      expired,
      voteCount: v.voteCount,
      remainingMs: remaining,
      remainingFormatted: fmtRemaining(remaining),
    })
  }
  // Sort: active first, then by creation desc
  keys.sort((a, b) => {
    if (a.active && !a.expired && (!b.active || b.expired)) return -1
    if ((!a.active || a.expired) && b.active && !b.expired) return 1
    return new Date(b.createdAt) - new Date(a.createdAt)
  })
  res.json({ keys })
})

// Toggle active
app.patch('/admin/api/keys/:key/toggle', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' })
  const entry = accessKeys.get(req.params.key)
  if (!entry) return res.status(404).json({ error: 'Not found' })
  entry.active = !entry.active
  res.json({ key: req.params.key, active: entry.active })
})

// Delete
app.delete('/admin/api/keys/:key', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' })
  accessKeys.delete(req.params.key)
  res.json({ success: true })
})

// ==================== KEY VALIDATION ====================
app.get('/api/validate-key', (req, res) => {
  const key = req.query.key
  if (isKeyValid(key)) {
    const entry = accessKeys.get(key)
    return res.json({ valid: true, expiresAt: new Date(entry.expiresAt).toISOString() })
  }
  res.json({ valid: false })
})

// ==================== VOTE TRACKING ====================
// Intercept vote POST to track per-key votes
app.post('/event/:event/vote/:candidate', async (req, res) => {
  const accessKey = req.headers['x-access-key'] || req.query.access_key
  const url = `https://voteqrisbali.com${req.originalUrl}`
  try {
    const upstream = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(req.body),
    })
    const data = await upstream.json()
    // Track vote count for the key
    if (data.success && accessKey && accessKeys.has(accessKey)) {
      accessKeys.get(accessKey).voteCount++
    }
    res.status(upstream.status).json(data)
  } catch (e) {
    res.status(502).json({ error: 'Upstream error' })
  }
})

// ==================== PROXY ====================
const VOTE_API = 'https://voteqrisbali.com'
async function proxyToVoteQris(req, res) {
  const url = VOTE_API + req.originalUrl
  try {
    const opts = { method: req.method, headers: { 'Accept': 'application/json' } }
    if (req.method === 'POST') {
      opts.headers['Content-Type'] = 'application/json'
      opts.body = JSON.stringify(req.body)
    }
    const upstream = await fetch(url, opts)
    const ct = upstream.headers.get('content-type') || ''
    res.status(upstream.status)
    if (ct.includes('json')) { res.json(await upstream.json()) }
    else { res.set('content-type', ct).send(await upstream.text()) }
  } catch (e) {
    res.status(502).json({ error: 'Upstream error' })
  }
}

app.all('/api/events/{*splat}', proxyToVoteQris)
app.get('/event/vote/{*splat}', proxyToVoteQris) // vote status

// ==================== STATIC ====================
app.use(express.static(join(__dirname, 'dist')))
app.get('/{*splat}', (req, res) => {
  if (req.path.startsWith('/admin')) return res.status(404).send('Not found')
  res.sendFile(join(__dirname, 'dist', 'index.html'))
})

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`)
  console.log(`Admin panel: http://localhost:${PORT}/admin`)
})

// ==================== LOGIN HTML ====================
function adminLoginHTML(error = '') {
  return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Admin</title>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&family=Playfair+Display:wght@700&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Outfit',sans-serif;background:#080e18;min-height:100vh;display:flex;align-items:center;justify-content:center;color:#fff;
  background-image:radial-gradient(ellipse at 20% 50%,rgba(200,149,108,0.06) 0%,transparent 50%),radial-gradient(ellipse at 80% 80%,rgba(26,58,92,0.15) 0%,transparent 50%)}
.card{background:linear-gradient(145deg,#111b2e 0%,#0f1926 100%);border-radius:24px;padding:44px 36px;width:380px;max-width:92vw;box-shadow:0 24px 80px rgba(0,0,0,0.5),inset 0 1px 0 rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.04)}
.logo{font-family:'Playfair Display',serif;font-size:28px;color:#c8956c;margin-bottom:2px}
.sub{font-size:13px;color:rgba(255,255,255,0.3);margin-bottom:32px}
label{display:block;font-size:10px;font-weight:700;color:rgba(255,255,255,0.35);text-transform:uppercase;letter-spacing:1.2px;margin-bottom:6px}
input{width:100%;padding:13px 16px;border-radius:12px;border:1.5px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.03);color:#fff;font-family:inherit;font-size:14px;margin-bottom:18px;outline:none;transition:all .2s}
input:focus{border-color:rgba(200,149,108,0.5);background:rgba(200,149,108,0.04)}
input::placeholder{color:rgba(255,255,255,0.15)}
.btn{width:100%;padding:15px;border:none;border-radius:14px;background:linear-gradient(135deg,#c8956c,#a87550);color:#fff;font-family:inherit;font-size:15px;font-weight:700;cursor:pointer;transition:all .25s;box-shadow:0 4px 20px rgba(200,149,108,0.25)}
.btn:hover{box-shadow:0 8px 32px rgba(200,149,108,0.4);transform:translateY(-1px)}
.err{background:rgba(224,92,92,0.1);border:1px solid rgba(224,92,92,0.25);color:#e05c5c;padding:11px 14px;border-radius:12px;font-size:13px;margin-bottom:18px;font-weight:500}
</style>
</head>
<body>
<div class="card">
  <div class="logo">Admin</div>
  <div class="sub">Vote Sabrina — Access Key Manager</div>
  ${error ? `<div class="err">${error}</div>` : ''}
  <form method="POST" action="/admin/login">
    <label>Username</label><input type="text" name="username" placeholder="Username" autocomplete="off" required>
    <label>Password</label><input type="password" name="password" placeholder="Password" required>
    <button type="submit" class="btn">Masuk</button>
  </form>
</div>
</body></html>`
}

// ==================== DASHBOARD HTML ====================
function adminDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Admin Dashboard</title>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800;900&family=Playfair+Display:wght@700&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#080e18;--surface:#111b2e;--surface2:#162034;--border:rgba(255,255,255,0.06);--accent:#c8956c;--accent2:#a87550;--green:#3ecf8e;--red:#e05c5c;--yellow:#f59e0b;--text:#fff;--dim:rgba(255,255,255,0.45);--faint:rgba(255,255,255,0.25)}
body{font-family:'Outfit',sans-serif;background:var(--bg);min-height:100vh;color:var(--text);
  background-image:radial-gradient(ellipse at 10% 10%,rgba(200,149,108,0.04) 0%,transparent 40%),radial-gradient(ellipse at 90% 90%,rgba(26,58,92,0.08) 0%,transparent 40%)}

/* Topbar */
.topbar{background:var(--surface);padding:14px 24px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--border);position:sticky;top:0;z-index:50;backdrop-filter:blur(12px)}
.topbar-left{display:flex;align-items:center;gap:12px}
.topbar h1{font-family:'Playfair Display',serif;font-size:17px;color:var(--accent)}
.topbar-stat{display:flex;align-items:center;gap:6px;background:rgba(62,207,142,0.08);padding:4px 12px;border-radius:20px;font-size:11px;font-weight:700;color:var(--green)}
.topbar-stat .dot{width:6px;height:6px;background:var(--green);border-radius:50%;animation:pulse 1.5s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.btn-logout{background:rgba(224,92,92,0.1);border:1px solid rgba(224,92,92,0.2);color:var(--red);padding:7px 16px;border-radius:10px;font-family:inherit;font-size:12px;font-weight:600;cursor:pointer;transition:all .2s}
.btn-logout:hover{background:rgba(224,92,92,0.18)}

.container{max-width:720px;margin:0 auto;padding:24px 20px}

/* Cards */
.card{background:var(--surface);border-radius:20px;padding:28px;margin-bottom:20px;border:1px solid var(--border);position:relative;overflow:hidden}
.card::before{content:'';position:absolute;top:-60px;right:-60px;width:140px;height:140px;background:radial-gradient(circle,rgba(200,149,108,0.04) 0%,transparent 70%);pointer-events:none}
.card-title{font-size:17px;font-weight:800;margin-bottom:3px;display:flex;align-items:center;gap:8px}
.card-title .icon{font-size:20px}
.card-desc{font-size:12px;color:var(--dim);margin-bottom:20px;line-height:1.5}

/* Generate Form */
.gen-config{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap}
.gen-config select,.gen-config input[type="number"],.gen-config input[type="datetime-local"]{padding:10px 12px;border-radius:10px;border:1.5px solid var(--border);background:rgba(255,255,255,0.03);color:#fff;font-family:inherit;font-size:12px;outline:none;transition:border-color .2s}
.gen-config select{min-width:120px}
.gen-config input[type="number"]{width:80px}
.gen-config input[type="datetime-local"]{flex:1;min-width:180px}
.gen-config select:focus,.gen-config input:focus{border-color:rgba(200,149,108,0.5)}

.label-list{display:flex;flex-direction:column;gap:6px;margin-bottom:14px}
.label-row{display:flex;gap:6px;align-items:center;animation:slideIn .2s ease}
@keyframes slideIn{from{opacity:0;transform:translateX(-8px)}to{opacity:1;transform:translateX(0)}}
.label-row input{flex:1;padding:10px 14px;border-radius:10px;border:1.5px solid var(--border);background:rgba(255,255,255,0.03);color:#fff;font-family:inherit;font-size:13px;outline:none;transition:border-color .2s}
.label-row input:focus{border-color:rgba(200,149,108,0.5)}
.label-row input::placeholder{color:var(--faint)}
.btn-remove-label{width:32px;height:32px;border-radius:8px;border:1px solid var(--border);background:transparent;color:var(--red);cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:16px;transition:all .2s;flex-shrink:0}
.btn-remove-label:hover{background:rgba(224,92,92,0.1)}

.gen-actions{display:flex;gap:8px}
.btn-add{padding:10px 18px;border-radius:10px;border:1.5px dashed rgba(200,149,108,0.3);background:transparent;color:var(--accent);font-family:inherit;font-size:12px;font-weight:700;cursor:pointer;transition:all .2s;display:flex;align-items:center;gap:6px}
.btn-add:hover{border-color:var(--accent);background:rgba(200,149,108,0.06)}
.btn-gen{padding:10px 24px;border-radius:10px;border:none;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;font-family:inherit;font-size:13px;font-weight:700;cursor:pointer;transition:all .2s;box-shadow:0 4px 16px rgba(200,149,108,0.25);display:flex;align-items:center;gap:6px}
.btn-gen:hover{box-shadow:0 6px 24px rgba(200,149,108,0.35);transform:translateY(-1px)}
.btn-gen:disabled{opacity:.5;cursor:not-allowed;transform:none}

/* Generated Result */
.gen-result{display:none;margin-top:16px}
.gen-result.show{display:block;animation:fadeIn .3s ease}
@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
.gen-result-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
.gen-result-title{font-size:13px;font-weight:700;color:var(--green)}
.btn-copy-all{padding:6px 14px;border-radius:8px;border:1.5px solid rgba(62,207,142,0.25);background:rgba(62,207,142,0.06);color:var(--green);font-family:inherit;font-size:11px;font-weight:700;cursor:pointer;transition:all .2s}
.btn-copy-all:hover{background:rgba(62,207,142,0.12)}
.gen-result-list{display:flex;flex-direction:column;gap:6px}
.gen-result-item{display:flex;align-items:center;gap:12px;padding:10px 14px;background:rgba(62,207,142,0.04);border:1px solid rgba(62,207,142,0.12);border-radius:10px}
.gen-result-item .key-code{font-size:16px;font-weight:800;color:var(--green);letter-spacing:2px;flex-shrink:0;cursor:pointer}
.gen-result-item .key-label{flex:1;font-size:12px;color:var(--dim);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gen-result-item .key-link{font-size:10px;color:var(--faint);cursor:pointer;flex-shrink:0;transition:color .2s}
.gen-result-item .key-link:hover{color:var(--accent)}

/* Key List */
.key-list{display:flex;flex-direction:column;gap:6px}
.key-item{display:flex;align-items:center;gap:10px;padding:12px 14px;background:rgba(255,255,255,0.02);border-radius:12px;border:1px solid var(--border);transition:all .2s}
.key-item.inactive{opacity:.45}
.key-item.expired{opacity:.35}
.key-code-col{min-width:90px}
.key-code{font-size:15px;font-weight:800;color:var(--accent);letter-spacing:2px;font-variant-numeric:tabular-nums}
.key-active-dot{width:7px;height:7px;border-radius:50%;display:inline-block;margin-right:4px}
.key-active-dot.on{background:var(--green)}
.key-active-dot.off{background:var(--red)}
.key-info{flex:1;min-width:0}
.key-label{font-size:12px;font-weight:600;color:rgba(255,255,255,0.7);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.key-meta{font-size:10px;color:var(--faint);display:flex;gap:8px;flex-wrap:wrap;margin-top:2px}
.key-votes{display:flex;align-items:center;gap:4px;padding:3px 10px;background:rgba(200,149,108,0.08);border-radius:6px;font-size:12px;font-weight:700;color:var(--accent);flex-shrink:0;min-width:50px;justify-content:center}
.key-remaining{font-size:11px;font-weight:700;flex-shrink:0;min-width:60px;text-align:right}
.key-remaining.ok{color:var(--green)}
.key-remaining.warn{color:var(--yellow)}
.key-remaining.critical{color:var(--red)}
.key-remaining.dead{color:var(--faint);font-weight:500}
.key-actions{display:flex;gap:4px;flex-shrink:0}
.btn-toggle,.btn-del{width:30px;height:30px;border-radius:8px;border:1px solid var(--border);background:transparent;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:13px;transition:all .2s}
.btn-toggle{color:var(--yellow)}
.btn-toggle:hover{background:rgba(245,158,11,0.1)}
.btn-del{color:var(--red)}
.btn-del:hover{background:rgba(224,92,92,0.1)}
.empty{text-align:center;padding:32px;color:var(--faint);font-size:13px}

/* Toast */
.toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:var(--surface);color:#fff;padding:10px 20px;border-radius:12px;font-size:13px;font-weight:600;z-index:200;box-shadow:0 8px 32px rgba(0,0,0,0.4);border:1px solid var(--border);animation:fadeIn .2s ease;white-space:nowrap}

/* Summary Stats */
.summary{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:20px}
.summary-item{background:var(--surface);border-radius:14px;padding:16px;text-align:center;border:1px solid var(--border)}
.summary-val{font-size:28px;font-weight:900;margin-bottom:2px}
.summary-val.accent{color:var(--accent)}
.summary-val.green{color:var(--green)}
.summary-val.dim{color:var(--dim)}
.summary-lbl{font-size:10px;font-weight:600;color:var(--faint);text-transform:uppercase;letter-spacing:.8px}

@media(max-width:600px){
  .container{padding:16px 14px}
  .card{padding:20px 16px;border-radius:16px}
  .summary{grid-template-columns:repeat(3,1fr);gap:6px}
  .summary-item{padding:12px 8px}
  .summary-val{font-size:22px}
  .gen-config{flex-direction:column}
  .gen-config select,.gen-config input[type="number"],.gen-config input[type="datetime-local"]{width:100%}
  .key-item{flex-wrap:wrap;gap:8px}
  .key-code-col{min-width:auto}
  .key-votes{min-width:auto}
}
</style>
</head>
<body>
<div class="topbar">
  <div class="topbar-left">
    <h1>Dashboard</h1>
    <div class="topbar-stat"><span class="dot"></span> <span id="active-count">0</span> Active</div>
  </div>
  <form method="POST" action="/admin/logout" style="display:inline">
    <button type="submit" class="btn-logout">Logout</button>
  </form>
</div>

<div class="container">
  <!-- Summary -->
  <div class="summary" id="summary">
    <div class="summary-item"><div class="summary-val green" id="s-active">0</div><div class="summary-lbl">Active Keys</div></div>
    <div class="summary-item"><div class="summary-val accent" id="s-votes">0</div><div class="summary-lbl">Total Votes</div></div>
    <div class="summary-item"><div class="summary-val dim" id="s-total">0</div><div class="summary-lbl">All Keys</div></div>
  </div>

  <!-- Generate -->
  <div class="card">
    <div class="card-title"><span class="icon">⚡</span> Generate Access Keys</div>
    <div class="card-desc">Tambah label per orang, lalu generate sekaligus. Semua key bisa di-copy dalam satu klik.</div>

    <div class="gen-config">
      <select id="expiry-type">
        <option value="duration">Durasi</option>
        <option value="date">Tanggal</option>
      </select>
      <input type="number" id="duration-input" value="30" min="5" max="1440" placeholder="Menit" />
      <input type="datetime-local" id="date-input" style="display:none" />
    </div>

    <div class="label-list" id="label-list">
      <div class="label-row">
        <input type="text" placeholder="Nama / label (misal: Rina)" class="label-input" />
        <button class="btn-remove-label" title="Hapus" style="visibility:hidden">✕</button>
      </div>
    </div>

    <div class="gen-actions">
      <button class="btn-add" id="btn-add-label">+ Tambah</button>
      <button class="btn-gen" id="btn-generate">⚡ Generate</button>
    </div>

    <div class="gen-result" id="gen-result">
      <div class="gen-result-header">
        <div class="gen-result-title" id="gen-result-title">Generated!</div>
        <button class="btn-copy-all" id="btn-copy-all">📋 Copy All Links</button>
      </div>
      <div class="gen-result-list" id="gen-result-list"></div>
    </div>
  </div>

  <!-- Key List -->
  <div class="card">
    <div class="card-title"><span class="icon">🔑</span> All Keys</div>
    <div class="card-desc">Auto-refresh setiap 10 detik. Klik toggle untuk activate/deactivate.</div>
    <div class="key-list" id="key-list"><div class="empty">Memuat...</div></div>
  </div>
</div>

<script>
const BASE = window.location.origin;
let lastGenerated = [];

// === Expiry type toggle ===
const expiryType = document.getElementById('expiry-type');
const durInput = document.getElementById('duration-input');
const dateInput = document.getElementById('date-input');
expiryType.onchange = () => {
  if (expiryType.value === 'date') { durInput.style.display='none'; dateInput.style.display=''; }
  else { durInput.style.display=''; dateInput.style.display='none'; }
};

// === Label management ===
const labelList = document.getElementById('label-list');

document.getElementById('btn-add-label').onclick = () => {
  addLabelRow('');
  updateRemoveButtons();
};

function addLabelRow(val) {
  const row = document.createElement('div');
  row.className = 'label-row';
  row.innerHTML = '<input type="text" placeholder="Nama / label" class="label-input" value="' + (val||'') + '" /><button class="btn-remove-label" title="Hapus">✕</button>';
  labelList.appendChild(row);
  row.querySelector('.btn-remove-label').onclick = () => { row.remove(); updateRemoveButtons(); };
  row.querySelector('input').focus();
}

function updateRemoveButtons() {
  const rows = labelList.querySelectorAll('.label-row');
  rows.forEach((r, i) => {
    r.querySelector('.btn-remove-label').style.visibility = rows.length <= 1 ? 'hidden' : 'visible';
  });
}

// === Generate ===
document.getElementById('btn-generate').onclick = async () => {
  const btn = document.getElementById('btn-generate');
  btn.disabled = true; btn.textContent = 'Generating...';

  const labels = [...labelList.querySelectorAll('.label-input')].map(i => i.value.trim()).filter(Boolean);
  if (labels.length === 0) labels.push('Tanpa label');

  const body = { labels };
  if (expiryType.value === 'date' && dateInput.value) {
    body.expiryDate = dateInput.value;
  } else {
    body.durationMinutes = parseInt(durInput.value) || 30;
  }

  try {
    const res = await fetch('/admin/api/keys', {
      method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body)
    });
    const data = await res.json();
    lastGenerated = data.keys;
    showGenResult(data.keys);
    loadKeys();
    // Reset labels
    labelList.innerHTML = '<div class="label-row"><input type="text" placeholder="Nama / label (misal: Rina)" class="label-input" /><button class="btn-remove-label" title="Hapus" style="visibility:hidden">✕</button></div>';
  } catch(e) { toast('Gagal generate'); }

  btn.disabled = false; btn.textContent = '⚡ Generate';
};

function showGenResult(keys) {
  const el = document.getElementById('gen-result');
  const list = document.getElementById('gen-result-list');
  document.getElementById('gen-result-title').textContent = keys.length + ' key berhasil dibuat';
  list.innerHTML = keys.map(k => {
    const link = BASE + '/?key=' + k.key;
    return '<div class="gen-result-item">' +
      '<span class="key-code" onclick="copyText(\\'' + k.key + '\\')" title="Copy key">' + k.key + '</span>' +
      '<span class="key-label">' + k.label + '</span>' +
      '<span class="key-link" onclick="copyText(\\'' + link + '\\')" title="Copy link">📋 Link</span>' +
    '</div>';
  }).join('');
  el.classList.add('show');
}

document.getElementById('btn-copy-all').onclick = () => {
  const lines = lastGenerated.map(k => k.label + ': ' + BASE + '/?key=' + k.key).join('\\n');
  navigator.clipboard.writeText(lines);
  toast('Semua link berhasil di-copy!');
};

// === Key List ===
async function loadKeys() {
  try {
    const res = await fetch('/admin/api/keys');
    const data = await res.json();
    const list = document.getElementById('key-list');

    // Summary
    const active = data.keys.filter(k => k.active && !k.expired);
    const totalVotes = data.keys.reduce((s,k) => s + k.voteCount, 0);
    document.getElementById('s-active').textContent = active.length;
    document.getElementById('s-votes').textContent = totalVotes;
    document.getElementById('s-total').textContent = data.keys.length;
    document.getElementById('active-count').textContent = active.length;

    if (data.keys.length === 0) {
      list.innerHTML = '<div class="empty">Belum ada key</div>';
      return;
    }

    list.innerHTML = data.keys.map(k => {
      const mins = Math.floor(k.remainingMs / 60000);
      const remCls = k.expired ? 'dead' : mins <= 5 ? 'critical' : mins <= 15 ? 'warn' : 'ok';
      const dotCls = k.active && !k.expired ? 'on' : 'off';
      const itemCls = !k.active ? 'inactive' : k.expired ? 'expired' : '';
      const toggleIcon = k.active ? '⏸' : '▶';
      const expLabel = k.expiryType === 'date' ? new Date(k.expiresAt).toLocaleString('id-ID',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}) : k.remainingFormatted;

      return '<div class="key-item ' + itemCls + '">' +
        '<div class="key-code-col"><span class="key-active-dot ' + dotCls + '"></span><span class="key-code">' + k.key + '</span></div>' +
        '<div class="key-info"><div class="key-label">' + k.label + '</div>' +
        '<div class="key-meta"><span>' + (k.expired ? 'Expired' : expLabel) + '</span></div></div>' +
        '<div class="key-votes">' + k.voteCount + ' vote</div>' +
        '<div class="key-remaining ' + remCls + '">' + (k.expired ? 'Expired' : k.remainingFormatted) + '</div>' +
        '<div class="key-actions">' +
        '<button class="btn-toggle" onclick="toggleKey(\\'' + k.key + '\\')" title="' + (k.active?'Deactivate':'Activate') + '">' + toggleIcon + '</button>' +
        '<button class="btn-del" onclick="delKey(\\'' + k.key + '\\')" title="Delete">✕</button>' +
        '</div></div>';
    }).join('');
  } catch(e) { console.error(e); }
}

async function toggleKey(key) {
  await fetch('/admin/api/keys/' + key + '/toggle', { method: 'PATCH' });
  loadKeys();
}

async function delKey(key) {
  if (!confirm('Hapus key ' + key + '?')) return;
  await fetch('/admin/api/keys/' + key, { method: 'DELETE' });
  loadKeys();
}

function copyText(t) {
  navigator.clipboard.writeText(t);
  toast('Copied: ' + t);
}

function toast(msg) {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2500);
}

loadKeys();
setInterval(loadKeys, 10000);
</script>
</body></html>`
}
