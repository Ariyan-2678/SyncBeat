// app.js — SyncBeat v2 client
// Guest identity + queue/history + chat/reactions + roles + unified transport.

'use strict';

// ============================================================ DOM
const $ = (id) => document.getElementById(id);
const authSec = $('auth'), lobby = $('lobby'), room = $('room');
const authForm = $('authForm'), guestName = $('guestName'), guestEnter = $('guestEnter');
const authError = $('authError');
const userChip = $('userChip'), userAvatar = $('userAvatar'), userName = $('userName'), logoutBtn = $('logoutBtn');
const createBtn = $('createBtn'), joinBtn = $('joinBtn'), codeInput = $('codeInput');
const listenerCheck = $('listenerCheck'), lobbyError = $('lobbyError');
const roomCode = $('roomCode'), copyBtn = $('copyBtn'), shareBtn = $('shareBtn'), leaveBtn = $('leaveBtn');
const userCount = $('userCount'), membersList = $('membersList');
const djBadge = $('djBadge'), djRow = $('djRow'), djCheck = $('djCheck');
const clearQueueBtn = $('clearQueueBtn');
const inviteBox = $('inviteBox'), inviteLink = $('inviteLink'), qrImg = $('qrImg');
const trackUrl = $('trackUrl'), loadBtn = $('loadBtn');
const emptyMsg = $('empty'), trackMeta = $('trackMeta'), trackTitle = $('trackTitle'), trackBy = $('trackBy');
const audio = $('audio'), ytWrap = $('ytWrap'), scWrap = $('scWrap');
const transport = $('transport'), playPauseBtn = $('playPauseBtn'), nextBtn = $('nextBtn');
const seekBar = $('seekBar'), timeCur = $('timeCur'), timeDur = $('timeDur');
const muteBtn = $('muteBtn'), volBar = $('volBar'), speedSel = $('speedSel');
const queueList = $('queueList'), queueCount = $('queueCount');
const historyList = $('historyList'), historyBox = $('historyBox');
const chatList = $('chatList'), chatForm = $('chatForm'), chatInput = $('chatInput');
const statusEl = $('status'), reactionLayer = $('reactionLayer');
const themeToggle = $('themeToggle'), joinForm = $('joinForm'), trackForm = $('trackForm');

// ============================================================ guest session (no password)
let ME = null; // { id: guestId, username, uid? } — uid is server-issued per room session
let GUEST_ID = null;
try {
  ME = JSON.parse(localStorage.getItem('sb-guest') || 'null');
  GUEST_ID = localStorage.getItem('sb-guest-id');
  if (ME && !GUEST_ID) ME = null;
} catch (e) { ME = null; GUEST_ID = null; }

// Host capability tokens (one per room, only ever sent to this browser).
function hostTokens() {
  try { return JSON.parse(localStorage.getItem('sb-hosts') || '{}'); } catch (e) { return {}; }
}
function getHostToken(code) {
  return hostTokens()[code] || null;
}
function saveHostToken(code, tok) {
  try {
    const m = hostTokens();
    if (tok) m[code] = tok; else delete m[code];
    localStorage.setItem('sb-hosts', JSON.stringify(m));
  } catch (e) {}
}

function validNameLocal(n) {
  n = String(n == null ? '' : n).trim().replace(/\s+/g, ' ');
  if (!/^[\p{L}\p{N}_.\- ]{2,20}$/u.test(n)) return null;
  return n;
}
function ensureGuestId() {
  if (GUEST_ID && /^[A-Za-z0-9_-]{6,32}$/.test(GUEST_ID)) return GUEST_ID;
  let id = '';
  try {
    const a = new Uint8Array(12);
    crypto.getRandomValues(a);
    id = Array.from(a, (b) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[b % 62]).join('');
  } catch (e) {
    id = 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }
  GUEST_ID = id;
  try { localStorage.setItem('sb-guest-id', id); } catch (e) {}
  return id;
}
function setGuest(name) {
  ensureGuestId();
  ME = { id: GUEST_ID, username: name };
  try { localStorage.setItem('sb-guest', JSON.stringify(ME)); } catch (e) {}
  paintUser();
}
function clearGuest() {
  ME = null;
  try { localStorage.removeItem('sb-guest'); } catch (e) {}
  paintUser();
}
function guestColor(name) {
  let h = 0;
  name = String(name || '');
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return 'hsl(' + (h % 360) + ' 45% 55%)';
}
function paintUser() {
  if (ME) {
    userChip.classList.remove('hidden');
    userAvatar.textContent = (ME.username || '؟').trim().charAt(0) || '؟';
    userAvatar.style.background = guestColor(ME.username);
    userName.textContent = ME.username;
  } else {
    userChip.classList.add('hidden');
  }
}
function showOnly(el) {
  [authSec, lobby, room].forEach((s) => s.classList.add('hidden'));
  document.body.classList.toggle('in-room', el === room);
  if (el) {
    el.classList.remove('hidden');
    el.classList.remove('rise-in');
    void el.offsetWidth;
    el.classList.add('rise-in');
    if (el === authSec) { try { guestName.focus(); } catch (e) {} }
  }
}
function setAuthError(m) { authError.textContent = m || ''; }

