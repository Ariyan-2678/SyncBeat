// smoke-client.js — run public/app.js against a stubbed DOM.
//
// A syntax check cannot see a reference that only exists at runtime: a helper
// that was renamed, a call left behind after a refactor, a typo in a property
// path. Those fail the moment the page loads, which is far worse than failing
// a test. This loads the client the way a browser would and then calls the
// interesting functions once each, so the failure shows up here instead.
//
// It is not a behaviour test — the media players are stubs. It answers one
// question: does this file blow up when you touch it?
const path = require('path');
const fs = require('fs');
const vm = require('vm');

// Anything the client touches returns another stub, so a missing DOM node or
// an unloaded player API is not what this test is looking for.
function stub(name) {
  const fn = function () { return stub(name + '()'); };
  return new Proxy(fn, {
    get(t, p) {
      if (p === Symbol.toPrimitive) return () => '';
      if (typeof p === 'symbol') return undefined;
      if (p === 'then') return undefined; // never look awaitable
      if (p === 'toString') return () => '';
      if (p === 'valueOf') return () => 0;
      if (p === 'length') return 0;
      if (p in t) return t[p];
      return stub(name + '.' + String(p));
    },
    set() { return true; },
    apply() { return stub(name + '()'); },
    has() { return true; },
  });
}

// Exercised after load, in this order. Anything that throws is reported.
const PROBES = `
  socket = { emit: function () {}, on: function () {}, disconnect: function () {} };
  [
    ['emitControl/local',     () => emitControl('play', 'play', 1)],
    ['withSuppress/local',    () => withSuppress(function () {}, undefined)],
    ['emitControl/echo',      () => emitControl('play', 'play', 1)],
    ['withSuppress/remote',   () => withSuppress(function () {}, ['play', 'seeked'], 4)],
    ['emitControl/remote',    () => emitControl('play', 'play', 1)],
    ['emitEnded',             () => emitEnded()],
    ['stopAllPlayers',        () => stopAllPlayers()],
    ['loadTrack(audio)',      () => loadTrack({ id: 't1', type: 'audio', url: 'https://x/a.mp3', title: 'A', addedBy: { username: 'U' } })],
    ['getPosition',           () => getPosition()],
    ['getDuration',           () => getDuration()],
    ['updateAddBtn',          () => updateAddBtn()],
    ['doPlay',                () => doPlay(1, 4)],
    ['doPause',               () => doPause(1, 4)],
    ['doSeek',                () => doSeek(1, 4)],
    ['stashPending',          () => stashPending(true, 1, 4)],
    ['snapSeekBar',           () => snapSeekBar()],
    ['locallyPlaying',        () => locallyPlaying()],
    ['locallyPaused',         () => locallyPaused()],
    ['loadTrack(youtube)',    () => loadTrack({ id: 't2', type: 'youtube', url: 'abcdefghijk', title: 'Y', addedBy: { username: 'U' } })],
    ['doPlay (yt pending)',   () => doPlay(3, 5)],
    ['loadTrack(soundcloud)', () => loadTrack({ id: 't3', type: 'soundcloud', url: 'https://soundcloud.com/a/b', title: 'S', addedBy: { username: 'U' } })],
    ['doPlay (sc pending)',   () => doPlay(3, 6)],
    ['applyVolume',           () => applyVolume()],
    ['applySpeed',            () => applySpeed()],
    ['applyRoomSpeed',        () => applyRoomSpeed(1.25)],
    ['applyRoomSpeed(bad)',   () => applyRoomSpeed(3)],
    ['paintQueue',            () => paintQueue([{ id: 'q1', type: 'audio', url: 'https://x/b.mp3', title: 'B', addedBy: { username: 'U', ownerId: 'tag' } }])],
    ['paintQueue(empty)',     () => paintQueue([])],
    ['paintHistory',          () => paintHistory([])],
    ['paintMembers',          () => paintMembers([{ userId: 'u1', username: 'U', color: 'hsl(1 45% 55%)', role: 'member', isHost: false }], false)],
    ['paintMembers(djOnly)',  () => paintMembers([{ userId: 'u1', username: 'U', color: 'hsl(1 45% 55%)', role: 'member', isHost: true }], true)],
    ['addChat',               () => addChat({ id: 'm1', username: 'U', text: 'hi', at: Date.now(), color: 'hsl(2 45% 55%)' })],
    ['popReaction',           () => popReaction('🔥')],
    ['applyFullState(playing)', () => applyFullState({
        track: { id: 't4', type: 'audio', url: 'https://x/c.mp3', title: 'C', addedBy: { username: 'U' } },
        queue: [], history: [], chat: [], isPlaying: true, position: 12,
        members: [{ userId: 'u1', username: 'U', color: 'hsl(3 45% 55%)', role: 'member', isHost: true }],
        hostId: 'u1', djOnly: false, speed: 1, seq: 9,
      })],
    ['applyFullState(empty)', () => applyFullState({
        track: null, queue: [], history: [], chat: [], isPlaying: false, position: 0,
        members: [], hostId: null, djOnly: false, speed: 1, seq: 0,
      })],
    ['enterRoom',             () => enterRoom('ABCDE')],
    ['updateInvite',          () => updateInvite()],
    ['autoRejoin',            () => autoRejoin()],
    ['resetRoomUI',           () => resetRoomUI()],
    ['validNameLocal',        () => validNameLocal('علی')],
    ['uploadFile(guard)',     () => uploadFile({ size: 10, type: 'text/plain', name: 'notes.txt' })],
    ['uploadBtn handler',     () => uploadBtn.onclick()],
    ['validNameLocal(bad)',   () => validNameLocal('x')],
    ['esc',                   () => esc('<b>&"')],
    ['fmtTime',               () => fmtTime(65)],
  ].map(function (entry) {
    try { entry[1](); return null; } catch (e) { return entry[0] + ': ' + e.message; }
  }).filter(Boolean);
`;

