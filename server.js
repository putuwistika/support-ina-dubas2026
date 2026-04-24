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

// --- Rate Limiter (per IP, for upstream requests) ---
const rateLimits = new Map() // ip -> { count, resetAt }
const RATE_LIMIT_MAX = 60    // max requests per window
const RATE_LIMIT_WINDOW = 60000 // 1 minute

function checkRateLimit(ip) {
  const now = Date.now()
  let entry = rateLimits.get(ip)
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW }
    rateLimits.set(ip, entry)
  }
  entry.count++
  return entry.count <= RATE_LIMIT_MAX
}


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
  for (const [k, v] of rateLimits) { if (now > v.resetAt) rateLimits.delete(k) }
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

app.get('/admin/bulk-vote', (req, res) => {
  if (!isAdmin(req)) return res.redirect('/admin')
  res.send(bulkVoteHTML())
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
  const ip = req.ip || req.socket.remoteAddress
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Terlalu banyak request. Coba lagi dalam 1 menit.' })
  }

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

// Direct proxy — no caching, always real-time data
async function proxyToVoteQris(req, res) {
  const ip = req.ip || req.socket.remoteAddress
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Terlalu banyak request. Coba lagi dalam 1 menit.' })
  }

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
app.get('/event/vote/{*splat}', proxyToVoteQris)

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
:root{--bg:#f5f6f8;--surface:#ffffff;--surface2:#f8f9fb;--border:rgba(0,0,0,0.07);--accent:#c8956c;--accent2:#a87550;--green:#22c55e;--red:#ef4444;--yellow:#f59e0b;--text:#0f172a;--dim:#64748b;--faint:#94a3b8}
body{font-family:'Outfit',sans-serif;background:var(--bg);min-height:100vh;color:var(--text)}

/* Topbar */
.topbar{background:var(--surface);padding:14px 24px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--border);position:sticky;top:0;z-index:50;box-shadow:0 1px 3px rgba(0,0,0,0.04)}
.topbar-left{display:flex;align-items:center;gap:12px}
.topbar h1{font-family:'Playfair Display',serif;font-size:17px;color:var(--accent)}
.topbar-stat{display:flex;align-items:center;gap:6px;background:rgba(34,197,94,0.08);padding:4px 12px;border-radius:20px;font-size:11px;font-weight:700;color:var(--green)}
.topbar-stat .dot{width:6px;height:6px;background:var(--green);border-radius:50%;animation:pulse 1.5s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.btn-logout{background:rgba(239,68,68,0.06);border:1px solid rgba(239,68,68,0.15);color:var(--red);padding:7px 16px;border-radius:10px;font-family:inherit;font-size:12px;font-weight:600;cursor:pointer;transition:all .2s}
.btn-logout:hover{background:rgba(239,68,68,0.12)}

.container{max-width:100%;margin:0 auto;padding:24px 20px}

/* Cards */
.card{background:var(--surface);border-radius:20px;padding:28px;margin-bottom:20px;border:1px solid var(--border);position:relative;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.04)}
.card::before{content:'';position:absolute;top:-60px;right:-60px;width:140px;height:140px;background:radial-gradient(circle,rgba(200,149,108,0.06) 0%,transparent 70%);pointer-events:none}
.card-title{font-size:17px;font-weight:800;margin-bottom:3px;display:flex;align-items:center;gap:8px}
.card-title .icon{font-size:20px}
.card-desc{font-size:12px;color:var(--dim);margin-bottom:20px;line-height:1.5}

/* Generate Form */
.gen-config{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap}
.gen-config select,.gen-config input[type="number"],.gen-config input[type="datetime-local"]{padding:10px 12px;border-radius:10px;border:1.5px solid var(--border);background:var(--surface2);color:var(--text);font-family:inherit;font-size:12px;outline:none;transition:border-color .2s}
.gen-config select{min-width:120px}
.gen-config input[type="number"]{width:80px}
.gen-config input[type="datetime-local"]{flex:1;min-width:180px}
.gen-config select:focus,.gen-config input:focus{border-color:rgba(200,149,108,0.5)}

.label-list{display:flex;flex-direction:column;gap:6px;margin-bottom:14px}
.label-row{display:flex;gap:6px;align-items:center;animation:slideIn .2s ease}
@keyframes slideIn{from{opacity:0;transform:translateX(-8px)}to{opacity:1;transform:translateX(0)}}
.label-row input{flex:1;padding:10px 14px;border-radius:10px;border:1.5px solid var(--border);background:var(--surface2);color:var(--text);font-family:inherit;font-size:13px;outline:none;transition:border-color .2s}
.label-row input:focus{border-color:rgba(200,149,108,0.5)}
.label-row input::placeholder{color:var(--faint)}
select option{background:var(--surface);color:var(--text)}
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
.gen-result-item{display:flex;align-items:center;gap:12px;padding:10px 14px;background:rgba(34,197,94,0.04);border:1px solid rgba(34,197,94,0.12);border-radius:10px}
.gen-result-item .key-code{font-size:16px;font-weight:800;color:var(--green);letter-spacing:2px;flex-shrink:0;cursor:pointer}
.gen-result-item .key-label{flex:1;font-size:12px;color:var(--dim);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gen-result-item .key-link{font-size:10px;color:var(--faint);cursor:pointer;flex-shrink:0;transition:color .2s}
.gen-result-item .key-link:hover{color:var(--accent)}

/* Key List */
.key-list{display:flex;flex-direction:column;gap:6px}
.key-item{display:flex;align-items:center;gap:10px;padding:12px 14px;background:var(--surface2);border-radius:12px;border:1px solid var(--border);transition:all .2s}
.key-item.inactive{opacity:.45}
.key-item.expired{opacity:.35}
.key-code-col{min-width:90px}
.key-code{font-size:15px;font-weight:800;color:var(--accent);letter-spacing:2px;font-variant-numeric:tabular-nums}
.key-active-dot{width:7px;height:7px;border-radius:50%;display:inline-block;margin-right:4px}
.key-active-dot.on{background:var(--green)}
.key-active-dot.off{background:var(--red)}
.key-info{flex:1;min-width:0}
.key-label{font-size:12px;font-weight:600;color:var(--text);opacity:.8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
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
.toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:var(--text);color:#fff;padding:10px 20px;border-radius:12px;font-size:13px;font-weight:600;z-index:200;box-shadow:0 8px 32px rgba(0,0,0,0.15);border:none;animation:fadeIn .2s ease;white-space:nowrap}

/* Summary Stats */
.summary{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:20px}
.summary-item{background:var(--surface);border-radius:14px;padding:16px;text-align:center;border:1px solid var(--border);box-shadow:0 1px 3px rgba(0,0,0,0.04)}
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

  <!-- Bulk QR Link -->
  <div class="card">
    <div class="card-title"><span class="icon">🔲</span> Bulk QR Vote</div>
    <div class="card-desc">Buka halaman full-screen untuk generate beberapa QR sekaligus, bisa di-scan barengan.</div>
    <a href="/admin/bulk-vote" target="_blank" class="btn-gen" style="text-decoration:none;display:inline-flex;width:auto">🔲 Buka Bulk Vote</a>
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

// ==================== BULK VOTE PAGE ====================
function bulkVoteHTML() {
  return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=1.0">
<title>Bulk Vote — SABI</title>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/qrcode@1.5.1/build/qrcode.min.js"></script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--navy:#1a3a5c;--accent:#c8956c;--accent2:#b8845e;--green:#22c55e;--green-dark:#16a34a;--red:#ef4444;--amber:#f59e0b;--text:#0f172a;--dim:#64748b;--faint:#94a3b8;--border:#e2e8f0;--bg:#f8fafc;--surface:#ffffff}
body{font-family:'Plus Jakarta Sans',sans-serif;background:var(--bg);min-height:100vh;color:var(--text);display:flex;flex-direction:column;overflow:hidden;height:100vh}

/* Topbar */
.topbar{background:var(--surface);padding:0 24px;height:56px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--border);flex-shrink:0;z-index:50}
.topbar-left{display:flex;align-items:center;gap:16px}
.back-btn{display:flex;align-items:center;gap:6px;color:var(--dim);text-decoration:none;font-size:13px;font-weight:600;padding:6px 12px;border-radius:8px;transition:all .2s}
.back-btn:hover{background:var(--bg);color:var(--text)}
.back-arrow{font-size:18px;line-height:1}
.topbar-title{font-size:14px;font-weight:800;color:var(--navy);letter-spacing:.3px}
.topbar-right{display:flex;align-items:center;gap:16px}
.streak-wrap{display:flex;align-items:center;gap:6px;padding:5px 14px;border-radius:20px;font-weight:800;font-size:13px;transition:all .4s;opacity:0;transform:scale(0.8)}
.streak-wrap.visible{opacity:1;transform:scale(1)}
.streak-wrap.hot{background:linear-gradient(135deg,#fff7ed,#ffedd5);color:#ea580c;border:1px solid #fed7aa}
.streak-wrap.fire{background:linear-gradient(135deg,#fef2f2,#fee2e2);color:#dc2626;border:1px solid #fca5a5;box-shadow:0 0 16px rgba(220,38,38,.15)}
.streak-wrap.legend{background:linear-gradient(135deg,#fffbeb,#fef3c7);color:#d97706;border:1px solid #fde68a;box-shadow:0 0 20px rgba(217,119,6,.2)}
.streak-fire{font-size:16px;animation:flicker .3s ease infinite alternate}
@keyframes flicker{0%{transform:scale(1) rotate(-5deg)}100%{transform:scale(1.15) rotate(5deg)}}
.total-wrap{text-align:right}
.total-num{font-size:22px;font-weight:900;color:var(--navy);line-height:1;font-variant-numeric:tabular-nums}
.total-label{font-size:9px;font-weight:700;color:var(--faint);text-transform:uppercase;letter-spacing:1px}
.live-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--green);animation:blink 1.5s infinite;margin-right:4px}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.3}}

/* Stats & Controls */
.controls{display:flex;align-items:center;gap:10px;padding:10px 24px;background:var(--surface);border-bottom:1px solid var(--border);flex-shrink:0}
.ctrl-btn{padding:8px 16px;border-radius:10px;font-family:inherit;font-size:12px;font-weight:700;cursor:pointer;transition:all .2s;border:1.5px solid var(--border);background:var(--surface);color:var(--text);display:flex;align-items:center;gap:5px}
.ctrl-btn:hover{background:var(--bg)}
.ctrl-btn.stop{border-color:rgba(239,68,68,.25);color:var(--red);background:rgba(239,68,68,.04)}
.ctrl-btn.stop:hover{background:rgba(239,68,68,.08)}
.ctrl-btn.reload{border-color:rgba(200,149,108,.3);color:var(--accent)}
.ctrl-btn.reload:hover{background:rgba(200,149,108,.06)}
.stats-pills{display:flex;gap:12px;margin-left:auto}
.pill{display:flex;align-items:center;gap:4px;font-size:11px;font-weight:700;color:var(--dim)}
.pill .pv{font-size:16px;font-weight:900}
.pill.p-ok .pv{color:var(--green)}
.pill.p-wait .pv{color:var(--amber)}
.pill.p-fail .pv{color:var(--red)}

/* Grid wrapper */
.grid-wrap{flex:1;overflow-y:auto;overflow-x:hidden;position:relative}

/* Empty state */
.empty-state{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:16px;animation:fadeUp .5s ease}
.empty-icon{font-size:64px;opacity:.6}
.empty-title{font-size:18px;font-weight:800;color:var(--navy)}
.empty-sub{font-size:13px;color:var(--dim);max-width:280px;text-align:center;line-height:1.5}
.empty-btn{padding:14px 32px;border-radius:14px;border:none;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;font-family:inherit;font-size:15px;font-weight:800;cursor:pointer;transition:all .25s;box-shadow:0 4px 16px rgba(200,149,108,.3)}
.empty-btn:hover{transform:translateY(-2px);box-shadow:0 8px 28px rgba(200,149,108,.4)}
.empty-btn:active{transform:scale(.97)}

/* Grid */
.grid{display:grid;gap:16px;padding:20px 24px;height:100%;align-content:center}

/* Add cell */
.add-cell{background:var(--surface);border:2.5px dashed var(--border);border-radius:20px;display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer;transition:all .3s;min-height:120px;gap:8px}
.add-cell:hover{border-color:var(--accent);background:rgba(200,149,108,.03);transform:scale(1.02)}
.add-cell:active{transform:scale(.98)}
.add-icon{width:48px;height:48px;border-radius:50%;background:linear-gradient(135deg,rgba(200,149,108,.1),rgba(200,149,108,.05));display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:300;color:var(--accent);transition:all .3s}
.add-cell:hover .add-icon{background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;transform:rotate(90deg)}
.add-label{font-size:11px;font-weight:700;color:var(--faint);text-transform:uppercase;letter-spacing:1px}
.add-count{font-size:10px;color:var(--faint);font-weight:600}

/* Cell */
.cell{background:var(--surface);border:2px solid var(--border);border-radius:20px;padding:16px;text-align:center;position:relative;transition:all .3s;display:flex;flex-direction:column;align-items:center;justify-content:center;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.04);animation:cellEnter .4s cubic-bezier(.175,.885,.32,1.275) forwards}
@keyframes cellEnter{0%{transform:scale(0.5);opacity:0}100%{transform:scale(1);opacity:1}}
.cell.is-waiting{border-color:var(--accent);box-shadow:0 0 0 3px rgba(200,149,108,.08)}
.cell.is-success{border-color:var(--green);background:linear-gradient(180deg,rgba(34,197,94,.04) 0%,#fff 100%);box-shadow:0 0 0 3px rgba(34,197,94,.1)}
.cell.is-expired{border-color:var(--red);opacity:.7}

/* Instant swap animation — green flash + card flip */
.cell.instant-swap{animation:instantSwap .45s cubic-bezier(.175,.885,.32,1.275)}
@keyframes instantSwap{
  0%{transform:rotateY(90deg) scale(.9);border-color:var(--green);box-shadow:0 0 24px rgba(34,197,94,.4)}
  40%{transform:rotateY(-5deg) scale(1.03);border-color:var(--green);box-shadow:0 0 16px rgba(34,197,94,.25)}
  100%{transform:rotateY(0) scale(1);border-color:var(--accent);box-shadow:0 0 0 3px rgba(200,149,108,.08)}
}
/* Green pulse border on swap */
.cell.green-flash{border-color:var(--green)!important;box-shadow:0 0 20px rgba(34,197,94,.35)!important;transition:none}

.cell-num{position:absolute;top:10px;left:12px;font-size:9px;font-weight:800;color:var(--faint);text-transform:uppercase;letter-spacing:1.5px}

/* Loading */
.cell-spinner{width:32px;height:32px;border:3px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin .6s linear infinite;margin:20px auto 8px}
@keyframes spin{to{transform:rotate(360deg)}}
.cell-load-text{font-size:11px;color:var(--dim);font-weight:500}

/* Waiting */
.cell-status-badge{display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:16px;font-size:9px;font-weight:700;margin-bottom:8px}
.badge-wait{background:rgba(245,158,11,.06);color:var(--amber);border:1px solid rgba(245,158,11,.15)}
.badge-wait .bdot{width:5px;height:5px;border-radius:50%;background:var(--amber);animation:blink 1.2s infinite}
.badge-ok{background:rgba(34,197,94,.06);color:var(--green);border:1px solid rgba(34,197,94,.15)}
.badge-exp{background:rgba(239,68,68,.06);color:var(--red);border:1px solid rgba(239,68,68,.15)}

.cell canvas{border-radius:12px;display:block;margin:0 auto 6px}
.cell-amt{font-size:9px;color:var(--faint)}
.cell-amt b{font-size:14px;color:var(--text);font-weight:800}
.cell-timer{font-size:12px;color:var(--dim);font-weight:700;font-variant-numeric:tabular-nums;margin-top:2px}
.cell-hint{font-size:9px;color:var(--faint);margin-top:6px}

/* Success */
.cell-check{width:50px;height:50px;border-radius:50%;background:linear-gradient(135deg,var(--green),var(--green-dark));display:flex;align-items:center;justify-content:center;margin:8px auto;font-size:24px;color:#fff;animation:popIn .4s cubic-bezier(.175,.885,.32,1.275)}
@keyframes popIn{0%{transform:scale(0)}70%{transform:scale(1.2)}100%{transform:scale(1)}}
.cell-ok-text{font-size:14px;font-weight:800;color:var(--text)}
.cell-ok-sub{font-size:10px;color:var(--dim)}
.cell-next{font-size:9px;color:var(--faint);margin-top:6px}

/* Cell votes badge */
.cell-votes{display:flex;align-items:center;justify-content:center;gap:3px;margin-top:8px;padding:3px 10px;border-radius:10px;background:rgba(34,197,94,.06);font-size:18px;font-weight:900;color:var(--green)}
.cell-votes-lbl{font-size:8px;color:var(--faint);text-transform:uppercase;letter-spacing:.8px;font-weight:700}

/* Expired */
.cell-exp-icon{font-size:32px;margin:12px 0 4px}
.cell-retry{margin-top:8px;padding:8px 18px;border-radius:10px;border:1.5px solid var(--accent);background:transparent;color:var(--accent);font-family:inherit;font-size:11px;font-weight:700;cursor:pointer;transition:all .2s}
.cell-retry:hover{background:rgba(200,149,108,.08)}

/* Float +1 */
.float-plus{position:absolute;top:40%;left:50%;transform:translate(-50%,-50%);font-size:28px;font-weight:900;color:var(--green);pointer-events:none;z-index:10;animation:floatUp 1s ease-out forwards}
@keyframes floatUp{0%{transform:translate(-50%,-50%) scale(.5);opacity:1}100%{transform:translate(-50%,-150%) scale(1.3);opacity:0}}

/* Confetti */
.confetti-piece{position:fixed;width:8px;height:12px;top:-20px;z-index:999;border-radius:2px;animation:confettiFall 2.5s ease-in forwards}
@keyframes confettiFall{0%{transform:translateY(0) rotateZ(0deg) rotateX(0deg);opacity:1}100%{transform:translateY(110vh) rotateZ(720deg) rotateX(360deg);opacity:0}}

/* Milestone notification */
.milestone{position:fixed;top:-100px;left:50%;transform:translateX(-50%);padding:14px 32px;border-radius:20px;font-weight:800;font-size:16px;z-index:200;white-space:nowrap;box-shadow:0 8px 32px rgba(0,0,0,.12);transition:top .5s cubic-bezier(.175,.885,.32,1.275)}
.milestone.show{top:70px}
.milestone.m-5{background:linear-gradient(135deg,#ecfdf5,#d1fae5);color:#059669;border:2px solid #6ee7b7}
.milestone.m-10{background:linear-gradient(135deg,#fff7ed,#ffedd5);color:#ea580c;border:2px solid #fdba74}
.milestone.m-25{background:linear-gradient(135deg,#fefce8,#fef9c3);color:#ca8a04;border:2px solid #fde047}
.milestone.m-50{background:linear-gradient(135deg,#fdf2f8,#fce7f3);color:#db2777;border:2px solid #f9a8d4}

/* Animations */
@keyframes fadeUp{0%{opacity:0;transform:translateY(20px)}100%{opacity:1;transform:translateY(0)}}
@keyframes shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-4px)}75%{transform:translateX(4px)}}
@keyframes glow-pulse{0%,100%{box-shadow:0 0 0 0 rgba(34,197,94,.2)}50%{box-shadow:0 0 0 8px rgba(34,197,94,0)}}

/* Responsive */
@media(max-width:768px){
  .topbar{padding:0 14px;height:48px}
  .topbar-title{font-size:12px}
  .total-num{font-size:18px}
  .controls{padding:8px 14px;gap:6px;flex-wrap:wrap}
  .stats-pills{margin-left:0;width:100%;justify-content:space-around}
  .grid{padding:12px;gap:10px}
  .cell{padding:12px 8px;border-radius:14px}
  .back-btn span{display:none}
  .podium-wrap{padding:14px 12px 24px}
  .podium{gap:8px}
  .podium-block{border-radius:10px 10px 0 0}
  .p-num{font-size:24px}
  .p-photo{width:52px;height:52px}
  .p-name{font-size:10px;max-width:100px}
  .p-votes{font-size:11px}
  .p-crown{font-size:20px}
  .podium-modal{border-radius:20px}
}

/* Podium Modal */
.podium-overlay{position:fixed;inset:0;background:rgba(15,23,42,.7);z-index:300;display:none;align-items:center;justify-content:center;backdrop-filter:blur(6px);animation:fadeIn .3s ease}
.podium-overlay.show{display:flex}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
.podium-modal{background:linear-gradient(180deg,#0f172a 0%,#1e293b 100%);border-radius:28px;width:580px;max-width:94vw;overflow:hidden;animation:modalSlide .5s cubic-bezier(.175,.885,.32,1.275);position:relative}
@keyframes modalSlide{from{transform:translateY(60px) scale(.9);opacity:0}to{transform:translateY(0) scale(1);opacity:1}}
.podium-header{text-align:center;padding:28px 24px 12px;position:relative}
.podium-title{font-size:10px;font-weight:800;letter-spacing:4px;text-transform:uppercase;color:rgba(255,255,255,.4)}
.podium-main-title{font-size:24px;font-weight:900;color:#fff;margin-top:4px}
.podium-main-title span{background:linear-gradient(135deg,#fbbf24,#f59e0b);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.podium-close{position:absolute;top:16px;right:16px;width:36px;height:36px;border-radius:50%;border:1px solid rgba(255,255,255,.1);background:transparent;color:rgba(255,255,255,.5);font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .2s}
.podium-close:hover{background:rgba(255,255,255,.1);color:#fff}

.podium-wrap{padding:20px 24px 32px;position:relative}
.podium{display:flex;align-items:flex-end;justify-content:center;gap:12px}

/* Each column: info on top, block on bottom */
.podium-col{flex:1;max-width:170px;display:flex;flex-direction:column;align-items:center}

/* Info section above block */
.p-info{display:flex;flex-direction:column;align-items:center;gap:6px;margin-bottom:10px;opacity:0;transform:translateY(10px)}
.p-gold .p-info{animation:infoIn .5s 1.2s ease forwards}
.p-silver .p-info{animation:infoIn .5s 1.4s ease forwards}
.p-bronze .p-info{animation:infoIn .5s 1.6s ease forwards}
@keyframes infoIn{to{opacity:1;transform:translateY(0)}}

.p-crown{font-size:28px;animation:none;opacity:0;transform:scale(0)}
.p-gold .p-crown{animation:crownIn .4s 1.8s cubic-bezier(.175,.885,.32,1.275) forwards}
@keyframes crownIn{to{transform:scale(1) rotate(-10deg);opacity:1}}

.p-photo{width:68px;height:68px;border-radius:50%;object-fit:cover;border:3px solid rgba(255,255,255,.2);flex-shrink:0}
.p-gold .p-photo{border-color:#fbbf24;box-shadow:0 0 20px rgba(251,191,36,.3)}
.p-silver .p-photo{border-color:#94a3b8;box-shadow:0 0 12px rgba(148,163,184,.2)}
.p-bronze .p-photo{border-color:#d97706;box-shadow:0 0 12px rgba(217,119,6,.2)}

.p-name{font-size:12px;font-weight:700;color:#fff;text-align:center;line-height:1.35;max-width:150px;word-wrap:break-word}
.p-votes{font-size:13px;font-weight:800}
.p-gold .p-votes{color:#fbbf24}
.p-silver .p-votes{color:#cbd5e1}
.p-bronze .p-votes{color:#fbbf24}

/* Podium block */
.podium-block{width:100%;border-radius:14px 14px 0 0;display:flex;align-items:center;justify-content:center;overflow:hidden}
.p-gold .podium-block{background:linear-gradient(180deg,#fbbf24,#f59e0b);height:0;animation:riseGold 1s .4s cubic-bezier(.175,.885,.32,1.275) forwards}
.p-silver .podium-block{background:linear-gradient(180deg,#94a3b8,#64748b);height:0;animation:riseSilver 1s .6s cubic-bezier(.175,.885,.32,1.275) forwards}
.p-bronze .podium-block{background:linear-gradient(180deg,#d97706,#b45309);height:0;animation:riseBronze 1s .8s cubic-bezier(.175,.885,.32,1.275) forwards}
@keyframes riseGold{to{height:140px}}
@keyframes riseSilver{to{height:100px}}
@keyframes riseBronze{to{height:70px}}
.p-num{font-size:36px;font-weight:900;color:rgba(255,255,255,.3)}

/* Sparkle particles in podium */
.sparkle{position:absolute;width:4px;height:4px;border-radius:50%;background:#fbbf24;z-index:5;pointer-events:none;animation:sparkleFloat 1.5s ease-out forwards}
@keyframes sparkleFloat{0%{transform:scale(0);opacity:1}50%{transform:scale(1);opacity:.8}100%{transform:translateY(-40px) scale(0);opacity:0}}
</style>
</head>
<body>

<div class="topbar">
  <div class="topbar-left">
    <a href="/admin/dashboard" class="back-btn"><span class="back-arrow">&#8592;</span> <span>Dashboard</span></a>
    <div class="topbar-title">SABI FOR DUBAS BALI 2026</div>
  </div>
  <div class="topbar-right">
    <button class="ctrl-btn" onclick="showPodium()" style="border-color:#fbbf24;color:#d97706;background:rgba(251,191,36,.06);font-size:13px">&#127942; Top 3</button>
    <div class="streak-wrap" id="streak-wrap">
      <span class="streak-fire" id="streak-icon"></span>
      <span id="streak-text"></span>
    </div>
    <div class="total-wrap">
      <div class="total-num"><span class="live-dot"></span> <span id="total-votes">0</span></div>
      <div class="total-label">votes sesi ini</div>
    </div>
  </div>
</div>

<div class="controls" id="controls" style="display:none">
  <button class="ctrl-btn stop" id="btn-stop" onclick="stopAll()">&#9632; Stop</button>
  <button class="ctrl-btn reload" id="btn-reload" onclick="reloadExpired()">&#8635; Reload Expired</button>
  <div class="stats-pills">
    <div class="pill p-ok"><span class="pv" id="st-ok">0</span> ok</div>
    <div class="pill p-wait"><span class="pv" id="st-wait">0</span> pending</div>
    <div class="pill p-fail"><span class="pv" id="st-fail">0</span> expired</div>
  </div>
</div>

<div class="grid-wrap">
  <div class="empty-state" id="empty-state">
    <div class="empty-icon">&#9635;</div>
    <div class="empty-title">Bulk Vote Mode</div>
    <div class="empty-sub">Generate beberapa QR code sekaligus untuk voting massal. Bisa tambah hingga 10 QR.</div>
    <button class="empty-btn" onclick="addCell()">+ Mulai Generate</button>
  </div>
  <div class="grid" id="grid" style="display:none"></div>
</div>

<div id="milestone-el" class="milestone"></div>

<div class="podium-overlay" id="podium-overlay" onclick="if(event.target===this)closePodium()">
  <div class="podium-modal">
    <div class="podium-header">
      <div class="podium-title">DUTA BAHASA BALI 2026</div>
      <div class="podium-main-title"><span>Top 3 Klasemen</span></div>
      <button class="podium-close" onclick="closePodium()">&#10005;</button>
    </div>
    <div class="podium-wrap">
      <div class="podium" id="podium"></div>
    </div>
  </div>
</div>

<script>
var EVENT_SLUG = 'duta-bahasa-provinsi-bali-2026';
var CANDIDATE_ID = '019daa17-14c5-73eb-b2c8-b021dd884c4f';
var MAX_CELLS = 10;
var cells = [];
var running = false;
var totalVotes = 0;
var streak = 0;
var nextId = 1;

// Grid column layout
function gridCols(n) {
  var map = [0,1,2,3,2,3,3,4,4,3,5];
  return map[n] || Math.ceil(Math.sqrt(n));
}

function qrSize(n) {
  if (n <= 2) return 200;
  if (n <= 4) return 170;
  if (n <= 6) return 140;
  return 110;
}

function updateGridLayout() {
  var total = cells.length + (cells.length < MAX_CELLS ? 1 : 0); // +1 for add btn
  var cols = gridCols(total);
  var g = document.getElementById('grid');
  g.style.gridTemplateColumns = 'repeat(' + cols + ', 1fr)';
}

function showGrid() {
  document.getElementById('empty-state').style.display = 'none';
  document.getElementById('grid').style.display = '';
  document.getElementById('controls').style.display = '';
}

// Add cell
function addCell() {
  if (cells.length >= MAX_CELLS) return;
  showGrid();
  if (!running) running = true;

  var c = { id: nextId++, state: 'idle', voteId: null, expiresAt: null, votes: 0, poll: null, tick: null, pollDelay: 2000, nextQR: null, prefetching: false };
  cells.push(c);

  var el = document.createElement('div');
  el.className = 'cell';
  el.id = 'cell-' + c.id;
  document.getElementById('grid').appendChild(el);

  renderAddButton();
  updateGridLayout();
  genQR(c);
  updateStats();
}

function renderAddButton() {
  var existing = document.getElementById('add-cell');
  if (existing) existing.remove();
  if (cells.length >= MAX_CELLS) return;

  var btn = document.createElement('div');
  btn.className = 'add-cell';
  btn.id = 'add-cell';
  btn.onclick = addCell;
  btn.innerHTML = '<div class="add-icon">+</div><div class="add-label">Tambah QR</div><div class="add-count">' + cells.length + '/' + MAX_CELLS + '</div>';
  document.getElementById('grid').appendChild(btn);
}

function stopAll() {
  running = false;
  cells.forEach(function(c) { clearTimeout(c.poll); clearInterval(c.tick); });
  streak = 0;
  updateStreakDisplay();
}

function reloadExpired() {
  running = true;
  cells.forEach(function(c) {
    if (c.state === 'expired') genQR(c);
  });
}

// Fetch a new QR from API
async function fetchNewQR() {
  var res = await fetch('/event/' + EVENT_SLUG + '/vote/' + CANDIDATE_ID, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: '{}'
  });
  var text = await res.text();
  var data = JSON.parse(text);
  if (data.success && data.qr_string) return data;
  throw new Error(data.message || 'API error');
}

// Pre-fetch next QR in background while user is scanning current one
async function prefetchNextQR(c) {
  if (c.prefetching || c.nextQR) return;
  c.prefetching = true;
  try {
    c.nextQR = await fetchNewQR();
    console.log('Cell #' + c.id + ' pre-fetched next QR ready');
  } catch(e) {
    console.log('Cell #' + c.id + ' pre-fetch failed (will fetch on demand)');
    c.nextQR = null;
  }
  c.prefetching = false;
}

// Apply QR data to a cell (shared between genQR and instant swap)
function applyQR(c, data) {
  c.state = 'waiting';
  c.voteId = data.vote_id;
  c.expiresAt = new Date(data.expires_at);
  c.nextQR = null;
  c.prefetching = false;
  renderCell(c);

  var canvas = document.getElementById('cv-' + c.id);
  if (canvas) {
    var sz = qrSize(cells.length);
    QRCode.toCanvas(canvas, data.qr_string, {
      width: sz, margin: 2,
      color: { dark: '#1a3a5c', light: '#ffffff' },
      errorCorrectionLevel: 'M'
    });
  }

  c.pollDelay = 2000;
  schedulePoll(c);
  c.tick = setInterval(function() { updateTimer(c); }, 1000);
  updateTimer(c);
  updateStats();

  // Start pre-fetching next QR immediately
  prefetchNextQR(c);
}

async function genQR(c) {
  if (!running) { running = true; }
  clearTimeout(c.poll);
  clearInterval(c.tick);

  // If we have a pre-fetched QR, use it instantly (no loading state!)
  if (c.nextQR) {
    console.log('%c[PREFETCH] Cell #' + c.id + ' INSTANT swap — no loading!', 'color:#22c55e;font-weight:bold');
    var data = c.nextQR;
    applyQR(c, data);
    // Trigger flip animation
    var el = document.getElementById('cell-' + c.id);
    if (el) {
      el.classList.add('instant-swap');
      el.addEventListener('animationend', function() { el.classList.remove('instant-swap'); }, { once: true });
    }
    return;
  }

  // No pre-fetch available, fetch now with loading spinner
  console.log('%c[PREFETCH] Cell #' + c.id + ' pre-fetch NOT ready — fetching now...', 'color:#f59e0b;font-weight:bold');
  c.state = 'loading';
  c.voteId = null;
  c.expiresAt = null;
  renderCell(c);

  try {
    var data = await fetchNewQR();
    applyQR(c, data);
  } catch(e) {
    console.error('Fetch error cell #' + c.id, e);
    c.state = 'expired'; renderCell(c); updateStats();
  }
}

function schedulePoll(c) {
  clearTimeout(c.poll);
  c.poll = setTimeout(function() { pollStatus(c); }, c.pollDelay);
}

async function pollStatus(c) {
  if (!c.voteId || !running) return;
  try {
    var res = await fetch('/event/vote/' + c.voteId + '/status');
    var data = await res.json();
    var s = (data.status || '').toUpperCase();
    if (s === 'COMPLETED' || s === 'PAID' || s === 'SUCCESS' || s === 'SETTLED') {
      clearTimeout(c.poll); clearInterval(c.tick);
      c.votes++;
      totalVotes++;
      streak++;
      updateStats();
      updateStreakDisplay();
      showFloatPlus(c);
      playSuccess();
      checkMilestone();
      // INSTANT swap: use pre-fetched QR or fetch new one immediately
      if (running) genQR(c);
    } else if (s === 'EXPIRED') {
      clearTimeout(c.poll); clearInterval(c.tick);
      c.state = 'expired';
      c.nextQR = null;
      renderCell(c);
      updateStats();
    } else {
      // Gentle backoff: 2s -> 2.5s -> 3s -> 3.5s -> 4s (cap at 4s)
      c.pollDelay = Math.min(c.pollDelay + 500, 4000);
      schedulePoll(c);
    }
  } catch(e) {
    console.error('Poll error cell #' + c.id, e);
    c.pollDelay = Math.min(c.pollDelay + 1000, 5000);
    schedulePoll(c);
  }
}

function updateTimer(c) {
  if (!c.expiresAt) return;
  var diff = c.expiresAt.getTime() - Date.now();
  if (diff <= 0) {
    clearTimeout(c.poll); clearInterval(c.tick);
    c.state = 'expired';
    renderCell(c); updateStats();
    return;
  }
  var m = Math.floor(diff / 60000);
  var s = Math.floor((diff % 60000) / 1000);
  var el = document.getElementById('timer-' + c.id);
  if (el) el.textContent = m + ':' + String(s).padStart(2, '0');
}

function renderCell(c) {
  var el = document.getElementById('cell-' + c.id);
  if (!el) return;
  el.className = 'cell' + (c.state === 'waiting' ? ' is-waiting' : c.state === 'success' ? ' is-success' : c.state === 'expired' ? ' is-expired' : '');

  var vb = c.votes > 0 ? '<div class="cell-votes">' + c.votes + '</div><div class="cell-votes-lbl">votes</div>' : '';

  if (c.state === 'loading') {
    el.innerHTML = '<div class="cell-num">#' + c.id + '</div><div class="cell-spinner"></div><div class="cell-load-text">Membuat QRIS...</div>' + vb;
  } else if (c.state === 'waiting') {
    el.innerHTML = '<div class="cell-num">#' + c.id + '</div>' +
      '<div class="cell-status-badge badge-wait"><span class="bdot"></span> Menunggu Pembayaran</div>' +
      '<canvas id="cv-' + c.id + '"></canvas>' +
      '<div class="cell-amt">Nominal <b>Rp 1</b></div>' +
      '<div class="cell-timer" id="timer-' + c.id + '">3:00</div>' +
      '<div class="cell-hint">Scan dengan e-wallet</div>' + vb;
  } else if (c.state === 'success') {
    el.innerHTML = '<div class="cell-num">#' + c.id + '</div>' +
      '<div class="cell-status-badge badge-ok">&#10003; Berhasil</div>' +
      '<div class="cell-check">&#10003;</div>' +
      '<div class="cell-ok-text">Vote Terkirim!</div>' +
      '<div class="cell-ok-sub">Terima kasih!</div>' + vb +
      '<div class="cell-next">QR berikutnya...</div>';
  } else if (c.state === 'expired') {
    el.innerHTML = '<div class="cell-num">#' + c.id + '</div>' +
      '<div class="cell-status-badge badge-exp">Kadaluarsa</div>' +
      '<div class="cell-exp-icon">&#9200;</div>' + vb +
      '<button class="cell-retry" onclick="retryCell(' + c.id + ')">&#8635; Generate Ulang</button>';
  }
}

function retryCell(id) {
  var c = cells.find(function(x) { return x.id === id; });
  if (!c) return;
  if (!running) running = true;
  genQR(c);
}

function updateStats() {
  var ok = totalVotes;
  var wait = cells.filter(function(c) { return c.state === 'waiting' || c.state === 'loading'; }).length;
  var fail = cells.filter(function(c) { return c.state === 'expired'; }).length;
  document.getElementById('st-ok').textContent = ok;
  document.getElementById('st-wait').textContent = wait;
  document.getElementById('st-fail').textContent = fail;
  document.getElementById('total-votes').textContent = totalVotes;
}

// Streak display
function updateStreakDisplay() {
  var wrap = document.getElementById('streak-wrap');
  var icon = document.getElementById('streak-icon');
  var txt = document.getElementById('streak-text');
  if (streak < 2) { wrap.className = 'streak-wrap'; return; }
  var cls = streak >= 10 ? 'legend' : streak >= 5 ? 'fire' : 'hot';
  wrap.className = 'streak-wrap visible ' + cls;
  icon.innerHTML = streak >= 10 ? '&#11088;' : streak >= 5 ? '&#128293;&#128293;' : '&#128293;';
  txt.textContent = 'x' + streak;
  wrap.style.animation = 'none';
  wrap.offsetHeight;
  wrap.style.animation = 'popIn .35s ease';
}

// Float +1
function showFloatPlus(c) {
  var el = document.getElementById('cell-' + c.id);
  if (!el) return;
  var f = document.createElement('div');
  f.className = 'float-plus';
  f.textContent = '+1';
  el.appendChild(f);
  setTimeout(function() { f.remove(); }, 1000);
}

// Milestones
var lastMilestone = 0;
function checkMilestone() {
  var milestones = [5, 10, 25, 50, 100];
  for (var i = milestones.length - 1; i >= 0; i--) {
    if (totalVotes >= milestones[i] && lastMilestone < milestones[i]) {
      lastMilestone = milestones[i];
      showMilestone(milestones[i]);
      spawnConfetti();
      break;
    }
  }
}

function showMilestone(n) {
  var el = document.getElementById('milestone-el');
  var cls = n >= 50 ? 'm-50' : n >= 25 ? 'm-25' : n >= 10 ? 'm-10' : 'm-5';
  var emoji = n >= 50 ? '&#127942;' : n >= 25 ? '&#11088;' : n >= 10 ? '&#128293;' : '&#127881;';
  el.className = 'milestone ' + cls;
  el.innerHTML = emoji + ' ' + n + ' Votes! ' + emoji;
  setTimeout(function() { el.classList.add('show'); }, 50);
  setTimeout(function() { el.classList.remove('show'); }, 3500);
}

// Success chime using Web Audio API
var audioCtx = null;
function playSuccess() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    var notes = [523.25, 659.25, 783.99]; // C5 E5 G5 major arpeggio
    notes.forEach(function(freq, i) {
      var osc = audioCtx.createOscillator();
      var gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.type = 'sine';
      osc.frequency.value = freq;
      var t = audioCtx.currentTime + i * 0.1;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.25, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
      osc.start(t);
      osc.stop(t + 0.35);
    });
  } catch(e) {}
}

function spawnConfetti() {
  var colors = ['#c8956c','#22c55e','#f59e0b','#ef4444','#6366f1','#ec4899','#14b8a6'];
  for (var i = 0; i < 40; i++) {
    var p = document.createElement('div');
    p.className = 'confetti-piece';
    p.style.left = (Math.random() * 100) + '%';
    p.style.background = colors[Math.floor(Math.random() * colors.length)];
    p.style.animationDelay = (Math.random() * 0.8) + 's';
    p.style.animationDuration = (2 + Math.random() * 1.5) + 's';
    p.style.width = (6 + Math.random() * 6) + 'px';
    p.style.height = (8 + Math.random() * 8) + 'px';
    document.body.appendChild(p);
    (function(el) { setTimeout(function() { el.remove(); }, 4000); })(p);
  }
}

// Podium / Top 3
async function showPodium() {
  var overlay = document.getElementById('podium-overlay');
  var podium = document.getElementById('podium');
  overlay.classList.add('show');
  podium.innerHTML = '<div style="text-align:center;color:rgba(255,255,255,.4);padding:40px;font-size:13px">Memuat data...</div>';

  try {
    var res = await fetch('/api/events/' + EVENT_SLUG);
    var json = await res.json();
    var candidates = (json.data && json.data.candidates) || [];
    candidates.sort(function(a, b) { return b.votes - a.votes; });
    var top3 = candidates.slice(0, 3);

    if (top3.length < 3) {
      podium.innerHTML = '<div style="text-align:center;color:rgba(255,255,255,.4);padding:40px">Data tidak cukup</div>';
      return;
    }

    // Reorder: [2nd, 1st, 3rd] for podium layout
    var ordered = [top3[1], top3[0], top3[2]];
    var classes = ['p-silver', 'p-gold', 'p-bronze'];
    var nums = ['2', '1', '3'];
    var photoBase = 'https://voteqrisbali.com/storage/candidate-media/';

    podium.innerHTML = ordered.map(function(c, i) {
      var photo = c.photo || '';
      var fullName = (c.name || 'Unknown').replace(/^\d+\.\s*/, '');

      return '<div class="podium-col ' + classes[i] + '">' +
        '<div class="p-info">' +
          (i === 1 ? '<div class="p-crown">&#128081;</div>' : '') +
          (photo ? '<img class="p-photo" src="' + photo + '" alt="" />' : '<div class="p-photo" style="background:#334155;width:68px;height:68px;border-radius:50%"></div>') +
          '<div class="p-name">' + fullName + '</div>' +
          '<div class="p-votes">' + c.votes.toLocaleString() + ' votes</div>' +
        '</div>' +
        '<div class="podium-block"><div class="p-num">' + nums[i] + '</div></div>' +
        '</div>';
    }).join('');

    // Sparkle particles for gold
    setTimeout(function() { spawnPodiumSparkles(); }, 1500);
    // Play a fanfare
    playFanfare();
  } catch(e) {
    podium.innerHTML = '<div style="text-align:center;color:rgba(255,255,255,.4);padding:40px">Gagal memuat data</div>';
  }
}

function closePodium() {
  document.getElementById('podium-overlay').classList.remove('show');
}

function spawnPodiumSparkles() {
  var wrap = document.querySelector('.p-gold .podium-block');
  if (!wrap) return;
  var colors = ['#fbbf24','#fde68a','#fff','#f59e0b'];
  for (var i = 0; i < 12; i++) {
    (function(idx) {
      setTimeout(function() {
        var s = document.createElement('div');
        s.className = 'sparkle';
        s.style.left = (Math.random() * 100) + '%';
        s.style.top = (Math.random() * 60) + '%';
        s.style.background = colors[Math.floor(Math.random() * colors.length)];
        s.style.animationDelay = (Math.random() * 0.5) + 's';
        wrap.appendChild(s);
        setTimeout(function() { s.remove(); }, 2000);
      }, idx * 150);
    })(i);
  }
}

function playFanfare() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    // Fanfare: C5 E5 G5 C6 - triumphant
    var notes = [523.25, 659.25, 783.99, 1046.50];
    notes.forEach(function(freq, i) {
      var osc = audioCtx.createOscillator();
      var gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.type = i < 3 ? 'triangle' : 'sine';
      osc.frequency.value = freq;
      var t = audioCtx.currentTime + i * 0.15;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(i === 3 ? 0.3 : 0.2, t + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.001, t + (i === 3 ? 0.8 : 0.4));
      osc.start(t);
      osc.stop(t + (i === 3 ? 0.8 : 0.4));
    });
  } catch(e) {}
}
</script>
</body></html>`
}