authForm.addEventListener('submit', (e) => {
  e.preventDefault();
  setAuthError('');
  const n = validNameLocal(guestName.value);
  if (!n) { setAuthError('اسم ۲ تا ۲۰ حرف (حروف/عدد) بنویس'); return; }
  setGuest(n);
  connectSocket();
  showOnly(lobby);
});
logoutBtn.addEventListener('click', () => {
  if (socket) { try { socket.disconnect(); } catch (e) {} socket = null; }
  history.replaceState(null, '', location.pathname);
  resetRoomUI();
  try { guestName.value = (ME && ME.username) || ''; } catch (e) {}
  showOnly(authSec);
});

// ============================================================ socket (auth required)
let socket = null;
function connectSocket() {
  if (socket) { try { socket.disconnect(); } catch (e) {} }
  if (!ME) { showOnly(authSec); return; }
  ensureGuestId();
  socket = io({ auth: { guestId: GUEST_ID, displayName: ME.username } });
  bindSocket(socket);
  socket.on('connect', () => {
    paintUser();
    autoRejoin();
  });
  socket.on('connect_error', (err) => {
    if (err && err.message === 'name-required') {
      // permanent for this handshake — stop the reconnect loop
      try { socket.disconnect(); } catch (e) {}
      showOnly(authSec);
      setAuthError('اسمت قبول نشد — یه اسم دیگه بنویس');
    }
  });
}

// ============================================================ player state
let currentTrack = null;
let ytPlayer = null, ytReady = false;
let scPlayer = null, scReady = false, scDuration = 0;
let suppress = false;
const SYNC_DRIFT = 1.2;
let scrubbing = false;
let pending = null;
let scPlaying = false, scLastPos = 0, scActionAt = 0;
const SC_ECHO_MS = 1500;
let myRole = 'member', amHost = false, djOnly = false;
let currentCode = null;

// local prefs (not synced)
let muted = false;
// single source of truth for "can I control the room?" (play/seek/speed/add)
function canControlClient() {
  return myRole !== 'listener' && (!djOnly || amHost);
}
let volume = 90;
let speed = 1;
try {
  const v = parseInt(localStorage.getItem('sb-vol') || '90', 10);
  if (isFinite(v)) volume = Math.min(100, Math.max(0, v));
  const s = parseFloat(localStorage.getItem('sb-speed') || '1');
  if ([0.75, 1, 1.25, 1.5, 2].includes(s)) speed = s;
} catch (e) {}
volBar.value = volume;
speedSel.value = String(speed);

let statusTimer = 0;
function setStatus(msg) {
  statusEl.textContent = msg || '';
  statusEl.classList.toggle('show', !!msg);
  clearTimeout(statusTimer);
  if (msg) statusTimer = setTimeout(() => statusEl.classList.remove('show'), 2800);
}
function fmtTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
}
function updateSeekFill() {
  const max = parseFloat(seekBar.max) || 1000;
  seekBar.style.setProperty('--fill', (seekBar.value / max) * 100 + '%');
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// theme
themeToggle.addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('sb-theme', next); } catch (e) {}
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', next === 'light' ? '#edf1ea' : '#101511');
});

// ============================================================ lobby
createBtn.onclick = () => {
  if (!socket) return;
  lobbyError.textContent = '';
  socket.emit('create-room', (res) => {
    if (!res || !res.ok) {
      lobbyError.textContent = res && res.error === 'rate-limited'
        ? 'خیلی سریع می‌سازی — چند لحظه صبر کن'
        : 'خطا در ساخت اتاق';
      return;
    }
    if (res.hostToken) saveHostToken(res.code, res.hostToken);
    onEnteredRoom(res);
  });
};
joinBtn.onclick = () => {
  const code = codeInput.value.toUpperCase().trim();
  if (!code) { lobbyError.textContent = 'کد اتاق رو وارد کن'; return; }
  doJoin(code, listenerCheck.checked);
};
function doJoin(code, asListener) {
  if (!socket) return;
  lobbyError.textContent = '';
  socket.emit('join-room', code, { asListener: !!asListener, hostToken: getHostToken(code) }, (res) => {
    if (!res || !res.ok) {
      const err = res && res.error;
      lobbyError.textContent = err === 'banned' ? 'هاست تو رو از این اتاق بیرون کرده'
        : err === 'rate-limited' ? 'خیلی سریع می‌ایی — چند لحظه صبر کن'
        : 'اتاقی با این کد پیدا نشد';
      return;
    }
    onEnteredRoom(res);
  });
}
joinForm.addEventListener('submit', (e) => { e.preventDefault(); joinBtn.click(); });
trackForm.addEventListener('submit', (e) => { e.preventDefault(); loadBtn.click(); });

