// app.js — client logic for Sync Music Rooms
// Core sync/player logic unchanged; a UI layer (theme, transport bar, toasts)
// is layered on top in clearly marked sections.

const socket = io();

// ---- DOM ----
const lobby = document.getElementById('lobby');
const room = document.getElementById('room');
const createBtn = document.getElementById('createBtn');
const joinBtn = document.getElementById('joinBtn');
const codeInput = document.getElementById('codeInput');
const lobbyError = document.getElementById('lobbyError');
const roomCode = document.getElementById('roomCode');
const copyBtn = document.getElementById('copyBtn');
const userCount = document.getElementById('userCount');
const trackUrl = document.getElementById('trackUrl');
const loadBtn = document.getElementById('loadBtn');
const emptyMsg = document.getElementById('empty');
const audio = document.getElementById('audio');
const ytWrap = document.getElementById('ytWrap');
const scWrap = document.getElementById('scWrap');
const statusEl = document.getElementById('status');

// ---- UI elements (transport bar, theme) ----
const transport = document.getElementById('transport');
const playPauseBtn = document.getElementById('playPauseBtn');
const seekBar = document.getElementById('seekBar');
const timeCur = document.getElementById('timeCur');
const timeDur = document.getElementById('timeDur');
const themeToggle = document.getElementById('themeToggle');
const joinForm = document.getElementById('joinForm');
const trackForm = document.getElementById('trackForm');

// ---- State ----
let currentTrack = null;      // { type, url }
let ytPlayer = null;          // YouTube player instance
let ytReady = false;          // IFrame API loaded
let scPlayer = null;          // SoundCloud Widget instance
let scReady = false;          // SoundCloud widget reported ready
let suppress = false;         // true while applying a remote event (prevents echo)
const SYNC_DRIFT = 1.2;       // seconds of allowed drift before correcting
let scrubbing = false;        // user is dragging the seek bar

function setStatus(msg) {
  statusEl.textContent = msg;
  // Brief accent flash so new messages read as events, then settle.
  statusEl.classList.remove('flash');
  void statusEl.offsetWidth; // restart the transition
  if (msg) statusEl.classList.add('flash');
  setTimeout(() => statusEl.classList.remove('flash'), 1600);
}

// ============================================================
// UI: theme toggle (dark default, persisted)
// ============================================================
themeToggle.addEventListener('click', () => {
  const next =
    document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('sb-theme', next); } catch (e) { /* private mode */ }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', next === 'light' ? '#edf1ea' : '#101511');
});

// ============================================================
// UI: custom transport bar (drives the existing <audio> element;
//     the original play/pause/seeked listeners below still emit
//     to the server, so sync behavior is identical)
// ============================================================
function fmtTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return m + ':' + String(sec).padStart(2, '0');
}

function updateSeekFill() {
  const max = parseFloat(seekBar.max) || 1000;
  seekBar.style.setProperty('--fill', (seekBar.value / max) * 100 + '%');
}

audio.addEventListener('loadedmetadata', () => {
  timeDur.textContent = fmtTime(audio.duration);
});

audio.addEventListener('timeupdate', () => {
  if (scrubbing) return;
  if (isFinite(audio.duration) && audio.duration > 0) {
    seekBar.value = (audio.currentTime / audio.duration) * 1000;
    updateSeekFill();
  }
  timeCur.textContent = fmtTime(audio.currentTime);
});

// While dragging: preview locally, no server chatter.
seekBar.addEventListener('input', () => {
  scrubbing = true;
  updateSeekFill();
  if (isFinite(audio.duration)) {
    timeCur.textContent = fmtTime((seekBar.value / 1000) * audio.duration);
  }
});

// On release: apply the seek once; the existing 'seeked' listener emits it.
seekBar.addEventListener('change', () => {
  if (isFinite(audio.duration)) {
    audio.currentTime = (seekBar.value / 1000) * audio.duration;
  }
  scrubbing = false;
});

playPauseBtn.addEventListener('click', () => {
  if (audio.paused) audio.play().catch(() => {});
  else audio.pause();
});

// Reflect playing state on the transport + let the aurora breathe with it.
function setPlayingUI(playing) {
  transport.classList.toggle('playing', playing);
  document.body.classList.toggle('playing', playing);
}
audio.addEventListener('play', () => setPlayingUI(true));
audio.addEventListener('pause', () => setPlayingUI(false));
audio.addEventListener('ended', () => setPlayingUI(false));

// ---------- Lobby actions ----------
createBtn.onclick = () => {
  socket.emit('create-room', (res) => {
    if (res.ok) enterRoom(res.code);
  });
};

joinBtn.onclick = () => {
  const code = codeInput.value.toUpperCase().trim();
  if (!code) { lobbyError.textContent = 'کد اتاق رو وارد کن'; return; }
  socket.emit('join-room', code, (res) => {
    if (!res.ok) { lobbyError.textContent = 'اتاقی با این کد پیدا نشد'; return; }
    enterRoom(res.code);
    if (res.state && res.state.track) applyState(res.state);
  });
};

