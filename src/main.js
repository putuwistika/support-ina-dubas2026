import './style.css'
import QRCode from 'qrcode'

const API_BASE = ''
const EVENT_SLUG = 'duta-bahasa-provinsi-bali-2026'
const CANDIDATE_ID = '019daa17-14c5-73eb-b2c8-b021dd884c4f'
const CANDIDATE_NAME = 'Ni Putu Sabrina Abelia Putri'
const CANDIDATE_UNIV = 'Universitas Udayana'
const CANDIDATE_PHOTO = 'https://voteqrisbali.com/storage/candidate-media/01KPN1E55P7A35G1MA7MX71FBP.jpg'

const state = {
  accessKey: null,
  keyExpiresAt: null,
  authenticated: false,
  page: 'landing',
  voteCount: 0,
  allCandidates: [],
  femaleRank: '-',
  femaleCandidates: [],
  qrState: 'idle',
  currentVoteId: null,
  expiresAt: null,
  sessionVotes: 0,
  pollInterval: null,
  timerInterval: null,
  lbFilter: 'female', // 'all' | 'female' | 'male'
  lbExpanded: false,
}

const app = document.getElementById('app')

// ==================== DATA ====================
async function fetchVoteCount() {
  try {
    const res = await fetch(`${API_BASE}/api/events/${EVENT_SLUG}`)
    const json = await res.json()
    const candidates = json.data?.candidates || []
    state.allCandidates = candidates

    const sabrina = candidates.find(c => c.id === CANDIDATE_ID)
    if (sabrina) {
      state.voteCount = sabrina.votes
    }

    // Female = even number, Male = odd number
    state.femaleCandidates = candidates
      .filter(c => c.number % 2 === 0)
      .sort((a, b) => b.votes - a.votes)

    const femaleIdx = state.femaleCandidates.findIndex(c => c.id === CANDIDATE_ID)
    state.femaleRank = femaleIdx >= 0 ? femaleIdx + 1 : '-'

    updateAllDisplays()
  } catch (e) {
    console.error('Failed to fetch data:', e)
  }
}

function updateAllDisplays() {
  document.querySelectorAll('[data-vote-count]').forEach(el => {
    el.textContent = state.voteCount.toLocaleString('id-ID')
  })
  document.querySelectorAll('[data-female-rank]').forEach(el => {
    el.textContent = `#${state.femaleRank}`
  })
  // Re-render leaderboard if on landing page
  if (state.page === 'landing') {
    const lbContainer = document.getElementById('lb-list')
    if (lbContainer) renderLeaderboardList(lbContainer)
  }
}

// ==================== LEADERBOARD ====================
function getFilteredCandidates() {
  const all = [...state.allCandidates]
  if (state.lbFilter === 'female') return all.filter(c => c.number % 2 === 0).sort((a, b) => b.votes - a.votes)
  if (state.lbFilter === 'male') return all.filter(c => c.number % 2 !== 0).sort((a, b) => b.votes - a.votes)
  return all.sort((a, b) => b.votes - a.votes)
}

function renderLeaderboardList(container) {
  const sorted = getFilteredCandidates()
  const limit = state.lbExpanded ? sorted.length : 5
  const items = sorted.slice(0, limit)

  container.innerHTML = items.map((c, i) => {
    const pos = i + 1
    const isSabrina = c.id === CANDIDATE_ID
    const posClass = pos === 1 ? 'top-1' : pos === 2 ? 'top-2' : pos === 3 ? 'top-3' : ''
    const shortName = c.name.replace(/^\d+\.\s*/, '')

    return `
      <div class="lb-item ${isSabrina ? 'is-sabrina' : ''} anim-fade-up" style="animation-delay: ${i * 0.03}s">
        <div class="lb-pos ${posClass}">${pos}</div>
        <img class="lb-avatar" src="${c.photo}" alt="" loading="lazy" />
        <div class="lb-info">
          <div class="lb-name">${shortName}</div>
          <div class="lb-univ">${c.description}</div>
        </div>
        <div class="lb-votes">
          <div class="lb-votes-val">${c.votes.toLocaleString('id-ID')}</div>
          <div class="lb-votes-pct">${c.percentage}%</div>
        </div>
      </div>
    `
  }).join('')

  if (sorted.length > 5) {
    container.innerHTML += `
      <div class="lb-more" id="lb-toggle">
        ${state.lbExpanded ? 'Tampilkan lebih sedikit ▲' : `Lihat semua (${sorted.length}) ▼`}
      </div>
    `
    document.getElementById('lb-toggle').onclick = () => {
      state.lbExpanded = !state.lbExpanded
      renderLeaderboardList(container)
    }
  }
}