function onEnteredRoom(res) {
  currentCode = res.code;
  if (ME) ME.uid = res.uid || null;
  if (res.hostToken) saveHostToken(res.code, res.hostToken);
  myRole = res.role || 'member';
  amHost = !!res.isHost;
  enterRoom(res.code);
  if (res.state) applyFullState(res.state);
  updateInvite();
  setStatus(myRole === 'listener' ? 'به‌عنوان شنونده وارد شدی 🎧' : 'وارد اتاق شدی ✓');
}
function enterRoom(code) {
  showOnly(room);
  roomCode.textContent = code;
  if (('#' + code) !== location.hash) history.replaceState(null, '', '#' + code);
}
leaveBtn.onclick = () => {
  // Tell the server we left — otherwise membership stays until disconnect
  // and the "members" list keeps showing us as present.
  if (socket) socket.emit('leave-room');
  resetRoomUI();
  history.replaceState(null, '', location.pathname);
  showOnly(lobby);
};
function resetRoomUI() {
  currentCode = null; currentTrack = null; pending = null;
  updateAddBtn();
  myRole = 'member'; amHost = false; djOnly = false;
  lastHostId = null; lastMembers = [];
  if (ME) ME.uid = null;
  withSuppress(() => stopAllPlayers());
  emptyMsg.classList.remove('hidden');
  trackMeta.classList.add('hidden');
  transport.classList.add('hidden');
  ytWrap.classList.add('hidden'); scWrap.classList.add('hidden');
  queueList.innerHTML = ''; historyList.innerHTML = ''; chatList.innerHTML = ''; membersList.innerHTML = '';
  historyBox.classList.add('hidden');
  queueCount.textContent = '0'; userCount.textContent = '1';
  inviteBox.classList.add('hidden');
  djBadge.classList.add('hidden');
  djRow.classList.add('hidden');
  clearQueueBtn.classList.add('hidden');
  djCheck.checked = false;
  trackUrl.disabled = false; loadBtn.disabled = false;
  trackUrl.value = '';
  setPlayingUI(false);
}

// copy / share / invite
copyBtn.onclick = () => {
  const code = roomCode.textContent;
  const done = () => {
    copyBtn.classList.add('copied');
    const l = copyBtn.querySelector('.copy-label');
    if (l) l.textContent = 'کپی شد ✓';
    setTimeout(() => { copyBtn.classList.remove('copied'); if (l) l.textContent = 'کپی'; }, 1500);
  };
  if (navigator.clipboard && navigator.clipboard.writeText)
    navigator.clipboard.writeText(code).then(done, () => copyFallback(code, done));
  else copyFallback(code, done);
};
function copyFallback(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); done(); } catch (e) {}
  document.body.removeChild(ta);
}
function inviteUrl() {
  return location.origin + location.pathname + '#' + (currentCode || '');
}
function updateInvite() {
  if (!currentCode) return;
  inviteLink.value = inviteUrl();
  qrImg.src = 'https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=' + encodeURIComponent(inviteUrl());
}
shareBtn.onclick = () => {
  updateInvite();
  inviteBox.classList.toggle('hidden');
  const data = { title: 'SyncBeat', text: 'بیا تو اتاق ' + currentCode + ' با هم گوش بدیم 🎵', url: inviteUrl() };
  if (navigator.share) navigator.share(data).catch(() => {});
  else {
    inviteLink.select();
    try { document.execCommand('copy'); } catch (e) {}
    if (navigator.clipboard) navigator.clipboard.writeText(inviteUrl()).catch(() => {});
    setStatus('لینک دعوت کپی شد ✓');
  }
};