// The join row is a real form now; pressing Enter in the code field
// triggers the form's native submit, which routes to the join action.
joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  joinBtn.click();
});

// The track row is a real form too; submit = load.
trackForm.addEventListener('submit', (e) => {
  e.preventDefault();
  loadBtn.click();
});

function enterRoom(code) {
  lobby.classList.add('hidden');
  room.classList.remove('hidden');
  // Re-run the entrance animation each time we switch views.
  room.classList.remove('rise-in');
  void room.offsetWidth;
  room.classList.add('rise-in');
  roomCode.textContent = code;
  // Persist room in the URL so a refresh keeps us in the room.
  if (('#' + code) !== location.hash) {
    history.replaceState(null, '', '#' + code);
  }
}

copyBtn.onclick = () => {
  navigator.clipboard.writeText(roomCode.textContent).then(() => {
    copyBtn.classList.add('copied');
    const label = copyBtn.querySelector('.copy-label');
    if (label) label.textContent = 'کپی شد ✓';
    setTimeout(() => {
      copyBtn.classList.remove('copied');
      if (label) label.textContent = 'کپی';
    }, 1500);
  });
};

// ---------- Load a track ----------
loadBtn.onclick = () => {
  const url = trackUrl.value.trim();
  if (!url) return;
  let payload;
  if (parseYouTube(url)) {
    payload = { type: 'youtube', url: parseYouTube(url) };
  } else if (isSoundCloud(url)) {
    payload = { type: 'soundcloud', url };
  } else {
    payload = { type: 'audio', url };
  }
  socket.emit('load-track', payload);
};

function parseYouTube(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([\w-]{11})/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1]; // return video ID
  }
  return null;
}

function isSoundCloud(url) {
  return /(?:soundcloud\.com|snd\.sc)\//i.test(url);
}

// ---------- Socket events (incoming) ----------
socket.on('room-users', (n) => { userCount.textContent = n; });

socket.on('load-track', (track) => {
  loadTrack(track);
  setStatus('آهنگ جدید لود شد.');
});

socket.on('play', (position) => withSuppress(() => doPlay(position)));
socket.on('pause', (position) => withSuppress(() => doPause(position)));
socket.on('seek', (position) => withSuppress(() => doSeek(position)));

function applyState(state) {
  loadTrack(state.track);
  withSuppress(() => {
    doSeek(state.position);
    if (state.isPlaying) doPlay(state.position);
    else doPause(state.position);
  });
}

function withSuppress(fn) {
  suppress = true;
  try { fn(); } finally {
    // release after a tick so player-triggered events settle
    setTimeout(() => (suppress = false), 250);
  }
}

// ---------- Unified player abstraction ----------
function loadTrack(track) {
  currentTrack = track;
  emptyMsg.classList.add('hidden');

  // Hide everything first, then show the right player.
  const isAudio = track.type === 'audio';
  const isYt = track.type === 'youtube';
  const isSc = track.type === 'soundcloud';

  // The audio element stays hidden; the custom transport bar stands in
  // for the native controls it used to show.
  audio.classList.add('hidden');
  transport.classList.toggle('hidden', !isAudio);
  ytWrap.classList.toggle('hidden', !isYt);
  scWrap.classList.toggle('hidden', !isSc);

  if (isAudio) {
    seekBar.value = 0;
    updateSeekFill();
    timeCur.textContent = '0:00';
    timeDur.textContent = '0:00';
    audio.src = track.url;
    audio.load();
  } else if (isYt) {
    audio.pause();
    loadYouTube(track.url);
  } else if (isSc) {
    audio.pause();
    loadSoundCloud(track.url);
  }
}

function getPosition() {
  if (!currentTrack) return 0;
  if (currentTrack.type === 'audio') return audio.currentTime;
  if (currentTrack.type === 'youtube') {
    if (ytPlayer && ytPlayer.getCurrentTime) return ytPlayer.getCurrentTime();
  }
  // SoundCloud position is async; heartbeat handles it via scLastPos.
  if (currentTrack.type === 'soundcloud') return scLastPos;
  return 0;
}

function doPlay(position) {
  if (!currentTrack) return;
  if (currentTrack.type === 'audio') {
    if (typeof position === 'number' && Math.abs(audio.currentTime - position) > SYNC_DRIFT) {
      audio.currentTime = position;
    }
    audio.play().catch(() => setStatus('برای پخش، یه‌بار روی صفحه کلیک کن.'));
  } else if (currentTrack.type === 'youtube' && ytPlayer) {
    if (typeof position === 'number' && Math.abs(ytPlayer.getCurrentTime() - position) > SYNC_DRIFT) {
      ytPlayer.seekTo(position, true);
    }
    ytPlayer.playVideo();
  } else if (currentTrack.type === 'soundcloud' && scPlayer) {
    if (typeof position === 'number') scPlayer.seekTo(position * 1000);
    scPlayer.play();
  }
}

