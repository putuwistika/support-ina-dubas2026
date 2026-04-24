import './style.css'
import QRCode from 'qrcode'

const API_BASE = ''
const EVENT_SLUG = 'duta-bahasa-provinsi-bali-2026'
const CANDIDATE_ID = '019daa17-14c5-73eb-b2c8-b021dd884c4f'
const CANDIDATE_NAME = 'Ni Putu Sabrina Abelia Putri'
const CANDIDATE_UNIV = 'Universitas Udayana'
const CANDIDATE_PHOTO = 'https://voteqrisbali.com/storage/candidate-media/01KPN1E55P7A35G1MA7MX71FBP.jpg'

// Success chime
let audioCtx = null
function playSuccess() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)()
    const notes = [523.25, 659.25, 783.99] // C5 E5 G5 major arpeggio
    notes.forEach((freq, i) => {
      const osc = audioCtx.createOscillator()
      const gain = audioCtx.createGain()
      osc.connect(gain)
      gain.connect(audioCtx.destination)
      osc.type = 'sine'
      osc.frequency.value = freq
      const t = audioCtx.currentTime + i * 0.1
      gain.gain.setValueAtTime(0, t)
      gain.gain.linearRampToValueAtTime(0.25, t + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.35)
      osc.start(t)
      osc.stop(t + 0.35)
    })
  } catch (e) {}
}

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
  lbFilter: 'all', // 'all' | 'female' | 'male'
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
  const allSortedUp = [...state.allCandidates].sort((a, b) => b.votes - a.votes)
  const overallRankUp = allSortedUp.findIndex(c => c.id === CANDIDATE_ID) + 1 || '-'
  document.querySelectorAll('[data-overall-rank]').forEach(el => {
    el.textContent = `#${overallRankUp}`
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
let nextQRData = null
let prefetching = false

async function fetchNewVoteQR() {
  const res = await fetch(`${API_BASE}/event/${EVENT_SLUG}/vote/${CANDIDATE_ID}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-Access-Key': state.accessKey || '' },
  })
  const data = await res.json()
  if (data.success && data.qr_string) return data
  throw new Error(data.message || 'Vote failed')
}

// Pre-fetch next QR while user is scanning current one
async function prefetchNextVoteQR() {
  if (prefetching || nextQRData) return
  prefetching = true
  try {
    nextQRData = await fetchNewVoteQR()
  } catch (e) {
    nextQRData = null
  }
  prefetching = false
}

function applyVoteQR(data) {
  state.currentVoteId = data.vote_id
  state.expiresAt = new Date(data.expires_at)
  state.qrState = 'showing'
  nextQRData = null
  prefetching = false
  renderQuickVote()
  renderQRCode(data.qr_string)
  startStatusPolling()
  startTimer()
  // Pre-fetch next QR immediately
  prefetchNextVoteQR()
}

async function initiateVote() {
  // If pre-fetched QR is ready, use it instantly
  if (nextQRData) {
    applyVoteQR(nextQRData)
    return
  }

  state.qrState = 'loading'
  renderQuickVote()

  try {
    const data = await fetchNewVoteQR()
    applyVoteQR(data)
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
let pollDelay = 2000

function startStatusPolling() {
  stopPolling()
  pollDelay = 2000
  schedulePoll()
}

function schedulePoll() {
  stopPolling()
  state.pollInterval = setTimeout(async () => {
    if (!state.currentVoteId) return
    try {
      const res = await fetch(`${API_BASE}/event/vote/${state.currentVoteId}/status`)
      const data = await res.json()
      const s = (data.status || '').toUpperCase()
      if (s === 'COMPLETED' || s === 'PAID' || s === 'SUCCESS' || s === 'SETTLED') {
        state.sessionVotes++
        stopPolling()
        stopTimer()
        fetchVoteCount()
        playSuccess()
        // Instant swap to next QR
        initiateVote()
      } else if (s === 'EXPIRED') {
        state.qrState = 'expired'
        nextQRData = null
        stopPolling()
        stopTimer()
        renderQuickVote()
      } else {
        pollDelay = Math.min(pollDelay + 500, 4000)
        schedulePoll()
      }
    } catch (e) {
      console.error('Poll error:', e)
      pollDelay = Math.min(pollDelay + 1000, 5000)
      schedulePoll()
    }
  }, pollDelay)
}

function stopPolling() {
  if (state.pollInterval) { clearTimeout(state.pollInterval); state.pollInterval = null }
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
  const totalAll = state.allCandidates.length || 20
  const allSorted = [...state.allCandidates].sort((a, b) => b.votes - a.votes)
  const overallRank = allSorted.findIndex(c => c.id === CANDIDATE_ID) + 1 || '-'

  app.innerHTML = `
    <div class="landing">
      <!-- Top Bar -->
      <div class="topbar anim-fade-up">
        <div class="topbar-event">SABI FOR DUBAS BALI 2026</div>
        <div class="topbar-right">
          <div class="topbar-live"><div class="live-dot"></div> Live</div>
          <button class="topbar-logout" id="btn-logout" title="Logout">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
          </button>
        </div>
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
              <div class="stat-val accent" data-overall-rank>#${overallRank}</div>
              <div class="stat-lbl">Rank</div>
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
              <div class="rank-badge">#${overallRank}</div>
              <div class="rank-info">
                <div class="rank-title">Klasemen Keseluruhan</div>
                <div class="rank-value">Peringkat <span>dari ${totalAll} peserta</span></div>
              </div>
              <div class="rank-arrow">›</div>
            </div>
          </div>

          <!-- Leaderboard -->
          <div class="leaderboard-section anim-fade-up-3">
            <div class="section-head">
              <div class="section-title">Klasemen</div>
              <div class="section-filter">
                <button class="filter-btn ${state.lbFilter === 'all' ? 'active' : ''}" data-filter="all">Semua</button>
                <button class="filter-btn ${state.lbFilter === 'female' ? 'active' : ''}" data-filter="female">Putri</button>
                <button class="filter-btn ${state.lbFilter === 'male' ? 'active' : ''}" data-filter="male">Putra</button>
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

  // Logout button
  document.getElementById('btn-logout').onclick = () => {
    state.authenticated = false
    state.accessKey = null
    state.keyExpiresAt = null
    sessionStorage.removeItem('vote_key')
    stopPolling()
    stopTimer()
    renderKeyGate()
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
  bind('btn-skip', () => { stopPolling(); stopTimer(); nextQRData = null; initiateVote() })
  bind('btn-back', goBack)
  bind('btn-header-back', goBack)
}

function goBack() {
  stopPolling()
  stopTimer()
  nextQRData = null
  state.qrState = 'idle'
  renderLanding()
}

// ==================== ACCESS KEY GATE ====================
function getGateFilteredCandidates(filter) {
  const all = [...state.allCandidates]
  if (filter === 'female') return all.filter(c => c.number % 2 === 0).sort((a, b) => b.votes - a.votes)
  if (filter === 'male') return all.filter(c => c.number % 2 !== 0).sort((a, b) => b.votes - a.votes)
  return all.sort((a, b) => b.votes - a.votes)
}

function renderGateLeaderboard(filter = 'all') {
  const candidates = getGateFilteredCandidates(filter).slice(0, 10)

  if (!candidates.length) return '<div class="gate-lb-empty">Memuat klasemen...</div>'

  return candidates.map((c, i) => {
    const pos = i + 1
    const isSabrina = c.id === CANDIDATE_ID
    const posClass = pos === 1 ? 'top-1' : pos === 2 ? 'top-2' : pos === 3 ? 'top-3' : ''
    const shortName = c.name.replace(/^\d+\.\s*/, '')
    return `
      <div class="gate-lb-item ${isSabrina ? 'is-ina' : ''}" style="animation-delay: ${i * 0.06}s">
        <div class="gate-lb-pos ${posClass}">${pos}</div>
        <img class="gate-lb-avatar" src="${c.photo}" alt="" loading="lazy" />
        <div class="gate-lb-info">
          <div class="gate-lb-name">${shortName}</div>
          <div class="gate-lb-votes">${c.votes.toLocaleString('id-ID')} votes</div>
        </div>
        ${isSabrina ? '<div class="gate-lb-ina-tag">INA</div>' : ''}
      </div>
    `
  }).join('')
}

function renderKeyGate(error = '') {
  // Fetch leaderboard data for the gate page
  if (!state.allCandidates.length) {
    fetchVoteCount().then(() => {
      const lbContainer = document.getElementById('gate-lb-list')
      if (lbContainer) lbContainer.innerHTML = renderGateLeaderboard('all')
      // Update sabrina pill after data loads
      const rankEl = document.querySelector('.gate-lb-sabrina-rank')
      if (rankEl) {
        const s = state.femaleCandidates.find(c => c.id === CANDIDATE_ID)
        const allS = [...state.allCandidates].sort((a, b) => b.votes - a.votes)
        const oRank = allS.findIndex(c => c.id === CANDIDATE_ID) + 1
        rankEl.innerHTML = `#${state.femaleRank} Putri &middot; #${oRank || '-'} Overall &middot; ${s ? s.votes.toLocaleString('id-ID') : '...'}`
      }
    })
  }

  const sabrina = state.femaleCandidates.find(c => c.id === CANDIDATE_ID)
  const sabrinaVotes = sabrina ? sabrina.votes.toLocaleString('id-ID') : '...'
  const allSorted = [...state.allCandidates].sort((a, b) => b.votes - a.votes)
  const overallRank = allSorted.findIndex(c => c.id === CANDIDATE_ID) + 1

  app.innerHTML = `
    <div class="gate">
      <div class="gate-topbar">
        <div class="gate-topbar-inner">
          <div class="gate-topbar-event">SABI FOR DUBAS BALI 2026</div>
          <div class="gate-topbar-live"><span class="gate-live-dot"></span> LIVE</div>
        </div>
      </div>

      <div class="gate-split">
        <!-- LEFT: Leaderboard -->
        <div class="gate-left">
          <div class="gate-lb-wrapper">
            <div class="gate-lb-header">
              <div class="gate-lb-title-row">
                <div class="gate-lb-icon">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
                </div>
                <div>
                  <h2 class="gate-lb-title">Klasemen</h2>
                  <p class="gate-lb-subtitle">Top 10 kandidat saat ini</p>
                </div>
              </div>
              <div class="gate-lb-sabrina-pill">
                <img class="gate-lb-sabrina-img" src="${CANDIDATE_PHOTO}" alt="" />
                <div>
                  <div class="gate-lb-sabrina-name">Sabrina</div>
                  <div class="gate-lb-sabrina-rank">#${state.femaleRank} Putri &middot; #${overallRank || '-'} Overall &middot; ${sabrinaVotes}</div>
                </div>
              </div>
              <div class="gate-lb-filters" id="gate-lb-filters">
                <button class="gate-filter-btn active" data-gf="all">Semua</button>
                <button class="gate-filter-btn" data-gf="female">Putri</button>
                <button class="gate-filter-btn" data-gf="male">Putra</button>
              </div>
            </div>
            <div class="gate-lb-list" id="gate-lb-list">
              ${renderGateLeaderboard('all')}
            </div>
          </div>
        </div>

        <!-- RIGHT: Access Key -->
        <div class="gate-right">
          <div class="gate-key-card anim-fade-up">
            <div class="gate-key-hero">
              <div class="gate-key-number">02</div>
              <img class="gate-key-photo" src="${CANDIDATE_PHOTO}" alt="${CANDIDATE_NAME}" />
            </div>
            <div class="gate-key-content">
              <h1 class="gate-key-title">Support INA</h1>
              <p class="gate-key-desc">Dukung <strong>Ni Putu Sabrina Abelia Putri</strong></p>
              ${error ? `<div class="gate-key-error">${error}</div>` : ''}
              <div class="gate-key-input-group">
                <label class="gate-key-label">Access Key</label>
                <input type="text" id="key-input" class="gate-key-input" placeholder="XXXXXXXX" maxlength="8" autocomplete="off" spellcheck="false" />
              </div>
              <button class="gate-key-btn" id="btn-key-submit">
                <span>Masuk</span>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
              </button>
              <p class="gate-key-hint">Hubungi admin untuk mendapatkan access key</p>
            </div>
          </div>

          <div class="gate-footer">
            #SupportINA #INAforDUBASBALI &bull; <a href="https://putuwistika.com" target="_blank">PutuWistika.com</a>
          </div>
        </div>
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

  // Gate leaderboard filter buttons
  let gateFilter = 'all'
  document.querySelectorAll('[data-gf]').forEach(btn => {
    btn.onclick = () => {
      gateFilter = btn.dataset.gf
      document.querySelectorAll('[data-gf]').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      const lbList = document.getElementById('gate-lb-list')
      if (lbList) lbList.innerHTML = renderGateLeaderboard(gateFilter)
      // Update subtitle
      const sub = document.querySelector('.gate-lb-subtitle')
      if (sub) {
        const label = gateFilter === 'female' ? 'putri' : gateFilter === 'male' ? 'putra' : 'kandidat'
        sub.textContent = `Top 10 ${label} saat ini`
      }
    }
  })
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