// ============================================================ tracks: add + queue + history
function parseYouTube(url) {
  const m = url.match(
    /(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v(?:i)?=|embed\/|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/
  );
  return m ? m[1] : null;
}
function isSoundCloud(url) { return /(?:soundcloud\.com|snd\.sc)\//i.test(url); }
function guessFileName(url) {
  try {
    const p = new URL(url).pathname.split('/').filter(Boolean).pop() || url;
    return decodeURIComponent(p).slice(0, 80);
  } catch (e) { return url.slice(0, 80); }
}
async function enrichTitle(type, url, idOrUrl) {
  if (type === 'audio') return guessFileName(url);
  try {
    const page = type === 'youtube'
      ? 'https://www.youtube.com/watch?v=' + idOrUrl
      : url;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch('https://noembed.com/embed?url=' + encodeURIComponent(page), { signal: ctrl.signal });
    clearTimeout(t);
    const j = await r.json();
    if (j && j.title) return String(j.title).slice(0, 140);
  } catch (e) { /* offline/blocked — fallback */ }
  return type === 'youtube' ? 'YouTube · ' + idOrUrl : url.slice(0, 80);
}

loadBtn.onclick = async () => {
  const raw = trackUrl.value.trim();
  if (!raw || !socket) return;
  if (myRole === 'listener' || (djOnly && !amHost)) {
    setStatus(myRole === 'listener' ? 'شنونده نمی‌تواند آهنگ اضافه کند 🎧' : 'فعلاً فقط DJ کنترل می‌کند');
    return;
  }
  loadBtn.disabled = true;
  try {
    let payload;
    const ytid = parseYouTube(raw);
    if (ytid) payload = { type: 'youtube', url: ytid, title: await enrichTitle('youtube', raw, ytid) };
    else if (isSoundCloud(raw)) payload = { type: 'soundcloud', url: raw, title: await enrichTitle('soundcloud', raw, raw) };
    else payload = { type: 'audio', url: raw, title: guessFileName(raw) };
    socket.emit('queue-add', payload, (res) => {
      if (res && !res.ok) setStatus(res.error === 'queue-full' ? 'صف پر است' : 'خطا در افزودن');
      else { trackUrl.value = ''; setStatus('به صف اضافه شد ✓'); }
    });
  } finally { loadBtn.disabled = false; }
};

nextBtn.onclick = () => {
  if (!socket || !currentCode) return;
  socket.emit('skip', (res) => {
    if (res && !res.ok) setStatus('اجازه نداری');
  });
};
clearQueueBtn.onclick = () => {
  if (!socket) return;
  socket.emit('queue-clear', (res) => {
    if (res && !res.ok) setStatus('فقط هاست می‌تواند پاک کند');
  });
};
djCheck.addEventListener('change', () => {
  if (!socket) return;
  socket.emit('set-dj-only', djCheck.checked, (res) => {
    if (!res || !res.ok) { djCheck.checked = !djCheck.checked; setStatus('فقط هاست'); }
  });
});

function paintQueue(q) {
  q = Array.isArray(q) ? q : [];
  queueCount.textContent = q.length;
  queueList.innerHTML = q.map((t) => {
    const mine = ME && t.addedBy && t.addedBy.guestId === ME.id;
    const canDel = amHost || mine;
    return '<li class="q-item">' +
      '<span class="q-type">' + esc(t.type === 'youtube' ? 'YT' : t.type === 'soundcloud' ? 'SC' : 'MP3') + '</span>' +
      '<span class="q-title">' + esc(t.title || t.url) + '</span>' +
      '<span class="q-by">' + esc((t.addedBy && t.addedBy.username) || '') + '</span>' +
      (canDel ? '<button class="chip-btn q-del" type="button" data-id="' + esc(t.id) + '">حذف</button>' : '') +
      '</li>';
  }).join('') || '<li class="q-empty">صف خالیه</li>';
}
queueList.addEventListener('click', (e) => {
  const b = e.target.closest('.q-del');
  if (!b || !socket) return;
  socket.emit('queue-remove', b.getAttribute('data-id'), (res) => {
    if (res && !res.ok) setStatus('اجازه نداری');
  });
});
function paintHistory(h) {
  h = Array.isArray(h) ? h : [];
  historyBox.classList.toggle('hidden', h.length === 0);
  historyList.innerHTML = h.slice().reverse().map((t) =>
    '<li class="h-item"><span class="q-title">' + esc(t.title || t.url) +
    '</span><span class="q-by">' + esc((t.addedBy && t.addedBy.username) || '') + '</span></li>'
  ).join('');
}

// ============================================================ members / roles
function paintMembers(members, hostId, dj) {
  members = Array.isArray(members) ? members : [];
  userCount.textContent = members.length || 1;
  djOnly = !!dj;
  djBadge.classList.toggle('hidden', !djOnly);
  // Derive OUR role/hostship from our own entry (matched by the server
  // issued uid, never by the guessable guestId).
  const selfEntry = members.find((m) => ME && ME.uid && m.userId === ME.uid);
  if (selfEntry) {
    myRole = selfEntry.role || 'member';
    amHost = !!selfEntry.isHost;
  } else {
    amHost = false;
  }
  membersList.innerHTML = members.map((m) => {
    const host = !!m.isHost;
    const self = ME && ME.uid && m.userId === ME.uid;
    return '<li class="m-item">' +
      '<span class="avatar sm" style="background:' + esc(m.color || 'var(--a1)') + '">' + esc((m.username || '?').charAt(0)) + '</span>' +
      '<span class="m-name">' + esc(m.username) + (self ? ' (تو)' : '') + '</span>' +
      (host ? '<span class="m-badge">👑 هاست</span>' : '') +
      (m.role === 'listener' ? '<span class="m-badge">🎧 شنونده</span>' : '') +
      (amHost && !self ? '<button class="chip-btn m-kick" type="button" data-uid="' + esc(m.userId) + '">کیک</button>' : '') +
      '</li>';
  }).join('');
  const canControlNow = myRole !== 'listener' && (!djOnly || amHost);
  trackUrl.disabled = !canControlNow;
  loadBtn.disabled = !canControlNow;
  djRow.classList.toggle('hidden', !amHost);
  clearQueueBtn.classList.toggle('hidden', !amHost);
  if (amHost) djCheck.checked = djOnly;
}
membersList.addEventListener('click', (e) => {
  const b = e.target.closest('.m-kick');
  if (!b || !socket) return;
  socket.emit('kick', b.getAttribute('data-uid'), (res) => {
    if (!res || !res.ok) setStatus('کیک نشد');
  });
});

// ============================================================ chat + reactions
chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const t = chatInput.value.trim();
  if (!t || !socket) return;
  socket.emit('chat-message', t, (res) => {
    if (res && res.ok) chatInput.value = '';
    else if (res) setStatus('پیام ارسال نشد');
  });
});
function addChat(msg) {
  const li = document.createElement('li');
  li.className = 'c-item';
  const time = new Date(msg.at || Date.now());
  const hh = String(time.getHours()).padStart(2, '0') + ':' + String(time.getMinutes()).padStart(2, '0');
  li.innerHTML = '<span class="avatar sm" style="background:' + esc(msg.color || 'var(--a1)') + '">' +
    esc((msg.username || '?').charAt(0)) + '</span>' +
    '<span class="c-body"><span class="c-head">' + esc(msg.username) +
    '<span class="c-time">' + hh + '</span></span>' +
    '<span class="c-text"></span></span>';
  li.querySelector('.c-text').textContent = msg.text;
  chatList.appendChild(li);
  while (chatList.children.length > 100) chatList.removeChild(chatList.firstChild);
  chatList.scrollTop = chatList.scrollHeight;
}
document.querySelector('.reactions').addEventListener('click', (e) => {
  const b = e.target.closest('[data-emoji]');
  if (!b || !socket) return;
  socket.emit('reaction', b.getAttribute('data-emoji'));
  popReaction(b.getAttribute('data-emoji'));
});
function popReaction(emoji) {
  const s = document.createElement('span');
  s.className = 'react-pop';
  s.textContent = emoji;
  s.style.left = (10 + Math.random() * 80) + 'vw';
  reactionLayer.appendChild(s);
  setTimeout(() => s.remove(), 2200);
}