function doPause(position) {
  if (!currentTrack) return;
  if (currentTrack.type === 'audio') {
    if (typeof position === 'number') audio.currentTime = position;
    audio.pause();
  } else if (currentTrack.type === 'youtube' && ytPlayer) {
    if (typeof position === 'number') ytPlayer.seekTo(position, true);
    ytPlayer.pauseVideo();
  } else if (currentTrack.type === 'soundcloud' && scPlayer) {
    if (typeof position === 'number') scPlayer.seekTo(position * 1000);
    scPlayer.pause();
  }
}

function doSeek(position) {
  if (!currentTrack || typeof position !== 'number') return;
  if (currentTrack.type === 'audio') audio.currentTime = position;
  else if (currentTrack.type === 'youtube' && ytPlayer) ytPlayer.seekTo(position, true);
  else if (currentTrack.type === 'soundcloud' && scPlayer) scPlayer.seekTo(position * 1000);
}

// ---------- Audio element -> emit events ----------
audio.addEventListener('play', () => { if (!suppress) socket.emit('play', audio.currentTime); });
audio.addEventListener('pause', () => {
  if (!suppress && !audio.ended) socket.emit('pause', audio.currentTime);
});
audio.addEventListener('seeked', () => { if (!suppress) socket.emit('seek', audio.currentTime); });

// ---------- YouTube player ----------
function loadYouTube(videoId) {
  if (!ytReady) {
    // API not ready yet; retry shortly.
    setTimeout(() => loadYouTube(videoId), 300);
    return;
  }
  if (!ytPlayer) {
    ytPlayer = new YT.Player('ytPlayer', {
      videoId,
      playerVars: { rel: 0, playsinline: 1 },
      events: { onStateChange: onYtStateChange },
    });
  } else {
    ytPlayer.loadVideoById(videoId);
  }
}

function onYtStateChange(e) {
  // UI only: let the aurora react to playback (emitting logic untouched).
  if (e.data === YT.PlayerState.PLAYING) setPlayingUI(true);
  else if (e.data === YT.PlayerState.PAUSED || e.data === YT.PlayerState.ENDED) setPlayingUI(false);

  if (suppress) return;
  // 1 = playing, 2 = paused
  if (e.data === YT.PlayerState.PLAYING) {
    socket.emit('play', ytPlayer.getCurrentTime());
  } else if (e.data === YT.PlayerState.PAUSED) {
    socket.emit('pause', ytPlayer.getCurrentTime());
  }
}

// Called by the YouTube IFrame API when it finishes loading.
window.onYouTubeIframeAPIReady = () => { ytReady = true; };

// ---------- SoundCloud player ----------
let scLastPos = 0; // last known position (seconds), updated by the widget

function loadSoundCloud(url) {
  // Rebuild the iframe each time so a new track loads cleanly.
  scReady = false;
  const src = 'https://w.soundcloud.com/player/?url=' + encodeURIComponent(url) +
    '&auto_play=false&show_comments=false&visual=true';
  scWrap.innerHTML = '<iframe id="scIframe" width="100%" height="166" scrolling="no" ' +
    'frameborder="no" allow="autoplay" src="' + src + '"></iframe>';

  if (typeof SC === 'undefined' || !SC.Widget) {
    setTimeout(() => loadSoundCloud(url), 300);
    return;
  }
  scPlayer = SC.Widget(document.getElementById('scIframe'));
  scPlayer.bind(SC.Widget.Events.READY, () => {
    scReady = true;
    // Keep scLastPos fresh so getPosition()/heartbeat works.
    scPlayer.bind(SC.Widget.Events.PLAY_PROGRESS, (e) => {
      scLastPos = e.currentPosition / 1000;
    });
    scPlayer.bind(SC.Widget.Events.PLAY, () => {
      setPlayingUI(true);
      if (suppress) return;
      scPlayer.getPosition((ms) => socket.emit('play', ms / 1000));
    });
    scPlayer.bind(SC.Widget.Events.PAUSE, () => {
      setPlayingUI(false);
      if (suppress) return;
      scPlayer.getPosition((ms) => socket.emit('pause', ms / 1000));
    });
  });
}

// ---------- Auto-rejoin from URL on load/refresh ----------
function autoRejoin() {
  const code = (location.hash || '').replace('#', '').toUpperCase().trim();
  if (!code) return;
  socket.emit('join-room', code, (res) => {
    if (!res.ok) {
      // Room no longer exists (e.g. server restarted) — clear the URL, stay in lobby.
      history.replaceState(null, '', location.pathname);
      return;
    }
    enterRoom(res.code);
    if (res.state && res.state.track) applyState(res.state);
  });
}

// Rejoin both on initial connect and on any reconnect.
socket.on('connect', autoRejoin);

// ---------- Drift correction heartbeat ----------
setInterval(() => {
  if (!currentTrack) return;
  socket.emit('sync-request', (state) => {
    if (!state || !state.track) return;
    if (state.isPlaying) {
      const pos = getPosition();
      if (Math.abs(pos - state.position) > SYNC_DRIFT) {
        withSuppress(() => doSeek(state.position));
      }
    }
  });
}, 5000);
