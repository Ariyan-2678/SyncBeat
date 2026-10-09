// Real-browser verification: drives headless Chrome over the DevTools
// Protocol. This exists because the app's own preview tooling was
// unavailable for this whole session, and a suite that only exercises the
// server cannot tell you whether anything actually plays.
//
// Not part of `npm test` — it needs Chrome on the machine. Run directly:
//   node browser-check.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const ROOT = __dirname;
// Unique per run, for the same reason as CDP_PORT below.
const PORT = 4310 + (process.pid % 500);
const BASE = 'http://localhost:' + PORT;
const AUDIO_PORT = PORT + 1;
// Unique per run: two runs in quick succession would otherwise share a debug
// port, and the second would drive whatever browser the first left behind.
const CDP_PORT = 9444 + (process.pid % 500);
// Not part of `npm test`: it needs a real Chrome on the machine. Override
// with CHROME_PATH if yours is somewhere else.
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const CHROME = CHROME_CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch (e) { return false; } });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (label, ok, got) => {
  console.log((ok ? '  PASS ' : '  FAIL ') + label + (got !== undefined ? '  [' + got + ']' : ''));
  if (!ok) failures++;
};

// ---- a small WAV so there is something real to play -----------------------
function wav(seconds, hz) {
  const rate = 8000;
  const n = Math.floor(rate * seconds);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const v = Math.sin((2 * Math.PI * 440 * i) / rate) * 0.25 * 32767;
    data.writeInt16LE(Math.round(v), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8);
  head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22); head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

// ---- a very small CDP client ---------------------------------------------
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = []; }
  static async open(url) {
    const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    const c = new CDP(ws);
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw));
      if (m.id && c.pending.has(m.id)) {
        const { res, rej } = c.pending.get(m.id);
        c.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      } else if (m.method) {
        c.handlers.forEach((h) => h(m));
      }
    });
    return c;
  }
  on(fn) { this.handlers.push(fn); }
  send(method, params) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

// Evaluate an expression in the page and return its JSON value.
async function evalIn(page, expression) {
  const r = await page.send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error('page threw: ' + (r.exceptionDetails.exception || {}).description);
  return r.result.value;
}

const getJson = (url, method) => new Promise((res, rej) => {
  const req = http.request(url, { method: method || 'GET' }, (r) => {
    let d = '';
    r.on('data', (c) => { d += c; });
    r.on('end', () => {
      if (r.statusCode >= 400) return rej(new Error(r.statusCode + ' on ' + url + ': ' + d.slice(0, 160)));
      try { res(JSON.parse(d)); } catch (e) { rej(new Error('not JSON from ' + url + ': ' + d.slice(0, 160))); }
    });
  });
  req.on('error', rej);
  req.end();
});