// ============================================================ unified transport
function applyVolume() {
  try { localStorage.setItem('sb-vol', String(volume)); } catch (e) {}
  // One effective value for ALL players — YT/SC used to keep playing
  // audibly while muted because setVolume only ran when !muted.
  const v = muted ? 0 : volume;
  audio.volume = v / 100;
  audio.muted = muted;
  try { if (ytPlayer && ytPlayer.setVolume) ytPlayer.setVolume(v); } catch (e) {}
  try { if (scPlayer && scPlayer.setVolume) scPlayer.setVolume(v); } catch (e) {}
  muteBtn.textContent = muted ? '🔇' : '🔊';
}
function applySpeed() {
  try { localStorage.setItem('sb-speed', String(speed)); } catch (e) {}
  try { audio.playbackRate = speed; } catch (e) {}
  try { if (ytPlayer && ytPlayer.setPlaybackRate) ytPlayer.setPlaybackRate(speed); } catch (e) {}
}
volBar.addEventListener('input', () => {
  volume = parseInt(volBar.value, 10) || 0;
  muted = volume === 0;
  applyVolume();
});
muteBtn.addEventListener('click', () => {
  muted = !muted;
  if (!muted && volume === 0) { volume = 90; volBar.value = 90; }
  applyVolume();
});
speedSel.addEventListener('change', () => {
  const next = parseFloat(speedSel.value) || 1;
  if (!canControlClient()) {
    // nobody gave you the controls — snap back to the room's speed
    speedSel.value = String(speed);
    setStatus('اجازه تغییر سرعت نداری');
    return;
  }
  speed = next;
  applySpeed();
  if (socket) socket.emit('set-speed', speed);
});
function applyRoomSpeed(v) {
  if (![0.75, 1, 1.25, 1.5, 2].includes(v)) return;
  speed = v;
  speedSel.value = String(v);
  applySpeed();
}
audio.addEventListener('loadedmetadata', () => {
  timeDur.textContent = fmtTime(audio.duration);
  applyVolume(); applySpeed();
});
setInterval(() => { // keep YT/SC seek+time fresh
  if (!currentTrack || scrubbing) return;
  if (currentTrack.type === 'youtube' && ytPlayer && ytPlayer.getCurrentTime) {
    try {
      const p = ytPlayer.getCurrentTime(), d = ytPlayer.getDuration ? ytPlayer.getDuration() : 0;
      if (isFinite(d) && d > 0) { seekBar.value = (p / d) * 1000; updateSeekFill(); }
      timeCur.textContent = fmtTime(p); timeDur.textContent = fmtTime(d);
    } catch (e) {}
  } else if (currentTrack.type === 'soundcloud' && scReady) {
    timeCur.textContent = fmtTime(scLastPos);
    timeDur.textContent = fmtTime(scDuration);
    if (isFinite(scDuration) && scDuration > 0) { seekBar.value = (scLastPos / scDuration) * 1000; updateSeekFill(); }
  }
}, 500);
audio.addEventListener('timeupdate', () => {
  if (scrubbing || !currentTrack || currentTrack.type !== 'audio') return;
  if (isFinite(audio.duration) && audio.duration > 0) {
    seekBar.value = (audio.currentTime / audio.duration) * 1000;
    updateSeekFill();
  }
  timeCur.textContent = fmtTime(audio.currentTime);
});
seekBar.addEventListener('input', () => {
  scrubbing = true;
  updateSeekFill();
  const d = getDuration();
  if (isFinite(d) && d > 0) timeCur.textContent = fmtTime((seekBar.value / 1000) * d);
});
seekBar.addEventListener('change', () => {
  const d = getDuration();
  scrubbing = false;
  if (!currentTrack || !isFinite(d) || d <= 0 || !socket) return;
  if (!canControlClient()) {
    setStatus(myRole === 'listener' ? 'شنونده نمی‌تواند seek کند 🎧' : 'فعلاً فقط DJ کنترل می‌کند');
    return; // bar snaps back on the next position tick
  }
  const t = (seekBar.value / 1000) * d;
  if (currentTrack.type === 'audio') {
    audio.currentTime = t; // 'seeked' emits
  } else if (currentTrack.type === 'youtube' && ytPlayer) {
    ytPlayer.seekTo(t, true);
    socket.emit('seek', t);
  } else if (currentTrack.type === 'soundcloud' && scPlayer) {
    scActionAt = Date.now();
    scPlayer.seekTo(t * 1000);
    socket.emit('seek', t);
  }
});
playPauseBtn.addEventListener('click', () => {
  if (!currentTrack || !socket) return;
  if (myRole === 'listener' || (djOnly && !amHost)) { setStatus('اجازه پخش نداری'); return; }
  if (currentTrack.type === 'audio') {
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
  } else if (currentTrack.type === 'youtube' && ytPlayer) {
    try {
      const st = ytPlayer.getPlayerState();
      if (st === YT.PlayerState.PLAYING) ytPlayer.pauseVideo();
      else ytPlayer.playVideo();
    } catch (e) {}
  } else if (currentTrack.type === 'soundcloud' && scPlayer) {
    if (scPlaying) scPlayer.pause();
    else scPlayer.play();
  }
});
function setPlayingUI(playing) {
  transport.classList.toggle('playing', !!playing);
  document.body.classList.toggle('playing', !!playing);
}
audio.addEventListener('play', () => setPlayingUI(true));
audio.addEventListener('pause', () => setPlayingUI(false));

