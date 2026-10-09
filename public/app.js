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
const roomPass = $('roomPass'), privateBadge = $('privateBadge');
const searchBox = $('searchBox'), searchForm = $('searchForm'), searchInput = $('searchInput'),
  searchBtn = $('searchBtn'), searchList = $('searchList'), searchHint = $('searchHint');
const userCount = $('userCount'), membersList = $('membersList');
const djBadge = $('djBadge'), djRow = $('djRow'), djCheck = $('djCheck');
const clearQueueBtn = $('clearQueueBtn'), sortBtn = $('sortBtn');
const inviteBox = $('inviteBox'), inviteLink = $('inviteLink'), qrImg = $('qrImg');
const trackUrl = $('trackUrl'), loadBtn = $('loadBtn');
const uploadBtn = $('uploadBtn'), trackFile = $('trackFile');
const emptyMsg = $('empty'), trackMeta = $('trackMeta'), trackTitle = $('trackTitle'), trackBy = $('trackBy'),
  trackWarn = $('trackWarn');
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
    // Rooms are only swept after 24h idle, but this map would otherwise keep
    // one entry for every room this browser ever made, forever.
    const keys = Object.keys(m);
    if (keys.length > 50) keys.slice(0, keys.length - 50).forEach((k) => delete m[k]);
    localStorage.setItem('sb-hosts', JSON.stringify(m));
  } catch (e) {}
}

// Queue-ownership secrets — same shape and lifetime as host tokens. The
// server echoes back only a HASH of this (addedBy.ownerId), which is safe to
// broadcast; the secret itself travels back on join and is what proves a
// queued track is ours to delete.
function ownerSecrets() {
  try { return JSON.parse(localStorage.getItem('sb-owners') || '{}'); } catch (e) { return {}; }
}
function getOwnerSecret(code) { return ownerSecrets()[code] || null; }
function saveOwnerSecret(code, secret) {
  try {
    const m = ownerSecrets();
    if (secret) m[code] = secret; else delete m[code];
    const keys = Object.keys(m);
    if (keys.length > 50) keys.slice(0, keys.length - 50).forEach((k) => delete m[k]);
    localStorage.setItem('sb-owners', JSON.stringify(m));
  } catch (e) {}
}
let MY_OWNER_TAG = null;

