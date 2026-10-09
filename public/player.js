// player.js — the media layer.
//
// Loads AFTER app.js on purpose. Every classic script on the page shares one
// global scope, so the DOM handles, the player state and the helpers this
// file uses (setStatus, applyVolume, setPlayingUI…) are the ones app.js
// declares. Those are only touched from inside functions, which run on an
// event or on a socket message — long after app.js has finished defining
// them — so nothing here is read at load time except this file's own state.
//
// If you add a call into here that runs during boot, load order matters and
// the smoke test (test/smoke-client.js) is what will tell you.

// ============================================================ sync core
// Applying a command that came from the server must not be bounced straight
// back. A plain time window does not work: <audio> can take seconds to
// actually start, so its 'play' event lands long after the window closed and
// looks like a local ▶ — and if the room has moved on by then, forwarding it
// would undo the newer command (host pauses, a buffering client's late play
// resumes everyone). Each remote command therefore registers the transitions
// it expects plus the seq it was given; when the matching event fires it is
// sent back with that seq, and the server tells an echo from a real action.
// Run fn() while remembering what it is going to make the player emit —
// see public/echo.js for how the two cases are told apart.
function withSuppress(fn, kinds, seq) {
  if (typeof seq === 'number') echo.expectEcho(kinds || ['play', 'pause', 'seeked'], seq);
  else echo.expectDrop(['pause', 'seeked', 'ended']);
  try { fn(); } catch (e) { /* player may not be ready yet */ }
}
function emitControl(kind, event, value) {
  if (!socket) return;
  const c = echo.resolve(kind);
  if (c.send) socket.emit(event, value, c.seq);
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
  pending = null; // belongs to the previous track, if it ever became ready
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
// `seq` is the command id the server attached to this instruction; it is only
// remembered so a player that becomes ready later still reports the right one.
function stashPending(isPlaying, position, seq) {
  pending = { isPlaying: isPlaying, position: position, seq: seq };
}
function doPlay(position, seq) {
  if (!currentTrack) return;
  if (currentTrack.type === 'audio') {
    if (typeof position === 'number' && Math.abs(audio.currentTime - position) > SYNC_DRIFT) audio.currentTime = position;
    applyVolume(); applySpeed();
    audio.play().catch(() => setStatus('برای پخش، یه‌بار روی صفحه کلیک کن.'));
  } else if (currentTrack.type === 'youtube') {
    if (!ytPlayer) { stashPending(true, position || 0, seq); return; }
    try {
      if (typeof position === 'number' && Math.abs(ytPlayer.getCurrentTime() - position) > SYNC_DRIFT)
        ytPlayer.seekTo(position, true);
      applyVolume(); applySpeed();
      ytPlayer.playVideo();
    } catch (e) {}
  } else if (currentTrack.type === 'soundcloud') {
    if (!scPlayer) { stashPending(true, position || 0, seq); return; }
    if (typeof position === 'number' && Math.abs(scLastPos - position) > SYNC_DRIFT) {
      scPlayer.seekTo(position * 1000); scActionAt = Date.now();
    }
    scActionAt = Date.now();
    applyVolume();
    scPlayer.play();
  }
}
function doPause(position, seq) {
  if (!currentTrack) return;
  if (currentTrack.type === 'audio') {
    if (typeof position === 'number') { try { audio.currentTime = position; } catch (e) {} }
    audio.pause();
  } else if (currentTrack.type === 'youtube') {
    if (!ytPlayer) { stashPending(false, position || 0, seq); return; }
    try {
      if (typeof position === 'number') ytPlayer.seekTo(position, true);
      ytPlayer.pauseVideo();
    } catch (e) {}
  } else if (currentTrack.type === 'soundcloud') {
    if (!scPlayer) { stashPending(false, position || 0, seq); return; }
    try {
      if (typeof position === 'number') scPlayer.seekTo(position * 1000);
      scActionAt = Date.now();
      scPlayer.pause();
    } catch (e) {}
  }
}
function doSeek(position, seq) {
  if (!currentTrack || typeof position !== 'number') return;
  if (currentTrack.type === 'audio') { try { audio.currentTime = position; } catch (e) {} }
  else if (currentTrack.type === 'youtube') {
    if (!ytPlayer) { stashPending(true, position, seq); return; }
    try { ytPlayer.seekTo(position, true); } catch (e) {}
  } else if (currentTrack.type === 'soundcloud') {
    if (!scPlayer) { stashPending(true, position, seq); return; }
    scActionAt = Date.now();
    try { scPlayer.seekTo(position * 1000); } catch (e) {}
  }
}
function emitEnded() {
  // An 'ended' we caused (swapping tracks) must not advance the queue, and
  // there is no seq on this event to let the server decide — so it is simply
  // dropped when it is ours.
  const ours = echo.consumeDrop('ended');
  if (!ours && socket && currentTrack) socket.emit('track-ended');
  setPlayingUI(false);
}

// audio -> server
audio.addEventListener('play', () => emitControl('play', 'play', audio.currentTime));
audio.addEventListener('pause', () => {
  if (audio.ended) return;
  emitControl('pause', 'pause', audio.currentTime);
});
audio.addEventListener('seeked', () => emitControl('seeked', 'seek', audio.currentTime));
audio.addEventListener('ended', emitEnded);

// youtube
let ytLoadToken = 0;
function loadYouTube(videoId, attempt) {
  attempt = attempt || 0;
  const token = ++ytLoadToken;
  if (!ytReady) {
    // The iframe API is a third-party script. Retrying keeps the player
    // usable when it is merely slow, but without a cap this would spin
    // forever when it is blocked — and without the token a retry queued for
    // an older video would clobber the one the user just picked.
    if (attempt >= 100) { setStatus('یوتیوب لود نشد — اینترنتت رو چک کن'); return; }
    setTimeout(() => { if (token === ytLoadToken) loadYouTube(videoId, attempt + 1); }, 300);
    return;
  }
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
            }, ['play', 'pause', 'seeked'], p.seq);
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
  if (!socket) return;
  if (e.data === YT.PlayerState.PLAYING) emitControl('play', 'play', ytPlayer.getCurrentTime());
  else if (e.data === YT.PlayerState.PAUSED) emitControl('pause', 'pause', ytPlayer.getCurrentTime());
  else if (e.data === YT.PlayerState.ENDED) emitEnded();
}
window.onYouTubeIframeAPIReady = () => { ytReady = true; };
if (typeof YT !== 'undefined' && YT.loaded) ytReady = true;