// ============================================================ sync core
function withSuppress(fn) {
  suppress = true;
  try { fn(); } finally { setTimeout(() => (suppress = false), 250); }
}
function stopAllPlayers() {
  if (!audio.paused) { try { audio.pause(); } catch (e) {} }
  try { audio.removeAttribute('src'); audio.load(); } catch (e) {}
  if (ytPlayer && ytPlayer.stopVideo) { try { ytPlayer.stopVideo(); } catch (e) {} }
  if (scPlayer && scPlayer.pause) { try { scPlayer.pause(); } catch (e) {} }
  scPlaying = false;
  scActionAt = Date.now();
  setPlayingUI(false);
}
function updateAddBtn() {
  loadBtn.textContent = currentTrack ? '+ صف' : '▶ پخش';
}
function loadTrack(track) {
  withSuppress(() => stopAllPlayers());
  currentTrack = track;
  updateAddBtn();
  if (!track) {
    emptyMsg.classList.remove('hidden');
    trackMeta.classList.add('hidden');
    transport.classList.add('hidden');
    ytWrap.classList.add('hidden'); scWrap.classList.add('hidden');
    setPlayingUI(false);
    return;
  }
  emptyMsg.classList.add('hidden');
  trackMeta.classList.remove('hidden');
  transport.classList.remove('hidden');
  trackTitle.textContent = track.title || track.url;
  trackBy.textContent = 'اضافه‌شده توسط ' + ((track.addedBy && track.addedBy.username) || '؟') +
    (track.type === 'youtube' ? ' · یوتیوب' : track.type === 'soundcloud' ? ' · ساندکلاد' : ' · MP3');
  const isAudio = track.type === 'audio', isYt = track.type === 'youtube', isSc = track.type === 'soundcloud';
  audio.classList.add('hidden');
  ytWrap.classList.toggle('hidden', !isYt);
  scWrap.classList.toggle('hidden', !isSc);
  seekBar.value = 0; updateSeekFill();
  timeCur.textContent = '0:00'; timeDur.textContent = '0:00';
  if (isAudio) { audio.src = track.url; audio.load(); applyVolume(); applySpeed(); }
  else if (isYt) loadYouTube(track.url);
  else if (isSc) loadSoundCloud(track.url);
}
function getPosition() {
  if (!currentTrack) return 0;
  if (currentTrack.type === 'audio') return audio.currentTime || 0;
  if (currentTrack.type === 'youtube' && ytPlayer && ytPlayer.getCurrentTime) {
    try { return ytPlayer.getCurrentTime(); } catch (e) { return 0; }
  }
  if (currentTrack.type === 'soundcloud') return scLastPos;
  return 0;
}
function getDuration() {
  if (!currentTrack) return 0;
  if (currentTrack.type === 'audio') return audio.duration || 0;
  if (currentTrack.type === 'youtube' && ytPlayer && ytPlayer.getDuration) {
    try { return ytPlayer.getDuration() || 0; } catch (e) { return 0; }
  }
  if (currentTrack.type === 'soundcloud') return scDuration || 0;
  return 0;
}
function doPlay(position) {
  if (!currentTrack) return;
  if (currentTrack.type === 'audio') {
    if (typeof position === 'number' && Math.abs(audio.currentTime - position) > SYNC_DRIFT) audio.currentTime = position;
    applyVolume(); applySpeed();
    audio.play().catch(() => setStatus('برای پخش، یه‌بار روی صفحه کلیک کن.'));
  } else if (currentTrack.type === 'youtube' && ytPlayer) {
    try {
      if (typeof position === 'number' && Math.abs(ytPlayer.getCurrentTime() - position) > SYNC_DRIFT)
        ytPlayer.seekTo(position, true);
      applyVolume(); applySpeed();
      ytPlayer.playVideo();
    } catch (e) {}
  } else if (currentTrack.type === 'soundcloud' && scPlayer) {
    if (typeof position === 'number' && Math.abs(scLastPos - position) > SYNC_DRIFT) {
      scPlayer.seekTo(position * 1000); scActionAt = Date.now();
    }
    scActionAt = Date.now();
    applyVolume();
    scPlayer.play();
  }
}
function doPause(position) {
  if (!currentTrack) return;
  if (currentTrack.type === 'audio') {
    if (typeof position === 'number') { try { audio.currentTime = position; } catch (e) {} }
    audio.pause();
  } else if (currentTrack.type === 'youtube' && ytPlayer) {
    try {
      if (typeof position === 'number') ytPlayer.seekTo(position, true);
      ytPlayer.pauseVideo();
    } catch (e) {}
  } else if (currentTrack.type === 'soundcloud' && scPlayer) {
    try {
      if (typeof position === 'number') scPlayer.seekTo(position * 1000);
      scActionAt = Date.now();
      scPlayer.pause();
    } catch (e) {}
  }
}
function doSeek(position) {
  if (!currentTrack || typeof position !== 'number') return;
  if (currentTrack.type === 'audio') { try { audio.currentTime = position; } catch (e) {} }
  else if (currentTrack.type === 'youtube' && ytPlayer) { try { ytPlayer.seekTo(position, true); } catch (e) {} }
  else if (currentTrack.type === 'soundcloud' && scPlayer) {
    scActionAt = Date.now();
    try { scPlayer.seekTo(position * 1000); } catch (e) {}
  }
}
function emitEnded() {
  // advance the shared queue instead of just pausing everyone at 0
  if (!suppress && socket && currentTrack) socket.emit('track-ended');
  setPlayingUI(false);
}