function loadClient(label, store) {
  const document = {
    getElementById: (id) => stub('#' + id),
    querySelector: () => stub('q'),
    querySelectorAll: () => [],
    createElement: () => stub('created'),
    body: stub('body'),
    documentElement: stub('html'),
  };
  const sandbox = {
    console,
    document,
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    navigator: { clipboard: null },
    location: { hash: '', pathname: '/', origin: 'http://localhost', search: '' },
    history: { replaceState: () => {}, pushState: () => {} },
    io: () => stub('io'),
    // the SoundCloud widget has no playback-rate API — mirror that here
    YT: { PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, CUED: 5 } },
    SC: Object.assign(() => stub('sc'), {
      Widget: Object.assign(() => stub('scwidget'), {
        Events: { READY: 'ready', PLAY: 'play', PAUSE: 'pause', FINISH: 'finish', PLAY_PROGRESS: 'progress' },
      }),
    }),
    SyncEcho: require('../public/echo.js'),
    crypto: {
      getRandomValues: (a) => { for (let i = 0; i < a.length; i++) a[i] = (Math.random() * 256) | 0; return a; },
    },
    fetch: async () => ({ json: async () => ({}) }),
    AbortController: class { constructor() { this.signal = {}; } abort() {} },
    URL, JSON, Math, Date, String, Number, Array, Object, RegExp, Error, Promise,
    isFinite, parseInt, parseFloat, setTimeout, clearTimeout,
    setInterval: () => 0, // the 5s heartbeat must not keep this process alive
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  // Same order as index.html: app.js declares the DOM handles and the player
  // state, player.js layers the media handling on top of them.
  const files = ['app.js', 'player.js'];
  try {
    vm.createContext(sandbox);
    for (const f of files) {
      const src = fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
      vm.runInContext(src, sandbox, { filename: 'public/' + f });
    }
    vm.runInContext('socket = { emit: function () {}, on: function () {}, disconnect: function () {} };', sandbox);
    const problems = vm.runInContext(PROBES, sandbox, { filename: 'smoke-probes' });
    if (problems.length) {
      console.error('FAIL: ' + label + ' threw from: ' + problems.join(' | '));
      return false;
    }
    console.log('ok: client boots and its entry points run (' + label + ')');
    return true;
  } catch (e) {
    console.error('FAIL: ' + label + ' threw while booting: ' + e.message);
    console.error(e.stack.split('\n').slice(0, 6).join('\n'));
    return false;
  }
}

const firstVisit = loadClient('first visit', {});
const returning = loadClient('returning guest', {
  'sb-guest': JSON.stringify({ id: 'guestSmoke01', username: 'Smoke' }),
  'sb-guest-id': 'guestSmoke01',
  'sb-hosts': JSON.stringify({ ABCDE: 'tok'.repeat(10) }),
  'sb-owners': JSON.stringify({ ABCDE: 'sec'.repeat(10) }),
});

process.exit(firstVisit && returning ? 0 : 1);