// Room passwords, kept so a reconnect (or a later visit to the invite link)
// does not have to ask again. Same shape and lifetime as the host tokens.
function roomPasswords() {
  try { return JSON.parse(localStorage.getItem('sb-roompw') || '{}'); } catch (e) { return {}; }
}
function getRoomPassword(code) { return roomPasswords()[code] || ''; }
function saveRoomPassword(code, pw) {
  try {
    const m = roomPasswords();
    if (pw) m[code] = pw; else delete m[code];
    const keys = Object.keys(m);
    if (keys.length > 50) keys.slice(0, keys.length - 50).forEach((k) => delete m[k]);
    localStorage.setItem('sb-roompw', JSON.stringify(m));
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
  let everConnected = false;
  socket.on('connect', () => {
    paintUser();
    if (everConnected) setStatus('دوباره وصل شدی ✓');
    if (!currentCode) lobbyError.textContent = ''; // clears any stale offline note
    everConnected = true;
    autoRejoin();
  });
  // Nothing told the user the link had dropped — playback just silently
  // stopped keeping up with everyone else.
  socket.on('disconnect', () => {
    const msg = 'اتصال قطع شد — دوباره تلاش می‌کنم…';
    if (currentCode) setStatus(msg); else lobbyError.textContent = msg;
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
// deciding whether a media event is ours to report — see public/echo.js
const echo = SyncEcho.create();
const SYNC_DRIFT = 1.2;
let scrubbing = false;
let pending = null;
let scPlaying = false, scLastPos = 0, scActionAt = 0;
const SC_ECHO_MS = 1500;
let myRole = 'member', amHost = false, djOnly = false;
let queueSort = 'added';
let currentCode = null;
function paintSortBtn() {
  sortBtn.classList.toggle('hidden', !amHost);
  sortBtn.textContent = queueSort === 'votes' ? 'مرتب: رأی' : 'مرتب: اضافه‌شده';
}
sortBtn.onclick = () => {
  if (!socket) return;
  socket.emit('queue-sort', queueSort === 'votes' ? 'added' : 'votes', (res) => {
    if (!res || !res.ok) { setStatus('فقط هاست صف را مرتب می‌کنه'); return; }
    queueSort = res.queueSort === 'votes' ? 'votes' : 'added';
    paintSortBtn();
  });
};

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
  socket.emit('create-room', { password: roomPass.value }, (res) => {
    if (!res || !res.ok) {
      lobbyError.textContent =
        res && res.error === 'rate-limited' ? 'خیلی سریع می‌سازی — چند لحظه صبر کن'
        : res && res.error === 'server-full' ? 'ظرفیت اتاق‌ها پُره — کمی بعد دوباره امتحان کن'
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
  socket.emit('join-room', code, {
    asListener: !!asListener,
    hostToken: getHostToken(code),
    ownerSecret: getOwnerSecret(code),
    password: roomPass.value || getRoomPassword(code),
  }, (res) => {
    if (!res || !res.ok) {
      const err = res && res.error;
      lobbyError.textContent = err === 'banned' ? 'هاست تو رو از این اتاق بیرون کرده'
        : err === 'wrong-password' ? 'رمز اتاق درست نیست'
        : err === 'rate-limited' ? 'خیلی سریع می‌ایی — چند لحظه صبر کن'
        : 'اتاقی با این کد پیدا نشد';
      if (err === 'wrong-password') { try { roomPass.focus(); } catch (e) {} }
      return;
    }
    onEnteredRoom(res);
  });
}
joinForm.addEventListener('submit', (e) => { e.preventDefault(); joinBtn.click(); });
trackForm.addEventListener('submit', (e) => { e.preventDefault(); loadBtn.click(); });

// ============================================================ search YouTube
// Paste-a-link is the hard part of using this app, so the link can be looked
// up instead. The search is answered by our own server, which holds the API
// key — the browser never sees it.
let searchBusy = false;
function runSearch() {
  if (searchBusy) return;
  const q = searchInput.value.trim();
  if (!q) { searchList.classList.add('hidden'); return; }
  searchBusy = true;
  searchBtn.disabled = true;
  searchHint.classList.add('hidden');
  fetch('/api/search?q=' + encodeURIComponent(q))
    .then((r) => r.json())
    .then((res) => {
      if (!res || !res.ok) {
        showSearchHint(res && res.error === 'no-key'
          ? 'جستجو خاموشه — متغیر YOUTUBE_API_KEY را روی سرور بذار.'
          : res && res.error === 'rate-limited' ? 'خیلی سریع جستجو می‌کنی — کمی صبر کن'
          : 'جستجو جواب نداد');
        return;
      }
      paintSearch(res.results || []);
    })
    .catch(() => showSearchHint('جستجو جواب نداد'))
    .finally(() => { searchBusy = false; searchBtn.disabled = false; });
}
function showSearchHint(msg) {
  searchHint.textContent = msg;
  searchHint.classList.remove('hidden');
  searchList.classList.add('hidden');
}
function paintSearch(list) {
  if (!list.length) { showSearchHint('چیزی پیدا نشد'); return; }
  searchList.innerHTML = list.map((r) => {
    // Only a real https thumbnail — an arbitrary scheme in an <img> src is
    // not something to take on trust, even from our own upstream.
    const thumb = /^https:\/\//.test(r.thumb || '') ? r.thumb : null;
    return '<li class="s-item">' +
      (thumb ? '<img class="s-thumb" src="' + esc(thumb) + '" alt="" loading="lazy" width="56" height="42" />' : '') +
      '<span class="s-text">' +
        '<span class="s-title">' + esc(r.title) + '</span>' +
        '<span class="s-by">' + esc(r.channel || '') + '</span>' +
      '</span>' +
      '<button class="chip-btn s-add" type="button" data-id="' + esc(r.id) +
      '" data-title="' + esc(r.title) + '">+ صف</button>' +
      '</li>';
  }).join('');
  searchHint.classList.add('hidden');
  searchList.classList.remove('hidden');
}
searchBtn.onclick = runSearch;
searchForm.addEventListener('submit', (e) => { e.preventDefault(); runSearch(); });
searchList.addEventListener('click', (e) => {
  const b = e.target.closest('.s-add');
  if (!b || !socket) return;
  if (!canControlClient()) {
    setStatus(myRole === 'listener' ? 'شنونده نمی‌تواند آهنگ اضافه کند 🎧' : 'فعلاً فقط DJ کنترل می‌کند');
    return;
  }
  socket.emit('queue-add', {
    type: 'youtube',
    url: b.getAttribute('data-id'),
    title: b.getAttribute('data-title'),
  }, (res) => {
    setStatus(res && res.ok ? 'به صف اضافه شد ✓' : 'خطا در افزودن');
  });
});

// ============================================================ upload from disk
// Links still work, but finding a host that permits hotlinking is a chore —
// so the file can go straight to the server and be played back from there.
// Once it is on the server it is just another audio URL, so seeking, sync
// and persistence all keep working untouched.
const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;
uploadBtn.onclick = () => {
  if (!canControlClient()) {
    setStatus(myRole === 'listener' ? 'شنونده نمی‌تواند آهنگ اضافه کند 🎧' : 'فعلاً فقط DJ کنترل می‌کند');
    return;
  }
  trackFile.click();
};
trackFile.addEventListener('change', () => {
  const f = trackFile.files && trackFile.files[0];
  trackFile.value = ''; // so picking the same file twice still fires
  if (f) uploadFile(f);
});
function uploadFile(file) {
  if (!socket) return;
  if (!canControlClient()) {
    setStatus(myRole === 'listener' ? 'شنونده نمی‌تواند آهنگ اضافه کند 🎧' : 'فعلاً فقط DJ کنترل می‌کند');
    return;
  }
  if (file.size > MAX_UPLOAD_BYTES) { setStatus('حجم فایل باید کمتر از ۳۰ مگابایت باشه'); return; }
  const looksLikeAudio = /^audio\//i.test(file.type) ||
    /\.(mp3|m4a|m4b|aac|ogg|oga|opus|wav|flac|weba)$/i.test(file.name || '');
  if (!looksLikeAudio) { setStatus('فقط فایل صوتی قبول می‌شه'); return; }

  const finish = (msg) => { uploadBtn.disabled = false; setStatus(msg); };
  uploadBtn.disabled = true;
  setStatus('در حال آپلود… ۰٪');
  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/upload');
  xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
  xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name || 'audio'));
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) setStatus('در حال آپلود… ' + Math.round((e.loaded / e.total) * 100) + '٪');
  };
  xhr.onload = () => {
    let res = null;
    try { res = JSON.parse(xhr.responseText); } catch (e) { /* not JSON */ }
    if (xhr.status !== 200 || !res || !res.ok) {
      finish(res && res.error === 'too-large' ? 'حجم فایل باید کمتر از ۳۰ مگابایت باشه'
        : res && res.error === 'storage-full' ? 'فضای آپلود پُره — کمی بعد دوباره امتحان کن'
        : res && res.error === 'rate-limited' ? 'خیلی سریع آپلود می‌کنی — کمی صبر کن'
        : 'آپلود انجام نشد');
      return;
    }
    socket.emit('queue-add', { type: 'audio', url: res.path, title: res.title }, (r) => {
      finish(r && r.ok ? 'به صف اضافه شد ✓' : 'خطا در افزودن به صف');
    });
  };
  xhr.onerror = () => finish('آپلود انجام نشد');
  xhr.send(file);
}

function onEnteredRoom(res) {
  currentCode = res.code;
  if (ME) ME.uid = res.uid || null;
  if (res.hostToken) saveHostToken(res.code, res.hostToken);
  if (res.ownerSecret) saveOwnerSecret(res.code, res.ownerSecret);
  MY_OWNER_TAG = res.ownerTag || null;
  myRole = res.role || 'member';
  amHost = !!res.isHost;
  if (res.state && res.state.private) saveRoomPassword(res.code, roomPass.value || getRoomPassword(res.code));
  privateBadge.classList.toggle('hidden', !(res.state && res.state.private));
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
  lastMembers = [];
  MY_OWNER_TAG = null;
  if (ME) ME.uid = null;
  withSuppress(() => stopAllPlayers());
  emptyMsg.classList.remove('hidden');
  trackMeta.classList.add('hidden');
  transport.classList.add('hidden');
  ytWrap.classList.add('hidden'); scWrap.classList.add('hidden');
  queueList.innerHTML = ''; historyList.innerHTML = ''; chatList.innerHTML = ''; membersList.innerHTML = '';
  searchList.innerHTML = ''; searchList.classList.add('hidden'); searchHint.classList.add('hidden');
  searchInput.value = '';
  historyBox.classList.add('hidden');
  queueCount.textContent = '0'; userCount.textContent = '1';
  inviteBox.classList.add('hidden');
  djBadge.classList.add('hidden');
  privateBadge.classList.add('hidden');
  roomPass.value = '';
  queueSort = 'added';
  paintSortBtn();
  djRow.classList.add('hidden');
  clearQueueBtn.classList.add('hidden');
  djCheck.checked = false;
  trackUrl.disabled = false; loadBtn.disabled = false; uploadBtn.disabled = false;
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
  // captured now: the server sends 'load-track' before it acks, so by the
  // time the callback runs currentTrack has already been filled in
  const wasEmpty = !currentTrack;
  loadBtn.disabled = true;
  try {
    let payload;
    const ytid = parseYouTube(raw);
    if (ytid) payload = { type: 'youtube', url: ytid, title: await enrichTitle('youtube', raw, ytid) };
    else if (isSoundCloud(raw)) payload = { type: 'soundcloud', url: raw, title: await enrichTitle('soundcloud', raw, raw) };
    else payload = { type: 'audio', url: raw, title: guessFileName(raw) };
    socket.emit('queue-add', payload, (res) => {
      if (res && !res.ok) setStatus(res.error === 'queue-full' ? 'صف پر است' : 'خطا در افزودن');
      else { trackUrl.value = ''; setStatus(wasEmpty ? 'شروع پخش ✓' : 'به صف اضافه شد ✓'); }
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
  queueList.innerHTML = q.map((t, i) => {
    // Match on the server-issued hash, not guestId — guestId is ours to
    // declare, so the button would appear on other people's tracks too.
    const mine = !!(MY_OWNER_TAG && t.addedBy && t.addedBy.ownerId === MY_OWNER_TAG);
    const canManage = amHost || mine;
    const voted = !!(MY_OWNER_TAG && Array.isArray(t.voters) && t.voters.indexOf(MY_OWNER_TAG) >= 0);
    const votes = t.votes || 0;
    const id = 'data-id="' + esc(t.id) + '"';
    return '<li class="q-item">' +
      '<span class="q-type">' + esc(t.type === 'youtube' ? 'YT' : t.type === 'soundcloud' ? 'SC' : 'MP3') + '</span>' +
      '<span class="q-title">' + esc(t.title || t.url) + '</span>' +
      '<span class="q-by">' + esc((t.addedBy && t.addedBy.username) || '') + '</span>' +
      '<span class="q-tools">' +
        (myRole === 'listener' ? '' :
          '<button class="chip-btn q-vote' + (voted ? ' on' : '') + '" type="button" ' + id +
          ' aria-pressed="' + (voted ? 'true' : 'false') + '" title="رأی">' +
          (voted ? '♥' : '♡') + (votes ? ' ' + votes : '') + '</button>') +
        (canManage
          ? (i > 0 ? '<button class="chip-btn q-move narrow" type="button" ' + id + ' data-to="up" title="بالاتر">↑</button>' : '') +
            '<button class="chip-btn q-move" type="button" ' + id + ' data-to="next" title="بعدی پخش شود">⏭ بعدی</button>' +
            '<button class="chip-btn q-del" type="button" ' + id + '>حذف</button>'
          : '') +
      '</span>' +
      '</li>';
  }).join('') || '<li class="q-empty">صف خالیه</li>';
}
queueList.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-id]');
  if (!b || !socket) return;
  const id = b.getAttribute('data-id');
  if (b.classList.contains('q-vote')) {
    socket.emit('queue-vote', id, (res) => {
      if (res && !res.ok) setStatus(res.error === 'slow-down' ? 'یک‌خرده صبر کن' : 'رأی ثبت نشد');
    });
    return;
  }
  if (b.classList.contains('q-move')) {
    socket.emit('queue-move', { id: id, to: b.getAttribute('data-to') }, (res) => {
      if (res && !res.ok) setStatus('اجازه نداری');
    });
    return;
  }
  if (b.classList.contains('q-del')) {
    socket.emit('queue-remove', id, (res) => {
      if (res && !res.ok) setStatus('اجازه نداری');
    });
  }
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
function paintMembers(members, dj) {
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
  uploadBtn.disabled = !canControlNow;
  searchBox.classList.toggle('hidden', !canControlNow);
  if (!canControlNow) { searchList.classList.add('hidden'); searchHint.classList.add('hidden'); }
  djRow.classList.toggle('hidden', !amHost);
  clearQueueBtn.classList.toggle('hidden', !amHost);
  paintSortBtn();
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
  const prev = speed;
  const next = parseFloat(speedSel.value) || 1;
  if (!canControlClient()) {
    // nobody gave you the controls — snap back to the room's speed
    speedSel.value = String(speed);
    setStatus('اجازه تغییر سرعت نداری');
    return;
  }
  speed = next;
  applySpeed();
  if (!socket) return;
  // The server can refuse (SoundCloud has no playback-rate API). Without
  // this ack the select kept the rejected value and this player alone ran at
  // the wrong rate until a reload.
  socket.emit('set-speed', speed, (res) => {
    if (res && res.ok) return;
    speed = prev;
    speedSel.value = String(speed);
    applySpeed();
    setStatus(res && res.error === 'speed-unsupported'
      ? 'این آهنگ سرعت پخش رو تغییر نمی‌ده'
      : 'اجازه تغییر سرعت نداری');
  });
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
// The position tick only rewrites the bar while something is playing, so a
// rejected scrub had to be undone here or it stayed where the user dragged
// it for as long as the room sat paused.
function snapSeekBar() {
  const d = getDuration();
  const p = getPosition();
  if (!isFinite(d) || d <= 0) return;
  seekBar.value = Math.max(0, Math.min(1000, (p / d) * 1000));
  updateSeekFill();
  timeCur.textContent = fmtTime(p);
}
seekBar.addEventListener('change', () => {
  const d = getDuration();
  scrubbing = false;
  if (!currentTrack || !isFinite(d) || d <= 0 || !socket) { snapSeekBar(); return; }
  if (!canControlClient()) {
    setStatus(myRole === 'listener' ? 'شنونده نمی‌تواند seek کند 🎧' : 'فعلاً فقط DJ کنترل می‌کند');
    snapSeekBar();
    return;
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

// The media layer — players, echo handling and track loading — lives in
// player.js, which loads after this file. See the note at the top of it
// for why the order is what it is.

// ============================================================ socket events
function bindSocket(s) {
  s.on('members', (list) => {
    lastMembers = Array.isArray(list) ? list : [];
    // paintMembers derives myRole/amHost from our own entry — host
    // transfers and role flips arrive here, not only via full state.
    paintMembers(lastMembers, djOnly);
  });
  s.on('load-track', (track) => {
    loadTrack(track);
    if (track) setStatus('آهنگ جدید: ' + (track.title || '') + ' — از ' + ((track.addedBy && track.addedBy.username) || '؟'));
    else setStatus('صف تمام شد.');
  });
  s.on('play', (p, seq) => withSuppress(() => doPlay(p, seq), ['play', 'seeked'], seq));
  s.on('pause', (p, seq) => withSuppress(() => doPause(p, seq), ['pause', 'seeked'], seq));
  s.on('seek', (p, seq) => withSuppress(() => doSeek(p, seq), ['seeked'], seq));
  s.on('queue-update', paintQueue);
  s.on('history-update', paintHistory);
  s.on('speed-change', (v) => applyRoomSpeed(v));
  s.on('chat-message', addChat);
  s.on('reaction', (r) => { if (r && r.emoji) popReaction(r.emoji); });
  s.on('room-flags', (f) => {
    if (!f) return;
    djOnly = !!f.djOnly;
    if (f.queueSort) queueSort = f.queueSort === 'votes' ? 'votes' : 'added';
    // hostship itself comes from members (isHost flag) — never guess it
    paintMembers(lastMembers, djOnly);
  });
  // Server rotated the host token (grace-period transfer): store it so
  // this browser can reclaim hostship later.
  s.on('host-token', (d) => {
    if (d && d.code && d.token) saveHostToken(d.code, d.token);
  });
  s.on('kicked', (d) => {
    if (d && d.code) {
      saveHostToken(d.code, null);
      saveOwnerSecret(d.code, null);
      saveRoomPassword(d.code, null);
    }
    resetRoomUI();
    history.replaceState(null, '', location.pathname);
    showOnly(lobby);
    lobbyError.textContent = 'هاست تو را از اتاق بیرون کرد';
  });
}
let lastMembers = [];

function applyFullState(st) {
  lastMembers = st.members || [];
  queueSort = st.queueSort === 'votes' ? 'votes' : 'added';
  paintMembers(st.members, st.djOnly);
  applyRoomSpeed(st.speed || 1);
  paintQueue(st.queue);
  paintHistory(st.history);
  chatList.innerHTML = '';
  (st.chat || []).forEach(addChat);
  if (st.track) {
    loadTrack(st.track);
    const needWait = st.track.type === 'youtube' ? !ytPlayer : st.track.type === 'soundcloud' ? !scPlayer : false;
    if (needWait) { stashPending(st.isPlaying, st.position, st.seq); return; }
    withSuppress(() => {
      doSeek(st.position, st.seq);
      if (st.isPlaying) doPlay(st.position, st.seq); else doPause(st.position, st.seq);
    }, ['play', 'pause', 'seeked'], st.seq);
  } else {
    loadTrack(null);
  }
}

function autoRejoin() {
  const code = (location.hash || '').replace('#', '').toUpperCase().trim();
  if (!code || !socket) return;
  socket.emit('join-room', code, {
    hostToken: getHostToken(code),
    ownerSecret: getOwnerSecret(code),
    password: getRoomPassword(code),
  }, (res) => {
    if (!res || !res.ok) {
      const err = res && res.error;
      // Transient: keep the hash so the next reconnect retries, otherwise the
      // room is dropped from the address bar and rejoining is impossible.
      if (err === 'rate-limited') {
        if (!currentCode) lobbyError.textContent = 'خیلی سریع — چند لحظه صبر کن';
        return;
      }
      history.replaceState(null, '', location.pathname);
      if (currentCode) { resetRoomUI(); showOnly(lobby); }
      // Opening an invite to a room that has since expired used to drop you
      // into the lobby with no explanation at all.
      lobbyError.textContent = err === 'banned'
        ? 'هاست تو را از اتاق بیرون کرد'
        : 'اتاق ' + code + ' دیگه موجود نیست';
      return;
    }
    onEnteredRoom(res);
  });
}

// Editing the hash (pasting another invite, hitting back) now actually moves
// you between rooms — previously only a fresh page load read it.
window.addEventListener('hashchange', () => {
  if (!socket) return;
  const want = (location.hash || '').replace('#', '').toUpperCase().trim();
  if (want === currentCode) return;
  if (!want) { if (currentCode) leaveBtn.click(); return; }
  if (!/^[A-Z0-9]{5}$/.test(want)) return;
  if (currentCode) { socket.emit('leave-room'); resetRoomUI(); }
  showOnly(lobby);
  doJoin(want, listenerCheck.checked);
});

// heartbeat: drift fix + autoplay-block recovery, in BOTH directions.
// Only ever correcting "should be playing" meant a missed 'pause' left one
// client audible until somebody touched the controls again.
function locallyPlaying() {
  if (!currentTrack) return false;
  if (currentTrack.type === 'audio') return !audio.paused && !audio.ended;
  if (currentTrack.type === 'youtube') {
    try {
      return !!(ytPlayer && ytPlayer.getPlayerState &&
        ytPlayer.getPlayerState() === YT.PlayerState.PLAYING);
    } catch (e) { return false; }
  }
  if (currentTrack.type === 'soundcloud') return scReady && scPlaying;
  return false;
}
// distinct from !locallyPlaying(): a track that simply ran out is not a
// "should be playing" failure the heartbeat ought to re-fire
function locallyPaused() {
  if (!currentTrack) return false;
  if (currentTrack.type === 'audio') return audio.paused && !audio.ended;
  if (currentTrack.type === 'youtube') {
    try {
      return !!(ytPlayer && ytPlayer.getPlayerState &&
        ytPlayer.getPlayerState() === YT.PlayerState.PAUSED);
    } catch (e) { return false; }
  }
  if (currentTrack.type === 'soundcloud') return !!(scPlayer && scReady && !scPlaying);
  return false;
}
setInterval(() => {
  if (!socket || !currentTrack) return;
  socket.emit('ping-state', (state) => {
    if (!state || !state.track) return;
    // speed is shared too; re-applying it also snaps a denied change back
    if (state.speed && state.speed !== speed) applyRoomSpeed(state.speed);
    if (state.isPlaying) {
      if (locallyPaused()) { withSuppress(() => doPlay(state.position, state.seq), ['play', 'seeked'], state.seq); return; }
      if (Math.abs(getPosition() - state.position) > SYNC_DRIFT)
        withSuppress(() => doSeek(state.position, state.seq), ['seeked'], state.seq);
    } else if (locallyPlaying()) {
      withSuppress(() => doPause(state.position, state.seq), ['pause', 'seeked'], state.seq);
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