// audio -> server
audio.addEventListener('play', () => { if (!suppress && socket) socket.emit('play', audio.currentTime); });
audio.addEventListener('pause', () => {
  if (!suppress && socket && !audio.ended) socket.emit('pause', audio.currentTime);
});
audio.addEventListener('seeked', () => { if (!suppress && socket) socket.emit('seek', audio.currentTime); });
audio.addEventListener('ended', emitEnded);

// youtube
function loadYouTube(videoId) {
  if (!ytReady) { setTimeout(() => loadYouTube(videoId), 300); return; }
  if (!ytPlayer) {
    ytPlayer = new YT.Player('ytPlayer', {
      videoId,
      playerVars: { rel: 0, playsinline: 1 },
      events: {
        onReady: (e) => {
          applyVolume(); applySpeed();
          if (pending) {
            const p = pending; pending = null;
            withSuppress(() => {
              doSeek(p.position);
              if (p.isPlaying) doPlay(p.position); else doPause(p.position);
            });
          }
        },
        onStateChange: onYtStateChange,
      },
    });
  } else {
    try { ytPlayer.cueVideoById(videoId); } catch (e) {}
  }
}
function onYtStateChange(e) {
  if (e.data === YT.PlayerState.PLAYING) setPlayingUI(true);
  else if (e.data === YT.PlayerState.PAUSED || e.data === YT.PlayerState.ENDED) setPlayingUI(false);
  if (suppress || !socket) return;
  if (e.data === YT.PlayerState.PLAYING) socket.emit('play', ytPlayer.getCurrentTime());
  else if (e.data === YT.PlayerState.PAUSED) socket.emit('pause', ytPlayer.getCurrentTime());
  else if (e.data === YT.PlayerState.ENDED) emitEnded();
}
window.onYouTubeIframeAPIReady = () => { ytReady = true; };
if (typeof YT !== 'undefined' && YT.loaded) ytReady = true;

// soundcloud
function loadSoundCloud(url) {
  scReady = false; scDuration = 0;
  const src = 'https://w.soundcloud.com/player/?url=' + encodeURIComponent(url) +
    '&auto_play=false&show_comments=false&visual=true';
  scWrap.innerHTML = '<iframe id="scIframe" width="100%" height="166" scrolling="no" ' +
    'frameborder="no" allow="autoplay" src="' + src + '"></iframe>';
  if (typeof SC === 'undefined' || !SC.Widget) { setTimeout(() => loadSoundCloud(url), 300); return; }
  scPlayer = SC.Widget(document.getElementById('scIframe'));
  scPlayer.bind(SC.Widget.Events.READY, () => {
    scReady = true;
    try { scPlayer.getDuration((ms) => { scDuration = (ms || 0) / 1000; }); } catch (e) {}
    try { scPlayer.setVolume(volume); } catch (e) {}
    if (pending) {
      const p = pending; pending = null;
      withSuppress(() => {
        doSeek(p.position);
        if (p.isPlaying) doPlay(p.position); else doPause(p.position);
      });
    }
    scPlayer.bind(SC.Widget.Events.PLAY_PROGRESS, (ev) => { scLastPos = ev.currentPosition / 1000; });
    scPlayer.bind(SC.Widget.Events.PLAY, () => {
      scPlaying = true; setPlayingUI(true);
      try { scPlayer.getDuration((ms) => { scDuration = (ms || 0) / 1000; }); } catch (e) {}
      if (suppress || !socket) return;
      scPlayer.getPosition((ms) => socket.emit('play', ms / 1000));
    });
    scPlayer.bind(SC.Widget.Events.PAUSE, () => {
      const wasPlaying = scPlaying;
      scPlaying = false; setPlayingUI(false);
      if (!wasPlaying) return;
      if (Date.now() - scActionAt < SC_ECHO_MS) return;
      if (suppress || !socket) return;
      scPlayer.getPosition((ms) => socket.emit('pause', ms / 1000));
    });
    scPlayer.bind(SC.Widget.Events.FINISH, emitEnded);
  });
}