// Chrome and the app are spawned children; a thrown check would otherwise
// leave both running, and the next run would then drive the previous
// browser. Registered before anything is spawned.
let children = [];
function cleanup() {
  children.forEach((c) => { try { c.kill(); } catch (e) { /* gone */ } });
  children = [];
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-browser-'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-chrome-'));
  const tmpWav = wav(12, 440);

  // audio host, separate origin so we are exercising a real cross-request
  const audioSrv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': tmpWav.length });
    res.end(tmpWav);
  });
  await new Promise((r) => audioSrv.listen(AUDIO_PORT, r));
  const audioUrl = 'http://127.0.0.1:' + AUDIO_PORT + '/tone.wav';

  if (!CHROME) throw new Error('no Chrome found — set CHROME_PATH');
  const app = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), SB_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(app);
  let appOut = ''; app.stdout.on('data', (d) => { appOut += d; });
  let appErr = ''; app.stderr.on('data', (d) => { appErr += d; });
  for (let i = 0; i < 120 && !appOut.includes('running on'); i++) await sleep(100);
  if (!appOut.includes('running on')) throw new Error('server did not start: ' + appErr);

  const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio', 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(chrome);
  let version = null;
  for (let i = 0; i < 80 && !version; i++) {
    try { version = await getJson('http://127.0.0.1:' + CDP_PORT + '/json/version'); } catch (e) { await sleep(150); }
  }
  if (!version) throw new Error('chrome did not expose a debug port');

  const consoleErrors = [];
  async function openTab(name) {
    // Chrome removed GET /json/new; it is PUT now, and the URL goes in the
    // query string unencoded.
    const created = await getJson('http://127.0.0.1:' + CDP_PORT + '/json/new?' + BASE, 'PUT');
    const page = await CDP.open(created.webSocketDebuggerUrl);
    page.on((m) => {
      if (m.method === 'Runtime.exceptionThrown') {
        const ex = m.params.exceptionDetails.exception || {};
        consoleErrors.push(name + ': ' + (ex.description || m.params.exceptionDetails.text));
      }
      if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
        consoleErrors.push(name + ' [log]: ' + m.params.entry.text + ' @ ' + (m.params.entry.url || ''));
      }
    });
    await page.send('Runtime.enable');
    await page.send('Log.enable');
    await page.send('Page.enable');
    await page.send('Page.navigate', { url: BASE });
    // wait for the app's own markup rather than guessing at a timeout
    for (let i = 0; i < 60; i++) {
      if (await evalIn(page, "!!document.getElementById('auth')")) return page;
      await sleep(200);
    }
    throw new Error(name + ': the app never rendered');
  }

  console.log('--- boot: the page loads with no script errors ---');
  const A = await openTab('A');
  await sleep(1500);
  const bootErr = consoleErrors.filter((e) => !/net::|favicon|qrserver|fonts\.g|youtube|soundcloud|noembed/i.test(e));
  check('no script errors on load', bootErr.length === 0, bootErr.join(' | '));
  const bootState = await evalIn(A, `(() => ({
    auth: !document.getElementById('auth').classList.contains('hidden'),
    lobby: !document.getElementById('lobby').classList.contains('hidden'),
    room: !document.getElementById('room').classList.contains('hidden'),
    stored: Object.keys(localStorage),
    ready: document.readyState,
    href: location.href,
  }))()`);
  check('auth screen is showing', bootState.auth === true, JSON.stringify(bootState));

  console.log('--- guest name, then create a room ---');
  await evalIn(A, "document.getElementById('guestName').value = 'Sara'");
  await evalIn(A, "document.getElementById('authForm').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}))");
  await sleep(400);
  check('lobby appears after a name', await evalIn(A, "!document.getElementById('lobby').classList.contains('hidden')"));
  await evalIn(A, "document.getElementById('createBtn').click()");
  await sleep(600);
  const roomCode = await evalIn(A, "document.getElementById('roomCode').textContent");
  check('room was created', /^[A-Z0-9]{5}$/.test(roomCode), roomCode);
  // The creator must be the host — everything host-shaped in the UI hangs
  // off this, so assert it the moment it should be true.
  const creatorIsHost = await evalIn(A, `(() => ({
    badge: !!document.querySelector('#membersList .m-badge'),
    kick: document.querySelectorAll('#membersList .m-kick').length,
    sort: !document.getElementById('sortBtn').classList.contains('hidden'),
  }))()`);
  // alone in the room, so no kick buttons — but the host-only sort toggle is up
  check('the creator is the host', creatorIsHost.badge === true && creatorIsHost.sort === true,
    JSON.stringify(creatorIsHost));

  console.log('--- add a real track and see it actually play ---');
  await evalIn(A, "document.getElementById('trackUrl').value = " + JSON.stringify(audioUrl));
  await evalIn(A, "document.getElementById('loadBtn').click()");
  await sleep(2500);
  const aState = await evalIn(A, `(() => {
    const el = document.getElementById('audio');
    return { paused: el.paused, t: el.currentTime, dur: el.duration, src: el.src,
             title: document.getElementById('trackTitle').textContent };
  })()`);
  check('the <audio> element has the uploaded-style URL', aState.src.indexOf('/tone.wav') > -1, aState.src);
  check('duration is known', aState.dur > 5, aState.dur && aState.dur.toFixed(1));
  check('it is playing without another click', aState.paused === false && aState.t > 0.5, 't=' + (aState.t || 0).toFixed(2));

  console.log('--- a second browser tab joins and follows along ---');
  const B = await openTab('B');
  await sleep(1200);
  await evalIn(B, "document.getElementById('guestName').value = 'Nima'");
  await evalIn(B, "document.getElementById('authForm').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}))");
  await sleep(400);
  await evalIn(B, "document.getElementById('codeInput').value = " + JSON.stringify(roomCode));
  await evalIn(B, "document.getElementById('joinBtn').click()");
  await sleep(3000);
  const bState = await evalIn(B, `(() => {
    const el = document.getElementById('audio');
    return { paused: el.paused, t: el.currentTime, members: document.getElementById('userCount').textContent };
  })()`);
  check('second tab joined', bState.members === '2', 'members=' + bState.members);
  check('second tab is playing too', bState.paused === false && bState.t > 0.3, 't=' + (bState.t || 0).toFixed(2));
  const drift = Math.abs(aState.t - bState.t);
  check('the two tabs are within 1.5s of each other', drift < 1.5, drift.toFixed(2) + 's');

  console.log('--- pausing in one tab pauses the other ---');
  await evalIn(A, "document.getElementById('playPauseBtn').click()");
  await sleep(1500);
  const bAfterPause = await evalIn(B, "document.getElementById('audio').paused");
  const aAfterPause = await evalIn(A, "document.getElementById('audio').paused");
  check('the pausing tab paused', aAfterPause === true);
  check('the other tab paused too', bAfterPause === true, 'paused=' + bAfterPause);

  console.log('--- YouTube search without a key says so, instead of nothing ---');
  await evalIn(A, "document.getElementById('searchInput').value = 'hello'");
  await evalIn(A, "document.getElementById('searchBtn').click()");
  await sleep(1200);
  const hint = await evalIn(A, "document.getElementById('searchHint').textContent");
  check('search reports it is switched off', /YOUTUBE_API_KEY|خاموش/.test(hint), hint);

  console.log('--- an uploaded file plays through the client pipeline ---');
  // Chrome's DOM.setFileInputFiles does not take in this headless setup, so
  // the <input type=file> itself is not driven here. What this does cover is
  // the part a server-side test cannot: an /uploads/ path going through the
  // client and actually playing. The endpoint is covered in test/e2e.js.
  const upResult = await evalIn(A, `fetch('/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav',
                 'X-Filename': encodeURIComponent('upload-me.wav') },
      body: Uint8Array.from(atob(${JSON.stringify(Buffer.from(tmpWav).toString('base64'))}), c => c.charCodeAt(0)),
    }).then(r => r.json())`);
  check('the page uploaded a file to itself', upResult && upResult.ok === true, upResult && upResult.path);
  check('the server named it after the file', /\/uploads\/[a-f0-9]{32}\.wav$/.test(upResult.path || ''), upResult.path);
  check('and returned its title', upResult.title === 'upload-me', upResult.title);

  // Something is already playing, so a new track queues rather than loads —
  // which is the documented behaviour. Skip so it becomes the current one.
  await evalIn(A, "document.getElementById('trackUrl').value = " + JSON.stringify(upResult.path));
  await evalIn(A, "document.getElementById('loadBtn').click()");
  await sleep(600);
  const queuedCount = await evalIn(A, "document.getElementById('queueCount').textContent");
  check('the uploaded track went into the queue', queuedCount === '1', 'queue=' + queuedCount);
  await evalIn(A, "document.getElementById('nextBtn').click()");
  for (let i = 0; i < 40; i++) {
    const src = await evalIn(A, "document.getElementById('audio').src");
    if (/\/uploads\//.test(src)) break;
    await sleep(300);
  }
  await sleep(900);
  const upState = await evalIn(A, `(() => {
    const el = document.getElementById('audio');
    return { src: el.getAttribute('src'), paused: el.paused, t: el.currentTime,
             title: document.getElementById('trackTitle').textContent };
  })()`);
  check('the uploaded path became the current track',
    /\/uploads\/[a-f0-9]{32}\.wav$/.test(upState.src || ''), upState.src);
  check('the player shows a title for it', (upState.title || '').length > 0, upState.title);
  check('and it plays from our own origin', upState.paused === false && upState.t > 0.2, 't=' + (upState.t || 0).toFixed(2));
  const upFetch = await evalIn(A, "fetch(" + JSON.stringify(upResult.path) + ").then(r => r.status + ':' + r.headers.get('content-type'))");
  check('the served upload answers with an audio type', /^200:audio\//.test(upFetch), upFetch);

  console.log('--- a private room needs its password ---');
  const P = await openTab('P');
  await sleep(1200);
  await evalIn(P, "document.getElementById('guestName').value = 'Parisa'");
  await evalIn(P, "document.getElementById('authForm').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}))");
  await sleep(400);
  await evalIn(P, "document.getElementById('roomPass').value = 'secret'");
  await evalIn(P, "document.getElementById('createBtn').click()");
  await sleep(600);
  const privCode = await evalIn(P, "document.getElementById('roomCode').textContent");
  const lockShown = await evalIn(P, "!document.getElementById('privateBadge').classList.contains('hidden')");
  check('private room shows its lock', lockShown === true);

  await evalIn(B, "document.getElementById('leaveBtn').click()");
  await sleep(700);
  // Tabs of one browser share localStorage, so B has already picked up both
  // the password P typed and the host token P was issued — which is the
  // intended behaviour for one person on one machine. Clearing them stands
  // in for a stranger arriving on the invite link from somewhere else.
  await evalIn(B, "delete localStorage['sb-roompw']; delete localStorage['sb-hosts']; delete localStorage['sb-owners']");
  await evalIn(B, "document.getElementById('codeInput').value = " + JSON.stringify(privCode));
  await evalIn(B, "document.getElementById('joinBtn').click()");
  await sleep(1600);
  const refused = await evalIn(B, `(() => ({
    err: document.getElementById('lobbyError').textContent,
    inRoom: !document.getElementById('room').classList.contains('hidden'),
    codeInput: document.getElementById('codeInput').value,
    passField: document.getElementById('roomPass').value,
    storedPass: (JSON.parse(localStorage.getItem('sb-roompw') || '{}'))[document.getElementById('roomCode').textContent] || '(none)',
  }))()`);
  check('joining without the password is refused',
    /رمز/.test(refused.err) && refused.inRoom === false,
    JSON.stringify(refused) + ' code=' + await evalIn(B, "document.getElementById('roomCode').textContent") +
    ' lobbyHidden=' + await evalIn(B, "document.getElementById('lobby').classList.contains('hidden')"));
  await evalIn(B, "document.getElementById('roomPass').value = 'secret'");
  await evalIn(B, "document.getElementById('joinBtn').click()");
  await sleep(900);
  const entered = await evalIn(B, "!document.getElementById('room').classList.contains('hidden')");
  check('the right password gets in', entered === true);

  console.log('--- queue voting reaches the other tab ---');
  // A is still in the original room; B left it to try the private one
  await evalIn(B, "document.getElementById('leaveBtn').click()");
  await sleep(400);
  await evalIn(B, "document.getElementById('codeInput').value = " + JSON.stringify(roomCode));
  await evalIn(B, "document.getElementById('joinBtn').click()");
  await sleep(1500);
  // the queue is empty once its only track is playing — queue another so
  // there is something to vote on
  await evalIn(A, "document.getElementById('trackUrl').value = " + JSON.stringify(audioUrl));
  await evalIn(A, "document.getElementById('loadBtn').click()");
  await sleep(900);
  const voteOk = await evalIn(A, `(() => {
    const b = document.querySelector('#queueList .q-vote');
    if (!b) return 'no vote button';
    b.click();
    return 'clicked';
  })()`);
  await sleep(900);
  const voteCount = await evalIn(B, "(() => { const b = document.querySelector('#queueList .q-vote'); return b ? b.textContent : 'none'; })()");
  check('a vote reaches the other tab', /1/.test(voteCount), voteCount + ' (A said ' + voteOk + ')');

  console.log('--- the host can lock and unlock a room after the fact ---');
  // A and B are both in roomCode, and A is the host. Set a password from
  // inside the room — not at creation, which is the part that used to be
  // the only way in.
  const lockUi = await evalIn(A, `(() => ({
    row: !document.getElementById('pwRow').classList.contains('hidden'),
    btn: document.getElementById('pwSave').textContent,
  }))()`);
  check('the host sees the password control', lockUi.row === true,
    JSON.stringify(lockUi) + ' state=' + JSON.stringify(await evalIn(A, `(() => ({
      hasHostBadge: !!document.querySelector('#membersList .m-badge'),
      kickButtons: document.querySelectorAll('#membersList .m-kick').length,
      sortVisible: !document.getElementById('sortBtn').classList.contains('hidden'),
      members: document.getElementById('membersList').textContent.trim().slice(0, 60),
    }))()`)));

  const nonHostSeesIt = await evalIn(B, "!document.getElementById('pwRow').classList.contains('hidden')");
  check('a non-host does not', nonHostSeesIt === false);

  await evalIn(A, "document.getElementById('pwInput').value = 'newpass'");
  await evalIn(A, "document.getElementById('pwSave').click()");
  await sleep(1200);
  const lockedState = await evalIn(A, `(() => ({
    lock: !document.getElementById('privateBadge').classList.contains('hidden'),
    btn: document.getElementById('pwSave').textContent,
    status: document.getElementById('status').textContent,
  }))()`);
  check('locking shows the lock', lockedState.lock === true, JSON.stringify(lockedState));
  check('and the control relabels itself', /تغییر رمز/.test(lockedState.btn), lockedState.btn);
  const bLock = await evalIn(B, "!document.getElementById('privateBadge').classList.contains('hidden')");
  check('the other tab is told too', bLock === true);

  // B leaves; without the password it cannot come back in
  await evalIn(B, "document.getElementById('leaveBtn').click()");
  await sleep(500);
  await evalIn(B, "delete localStorage['sb-roompw']; delete localStorage['sb-hosts']");
  await evalIn(B, "document.getElementById('codeInput').value = " + JSON.stringify(roomCode));
  await evalIn(B, "document.getElementById('joinBtn').click()");
  await sleep(1400);
  const lockedOut2 = await evalIn(B, `(() => ({
    err: document.getElementById('lobbyError').textContent,
    inRoom: !document.getElementById('room').classList.contains('hidden'),
  }))()`);
  check('without the new password it stays out', /رمز/.test(lockedOut2.err) && lockedOut2.inRoom === false, JSON.stringify(lockedOut2));

  // A clears it, B gets back in
  await evalIn(A, "document.getElementById('pwInput').value = ''");
  await evalIn(A, "document.getElementById('pwSave').click()");
  await sleep(1200);
  const unlockedState = await evalIn(A, "document.getElementById('privateBadge').classList.contains('hidden')");
  check('clearing removes the lock', unlockedState === true);
  await evalIn(B, "document.getElementById('joinBtn').click()");
  await sleep(1200);
  const backIn = await evalIn(B, "!document.getElementById('room').classList.contains('hidden')");
  check('and the room opens again', backIn === true);

  const realErrors = consoleErrors.filter((e) => !/net::|favicon|qrserver|fonts\.g|youtube\.com|soundcloud|noembed/i.test(e));
  console.log('--- console ---');
  check('no unexpected console errors across all tabs', realErrors.length === 0, realErrors.slice(0, 4).join(' | ') || 'clean');

  A.close(); B.close(); P.close();
  cleanup();
  console.log(failures === 0 ? '\nALL BROWSER CHECKS PASS' : '\n' + failures + ' BROWSER CHECK(S) FAILED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('ERR', e); cleanup(); process.exit(1); });