// ==================== VOTE ====================
async function initiateVote() {
  state.qrState = 'loading'
  renderQuickVote()

  try {
    const res = await fetch(`${API_BASE}/event/${EVENT_SLUG}/vote/${CANDIDATE_ID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-Access-Key': state.accessKey || '' },
    })
    const data = await res.json()

    if (data.success && data.qr_string) {
      state.currentVoteId = data.vote_id
      state.expiresAt = new Date(data.expires_at)
      state.qrState = 'showing'
      renderQuickVote()
      renderQRCode(data.qr_string)
      startStatusPolling()
      startTimer()
    } else {
      throw new Error(data.message || 'Vote failed')
    }
  } catch (e) {
    console.error('Vote failed:', e)
    state.qrState = 'idle'
    renderQuickVote()
    showToast('Gagal membuat QR. Coba lagi.')
  }
}

async function renderQRCode(qrString) {
  const canvas = document.getElementById('qr-canvas')
  if (!canvas) return
  await QRCode.toCanvas(canvas, qrString, {
    width: 220,
    margin: 2,
    color: { dark: '#1a3a5c', light: '#ffffff' },
    errorCorrectionLevel: 'M',
  })
}

// ==================== POLLING & TIMER ====================
function startStatusPolling() {
  stopPolling()
  state.pollInterval = setInterval(async () => {
    if (!state.currentVoteId) return
    try {
      const res = await fetch(`${API_BASE}/event/vote/${state.currentVoteId}/status`)
      const data = await res.json()
      const s = (data.status || '').toUpperCase()
      if (s === 'COMPLETED' || s === 'PAID') {
        state.sessionVotes++
        stopPolling()
        stopTimer()
        fetchVoteCount()
        state.qrState = 'success'
        renderQuickVote()
        // Auto-next after 1.5s
        setTimeout(() => initiateVote(), 1500)
      } else if (s === 'EXPIRED') {
        state.qrState = 'expired'
        stopPolling()
        stopTimer()
        renderQuickVote()
      }
    } catch (e) {
      console.error('Poll error:', e)
    }
  }, 3000)
}

function stopPolling() {
  if (state.pollInterval) { clearInterval(state.pollInterval); state.pollInterval = null }
}

function startTimer() {
  stopTimer()
  updateTimer()
  state.timerInterval = setInterval(updateTimer, 1000)
}

function stopTimer() {
  if (state.timerInterval) { clearInterval(state.timerInterval); state.timerInterval = null }
}

function updateTimer() {
  if (!state.expiresAt) return
  const diff = state.expiresAt.getTime() - Date.now()
  if (diff <= 0) {
    state.qrState = 'expired'
    stopPolling()
    stopTimer()
    renderQuickVote()
    return
  }
  const m = Math.floor(diff / 60000)
  const s = Math.floor((diff % 60000) / 1000)
  const el = document.getElementById('qr-timer-val')
  if (el) el.textContent = `${m}:${s.toString().padStart(2, '0')}`
}

// ==================== TOAST ====================
function showToast(msg) {
  document.querySelectorAll('.toast').forEach(t => t.remove())
  const t = document.createElement('div')
  t.className = 'toast'
  t.textContent = msg
  document.body.appendChild(t)
  setTimeout(() => { t.classList.add('toast-out'); setTimeout(() => t.remove(), 300) }, 2700)
}

// ==================== RENDER: LANDING ====================
function renderLanding() {
  state.page = 'landing'
  state.lbExpanded = false
  stopPolling()
  stopTimer()

  const totalFemale = state.femaleCandidates.length || 10

  app.innerHTML = `
    <div class="landing">
      <!-- Top Bar -->
      <div class="topbar anim-fade-up">
        <div class="topbar-event">Duta Bahasa Bali 2026</div>
        <div class="topbar-live"><div class="live-dot"></div> Live</div>
      </div>

      <div class="landing-desktop-grid">
        <!-- LEFT: Hero + Stats -->
        <div class="landing-left">
          <div class="hero">
            <div class="hero-number">02</div>
            <div class="hero-name">${CANDIDATE_NAME}</div>
            <div class="hero-univ">${CANDIDATE_UNIV}</div>
            <div class="hero-photo-wrap">
              <div class="hero-photo-ring"></div>
              <img class="hero-photo" src="${CANDIDATE_PHOTO}" alt="${CANDIDATE_NAME}" />
            </div>
          </div>

          <!-- Stats -->
          <div class="stats-row anim-fade-up-1">
            <div class="stat">
              <div class="stat-val has-live" data-vote-count>${state.voteCount.toLocaleString('id-ID')}</div>
              <div class="stat-lbl">Vote</div>
            </div>
            <div class="stat-sep"></div>
            <div class="stat">
              <div class="stat-val accent" data-female-rank>#${state.femaleRank}</div>
              <div class="stat-lbl">Rank Putri</div>
            </div>
            <div class="stat-sep"></div>
            <div class="stat">
              <div class="stat-val" style="font-size: 15px; color: var(--success)">Rp 1</div>
              <div class="stat-lbl">Per Vote</div>
            </div>
          </div>
        </div>

        <!-- RIGHT: Rank + Leaderboard + CTA -->
        <div class="landing-right">
          <!-- Rank Card -->
          <div class="rank-section anim-fade-up-2">
            <div class="rank-card">
              <div class="rank-badge" data-female-rank>#${state.femaleRank}</div>
              <div class="rank-info">
                <div class="rank-title">Klasemen Putri</div>
                <div class="rank-value">Peringkat <span>dari ${totalFemale} peserta putri</span></div>
              </div>
              <div class="rank-arrow">›</div>
            </div>
          </div>

          <!-- Leaderboard -->
          <div class="leaderboard-section anim-fade-up-3">
            <div class="section-head">
              <div class="section-title">Klasemen</div>
              <div class="section-filter">
                <button class="filter-btn ${state.lbFilter === 'female' ? 'active' : ''}" data-filter="female">Putri</button>
                <button class="filter-btn ${state.lbFilter === 'male' ? 'active' : ''}" data-filter="male">Putra</button>
                <button class="filter-btn ${state.lbFilter === 'all' ? 'active' : ''}" data-filter="all">Semua</button>
              </div>
            </div>
            <div class="lb-list" id="lb-list"></div>
          </div>

          <!-- CTA -->
          <div class="cta-section anim-fade-up-4">
            <button class="btn btn-vote" id="btn-vote">
              ⚡ Vote Sabrina Sekarang
            </button>
          </div>

          <div class="footer">
            #SupportINA #INAforDUBASBALI &bull; Powered by <a href="https://putuwistika.com" target="_blank">PutuWistika.com</a>
          </div>
        </div>
      </div>
    </div>
  `

  // Leaderboard
  const lbList = document.getElementById('lb-list')
  if (lbList) renderLeaderboardList(lbList)

  // Filter buttons
  document.querySelectorAll('[data-filter]').forEach(btn => {
    btn.onclick = () => {
      state.lbFilter = btn.dataset.filter
      state.lbExpanded = false
      document.querySelectorAll('[data-filter]').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      if (lbList) renderLeaderboardList(lbList)
    }
  })

  // Vote button
  document.getElementById('btn-vote').onclick = () => {
    state.qrState = 'idle'
    renderQuickVote()
    initiateVote()
  }
}

// ==================== RENDER: QUICK VOTE ====================
function renderQuickVote() {
  state.page = 'quickvote'

  let cardContent = ''

  if (state.qrState === 'loading') {
    cardContent = `
      <div class="qr-card">
        <div class="qr-loading">
          <div class="spinner"></div>
          <div class="qr-loading-text">Membuat QRIS...</div>
        </div>
      </div>
    `
  } else if (state.qrState === 'showing') {
    cardContent = `
      <div class="qr-card">
        <div class="qr-badge waiting"><span class="qr-badge-dot"></span> Menunggu Pembayaran</div>
        <div class="qr-frame"><canvas id="qr-canvas"></canvas></div>
        <div class="qr-amount-row">
          <div class="qr-amount-label">Nominal</div>
          <div class="qr-amount-value">Rp 1</div>
        </div>
        <div class="qr-timer-row">Berlaku <strong id="qr-timer-val">3:00</strong></div>
        <div class="qr-scan-hint">Scan dengan e-wallet atau mobile banking</div>
      </div>
    `
  } else if (state.qrState === 'success') {
    cardContent = `
      <div class="qr-card">
        <div class="qr-badge success"><span class="qr-badge-dot"></span> Berhasil</div>
        <div class="qr-success-icon">✓</div>
        <div class="qr-success-title">Vote Terkirim!</div>
        <div class="qr-success-sub">Terima kasih sudah dukung Sabrina</div>
        <div class="qr-auto-next">Membuat QR berikutnya...</div>
      </div>
    `
  } else if (state.qrState === 'expired') {
    cardContent = `
      <div class="qr-card">
        <div class="qr-badge expired"><span class="qr-badge-dot"></span> Kadaluarsa</div>
        <div class="qr-expired-icon">⏰</div>
        <div class="qr-success-title">Waktu Habis</div>
        <div class="qr-success-sub">Tekan tombol di bawah untuk QR baru</div>
      </div>
    `
  } else {
    cardContent = `
      <div class="qr-card">
        <div class="qr-loading">
          <div class="spinner"></div>
          <div class="qr-loading-text">Mempersiapkan...</div>
        </div>
      </div>
    `
  }

  let actions = ''
  if (state.qrState === 'expired') {
    actions = `
      <button class="btn btn-next" id="btn-retry">⚡ Vote Lagi</button>
      <button class="btn btn-ghost" id="btn-back">← Kembali</button>
    `
  } else if (state.qrState === 'showing') {
    actions = `
      <button class="btn btn-outline-accent" id="btn-skip">🔄 Buat QR Baru</button>
      <button class="btn btn-ghost" id="btn-back">← Kembali</button>
    `
  } else {
    actions = `<button class="btn btn-ghost" id="btn-back">← Kembali</button>`
  }

  app.innerHTML = `
    <div class="qv">
      <div class="qv-topbar">
        <button class="qv-back-btn" id="btn-header-back">←</button>
        <div class="qv-topbar-info">
          <div class="qv-topbar-name">02. ${CANDIDATE_NAME}</div>
          <div class="qv-topbar-sub">Quick Vote Mode</div>
        </div>
        <div class="qv-topbar-votes">
          <div class="qv-topbar-votes-val" data-vote-count>${state.voteCount.toLocaleString('id-ID')}</div>
          <div class="qv-topbar-votes-lbl">Votes</div>
        </div>
      </div>

      <div class="qv-body">
        ${state.sessionVotes > 0 ? `
          <div class="qv-session-pill anim-fade-up">
            Sesi ini: <strong>${state.sessionVotes} vote</strong> terkirim
          </div>
        ` : ''}

        ${cardContent}

        <div class="qv-actions">
          ${actions}
        </div>
      </div>
    </div>
  `

  // Bind events
  const bind = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn }

  bind('btn-retry', () => initiateVote())
  bind('btn-skip', () => { stopPolling(); stopTimer(); initiateVote() })
  bind('btn-back', goBack)
  bind('btn-header-back', goBack)
}

function goBack() {
  stopPolling()
  stopTimer()
  state.qrState = 'idle'
  renderLanding()
}

// ==================== ACCESS KEY GATE ====================
function renderKeyGate(error = '') {
  app.innerHTML = `
    <div class="landing" style="min-height:100dvh; display:flex; flex-direction:column; align-items:center; justify-content:center;">
      <div class="topbar" style="position:absolute; top:0; left:0; right:0;">
        <div class="topbar-event">Duta Bahasa Bali 2026</div>
        <div class="topbar-live"><div class="live-dot"></div> Live</div>
      </div>
      <div style="text-align:center; padding: 20px; max-width: 360px; width: 100%;" class="anim-fade-up">
        <div style="font-size:48px; margin-bottom:16px;">🔐</div>
        <h2 style="font-size:20px; font-weight:800; color:var(--text); margin-bottom:6px;">Masukkan Access Key</h2>
        <p style="font-size:13px; color:var(--text-dim); margin-bottom:24px;">Hubungi admin untuk mendapatkan access key</p>
        ${error ? `<div style="background:rgba(224,92,92,0.08); border:1.5px solid rgba(224,92,92,0.2); color:#e05c5c; padding:10px 14px; border-radius:10px; font-size:13px; font-weight:600; margin-bottom:16px;">${error}</div>` : ''}
        <div style="display:flex; gap:8px;">
          <input type="text" id="key-input" placeholder="Masukkan key..." maxlength="8"
            style="flex:1; padding:14px 16px; border-radius:12px; border:1.5px solid var(--border); background:var(--surface); font-family:inherit; font-size:16px; font-weight:700; text-align:center; letter-spacing:4px; text-transform:uppercase; outline:none; color:var(--text);" />
        </div>
        <button class="btn btn-vote" id="btn-key-submit" style="margin-top:12px;">
          Masuk
        </button>
      </div>
      <div class="footer" style="position:absolute; bottom:0; left:0; right:0;">
        #SupportINA #INAforDUBASBALI &bull; Powered by <a href="https://putuwistika.com" target="_blank">PutuWistika.com</a>
      </div>
    </div>
  `

  const input = document.getElementById('key-input')
  const btn = document.getElementById('btn-key-submit')

  const submit = () => {
    const key = input.value.trim().toUpperCase()
    if (key) validateKey(key)
  }

  btn.onclick = submit
  input.onkeydown = (e) => { if (e.key === 'Enter') submit() }
  input.focus()
}

async function validateKey(key) {
  try {
    const res = await fetch(`${API_BASE}/api/validate-key?key=${encodeURIComponent(key)}`)
    const data = await res.json()
    if (data.valid) {
      state.accessKey = key
      state.keyExpiresAt = new Date(data.expiresAt)
      state.authenticated = true
      // Save to sessionStorage
      sessionStorage.setItem('vote_key', key)
      // Remove key from URL if present
      const url = new URL(window.location)
      if (url.searchParams.has('key')) {
        url.searchParams.delete('key')
        window.history.replaceState({}, '', url)
      }
      startKeyExpiryCheck()
      fetchVoteCount().then(() => renderLanding())
    } else {
      renderKeyGate('Key tidak valid atau sudah kadaluarsa')
    }
  } catch (e) {
    renderKeyGate('Gagal memvalidasi key. Coba lagi.')
  }
}

function startKeyExpiryCheck() {
  setInterval(() => {
    if (state.keyExpiresAt && Date.now() > state.keyExpiresAt.getTime()) {
      state.authenticated = false
      stopPolling()
      stopTimer()
      sessionStorage.removeItem('vote_key')
      renderKeyGate('Access key sudah kadaluarsa. Minta key baru ke admin.')
    }
  }, 10000)
}

// ==================== INIT ====================
async function init() {
  // Check URL param first
  const urlParams = new URLSearchParams(window.location.search)
  const urlKey = urlParams.get('key')
  const storedKey = sessionStorage.getItem('vote_key')
  const keyToTry = urlKey || storedKey

  if (keyToTry) {
    await validateKey(keyToTry)
  } else {
    renderKeyGate()
  }

  setInterval(fetchVoteCount, 60000)
}

init()