// ============================================================ socket events
function bindSocket(s) {
  s.on('room-users', (n) => { userCount.textContent = n; });
  s.on('members', (list) => {
    lastMembers = Array.isArray(list) ? list : [];
    const hostEntry = lastMembers.find((m) => m.isHost);
    if (hostEntry) lastHostId = hostEntry.userId;
    // paintMembers derives myRole/amHost from our own entry — host
    // transfers and role flips arrive here, not only via full state.
    paintMembers(lastMembers, lastHostId, djOnly);
  });
  s.on('load-track', (track) => {
    loadTrack(track);
    if (track) setStatus('آهنگ جدید: ' + (track.title || '') + ' — از ' + ((track.addedBy && track.addedBy.username) || '؟'));
    else setStatus('صف تمام شد.');
  });
  s.on('play', (p) => withSuppress(() => doPlay(p)));
  s.on('pause', (p) => withSuppress(() => doPause(p)));
  s.on('seek', (p) => withSuppress(() => doSeek(p)));
  s.on('queue-update', paintQueue);
  s.on('history-update', paintHistory);
  s.on('speed-change', (v) => applyRoomSpeed(v));
  s.on('chat-message', addChat);
  s.on('reaction', (r) => { if (r && r.emoji) popReaction(r.emoji); });
  s.on('room-flags', (f) => {
    if (!f) return;
    djOnly = !!f.djOnly;
    if (f.hostId) lastHostId = f.hostId;
    // hostship itself comes from members (isHost flag) — never guess it
    paintMembers(lastMembers, lastHostId, djOnly);
  });
  // Server rotated the host token (grace-period transfer): store it so
  // this browser can reclaim hostship later.
  s.on('host-token', (d) => {
    if (d && d.code && d.token) saveHostToken(d.code, d.token);
  });
  s.on('kicked', (d) => {
    if (d && d.code) saveHostToken(d.code, null);
    resetRoomUI();
    history.replaceState(null, '', location.pathname);
    showOnly(lobby);
    lobbyError.textContent = 'هاست تو را از اتاق بیرون کرد';
  });
}
let lastHostId = null, lastMembers = [];

function applyFullState(st) {
  lastHostId = st.hostId || null;
  lastMembers = st.members || [];
  paintMembers(st.members, st.hostId, st.djOnly);
  applyRoomSpeed(st.speed || 1);
  paintQueue(st.queue);
  paintHistory(st.history);
  chatList.innerHTML = '';
  (st.chat || []).forEach(addChat);
  if (st.track) {
    loadTrack(st.track);
    const needWait = st.track.type === 'youtube' ? !ytPlayer : st.track.type === 'soundcloud' ? !scPlayer : false;
    if (needWait) { pending = { isPlaying: st.isPlaying, position: st.position }; return; }
    withSuppress(() => {
      doSeek(st.position);
      if (st.isPlaying) doPlay(st.position); else doPause(st.position);
    });
  } else {
    loadTrack(null);
  }
}

function autoRejoin() {
  const code = (location.hash || '').replace('#', '').toUpperCase().trim();
  if (!code || !socket) return;
  socket.emit('join-room', code, { hostToken: getHostToken(code) }, (res) => {
    if (!res || !res.ok) { history.replaceState(null, '', location.pathname); return; }
    onEnteredRoom(res);
  });
}

// heartbeat: drift fix + autoplay-block recovery
setInterval(() => {
  if (!socket || !currentTrack) return;
  socket.emit('sync-request', (state) => {
    if (!state || !state.track) return;
    if (state.isPlaying) {
      const locallyPaused =
        (currentTrack.type === 'audio' && audio.paused && !audio.ended) ||
        (currentTrack.type === 'youtube' && ytPlayer && ytPlayer.getPlayerState && (() => {
          try { return ytPlayer.getPlayerState() === YT.PlayerState.PAUSED; } catch (e) { return false; }
        })()) ||
        (currentTrack.type === 'soundcloud' && scPlayer && scReady && !scPlaying);
      if (locallyPaused) { withSuppress(() => doPlay(state.position)); return; }
      if (Math.abs(getPosition() - state.position) > SYNC_DRIFT)
        withSuppress(() => doSeek(state.position));
    }
  });
}, 5000);

// ============================================================ boot
paintUser();
applyVolume();
if (ME && validNameLocal(ME.username)) {
  try { guestName.value = ME.username; } catch (e) {}
  connectSocket();
  showOnly(lobby);
} else {
  clearGuest();
  showOnly(authSec);
}