// soundcloud
let scLoadToken = 0;
function loadSoundCloud(url, attempt) {
  attempt = attempt || 0;
  const token = ++scLoadToken;
  // Check the API BEFORE touching the iframe: the old code rebuilt the
  // iframe on every retry, so a slow api.js reloaded the embed forever, and a
  // retry left over from the previous track would replace the new one.
  if (typeof SC === 'undefined' || !SC.Widget) {
    if (attempt >= 100) { setStatus('ساندکلاد لود نشد — اینترنتت رو چک کن'); return; }
    setTimeout(() => { if (token === scLoadToken) loadSoundCloud(url, attempt + 1); }, 300);
    return;
  }
  scReady = false; scDuration = 0;
  const src = 'https://w.soundcloud.com/player/?url=' + encodeURIComponent(url) +
    '&auto_play=false&show_comments=false&visual=true';
  scWrap.innerHTML = '<iframe id="scIframe" width="100%" height="166" scrolling="no" ' +
    'frameborder="no" allow="autoplay" src="' + src + '"></iframe>';
  scPlayer = SC.Widget(document.getElementById('scIframe'));
  scPlayer.bind(SC.Widget.Events.READY, () => {
    if (token !== scLoadToken) return; // a newer track already took over
    scReady = true;
    try { scPlayer.getDuration((ms) => { scDuration = (ms || 0) / 1000; }); } catch (e) {}
    try { scPlayer.setVolume(volume); } catch (e) {}
    if (pending) {
      const p = pending; pending = null;
      withSuppress(() => {
        doSeek(p.position);
        if (p.isPlaying) doPlay(p.position); else doPause(p.position);
      }, ['play', 'pause', 'seeked'], p.seq);
    }
    scPlayer.bind(SC.Widget.Events.PLAY_PROGRESS, (ev) => { scLastPos = ev.currentPosition / 1000; });
    scPlayer.bind(SC.Widget.Events.PLAY, () => {
      scPlaying = true; setPlayingUI(true);
      try { scPlayer.getDuration((ms) => { scDuration = (ms || 0) / 1000; }); } catch (e) {}
      if (!socket) return;
      const c = echo.resolve('play'); // decide now, the value arrives async
      scPlayer.getPosition((ms) => { if (c.send) socket.emit('play', ms / 1000, c.seq); });
    });
    scPlayer.bind(SC.Widget.Events.PAUSE, () => {
      const wasPlaying = scPlaying;
      scPlaying = false; setPlayingUI(false);
      if (!wasPlaying) return;
      if (Date.now() - scActionAt < SC_ECHO_MS) return;
      if (!socket) return;
      const c = echo.resolve('pause');
      scPlayer.getPosition((ms) => { if (c.send) socket.emit('pause', ms / 1000, c.seq); });
    });
    scPlayer.bind(SC.Widget.Events.FINISH, emitEnded);
  });
}

