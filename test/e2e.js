// SyncBeat e2e — spawns its own server (fresh temp data dir) and drives it
// with socket.io-client. Run: npm test
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');
const { io } = require('socket.io-client');

const ROOT = path.join(__dirname, '..');
const PORT = 3099;
const BASE = 'http://localhost:' + PORT;
// second server, used to exercise the TRUST_PROXY=1 rate-limit key
const PORT2 = 3098;
const BASE2 = 'http://localhost:' + PORT2;
const fail = (m) => { console.error('FAIL:', m); shutdown(1); };
const ok = (m) => console.log('ok:', m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const once = (s, ev) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('event timeout: ' + ev)), 5000);
  s.once(ev, (v) => { clearTimeout(t); res(v); });
});
const emitAck = (s, ev, ...args) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('ack timeout: ' + ev)), 5000);
  s.emit(ev, ...args, (r) => { clearTimeout(t); res(r); });
});

let server = null;
let dataDir = null;
let dataDir2 = null;
const openSockets = [];
const extraServers = [];
function client(auth, opts) {
  const s = io(BASE, { auth, reconnection: false, ...(opts || {}) });
  openSockets.push(s);
  return s;
}
function shutdown(code) {
  openSockets.forEach((s) => { try { s.close(); } catch (e) {} });
  if (server) { try { server.kill(); } catch (e) {} }
  extraServers.forEach((s) => { try { s.kill(); } catch (e) {} });
  if (dataDir) { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {} }
  if (dataDir2) { try { fs.rmSync(dataDir2, { recursive: true, force: true }); } catch (e) {} }
  process.exit(code);
}

function rawGet(pathAndQuery, headers) {
  return new Promise((res, rej) => {
    const req = http.get(
      BASE + pathAndQuery,
      { headers },
      (r) => { r.resume(); res(r.statusCode); }
    );
    req.on('error', rej);
    req.setTimeout(4000, () => req.destroy(new Error('raw timeout')));
  });
}
const rawHandshake = (headers) =>
  rawGet('/socket.io/?EIO=4&transport=polling', headers);

// Spawn a server under test. env overrides PORT / HOST_GRACE_MS / SB_DATA_DIR.
function startServer(env, script) {
  const srv = spawn(process.execPath, [script || 'server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(PORT), HOST_GRACE_MS: '900',
      SB_DATA_DIR: dataDir, TRUST_PROXY: '0', ...(env || {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.out = ''; srv.err = '';
  srv.stdout.on('data', (d) => { srv.out += d; });
  srv.stderr.on('data', (d) => { srv.err += d; });
  return srv;
}
async function waitRunning(srv, label) {
  for (let i = 0; i < 100 && !srv.out.includes('running on'); i++) await sleep(100);
  if (!srv.out.includes('running on')) fail((label || 'server') + ' did not start: ' + srv.err);
}

(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-test-'));
  server = startServer();
  await waitRunning(server, 'server');

  // ---- origin gate (WS has no CORS; only our own origin may drive us) ----
  const evil = await rawHandshake({ Origin: 'http://evil.example' });
  if (evil !== 403) fail('evil origin should be 403, got ' + evil);
  const own = await rawHandshake({ Origin: BASE });
  if (own !== 200) fail('own origin should be 200, got ' + own);
  const none = await rawHandshake({});
  if (none !== 200) fail('origin-less (non-browser) should be 200, got ' + none);
  ok('origin gate: evil=403 own=200 none=200');

  // ---- handshake ----
  const bad = client({ guestId: 'abc123', displayName: 'x' });
  const badErr = await once(bad, 'connect_error');
  if (!/name-required/.test(badErr.message)) fail('nameless should get name-required, got ' + badErr.message);
  ok('nameless rejected (name-required)');
  bad.close();

  // ---- create room: host capability is a secret token, identity is uid ----
  const A = client({ guestId: 'guestA0001', displayName: 'Ariyan' });
  await once(A, 'connect');
  const created = await emitAck(A, 'create-room', {});
  if (!created || !created.ok || !created.code) fail('create-room: ' + JSON.stringify(created));
  if (created.role !== 'member' || !created.isHost) fail('creator must be host+member');
  if (typeof created.hostToken !== 'string' || created.hostToken.length < 20) fail('hostToken missing/short');
  if (typeof created.uid !== 'string' || created.uid === 'guestA0001') fail('uid must be server-issued, not the guestId');
  const code = created.code;
  const hostToken = created.hostToken;
  ok('room created: ' + code + ' (secret hostToken + server uid)');

  // ---- takeover attempt: same guestId as host, no token => NOT host ----
  const Eve = client({ guestId: 'guestA0001', displayName: 'Eve' });
  await once(Eve, 'connect');
  const eveJoin = await emitAck(Eve, 'join-room', code, {});
  if (!eveJoin || !eveJoin.ok) fail('eve join: ' + JSON.stringify(eveJoin));
  if (eveJoin.isHost) fail('guestId spoof took over the host title!');
  const eveClear = await emitAck(Eve, 'queue-clear');
  if (!eveClear || eveClear.ok !== false || eveClear.error !== 'host-only') fail('spoofed host could clear: ' + JSON.stringify(eveClear));
  if (eveJoin.uid === 'guestA0001') fail('eve uid leaked the guestId');
  ok('host takeover with stolen guestId blocked');
  Eve.emit('leave-room');
  await sleep(200);

  // ---- listener flow ----
  const B = client({ guestId: 'guestB0002', displayName: 'Sara' });
  await once(B, 'connect');
  const joined = await emitAck(B, 'join-room', code, { asListener: true });
  if (!joined || !joined.ok || joined.role !== 'listener') fail('join as listener: ' + JSON.stringify(joined));
  ok('listener joined, members: ' + (joined.state.members.length));

  const denied = await emitAck(B, 'queue-add', { type: 'audio', url: 'https://x.test/a.mp3', title: 'nope' });
  if (!denied || denied.ok !== false) fail('listener queue-add should be denied');
  ok('listener queue-add denied');

  const t1 = await emitAck(A, 'queue-add', { type: 'audio', url: 'https://x.test/one.mp3', title: 'One' });
  if (!t1 || !t1.ok) fail('host queue-add t1: ' + JSON.stringify(t1));
  if (!t1.track.addedBy || t1.track.addedBy.guestId !== 'guestA0001') fail('addedBy.guestId missing');
  ok('host added track 1');

  const seen = [];
  B.on('queue-update', (qq) => seen.push(qq));
  const t2 = await emitAck(A, 'queue-add', { type: 'audio', url: 'https://x.test/two.mp3', title: 'Two' });
  if (!t2 || !t2.ok) fail('host queue-add t2');
  await sleep(800);
  const q = seen[seen.length - 1];
  if (!Array.isArray(q) || q.length !== 1 || q[0].title !== 'Two') fail('queue-update wrong: ' + JSON.stringify(seen));
  if (!q[0].addedBy || q[0].addedBy.username !== 'Ariyan') fail('addedBy missing name');
  ok('queue has 1 item with addedBy name');
  B.off('queue-update');

  const chatP = once(A, 'chat-message');
  const chatAck = await emitAck(B, 'chat-message', 'سلام!');
  if (!chatAck || !chatAck.ok) fail('chat ack');
  const msg = await chatP;
  if (msg.text !== 'سلام!' || msg.username !== 'Sara') fail('chat echo wrong: ' + JSON.stringify(msg));
  ok('chat works with names');

  const reactP = once(B, 'reaction');
  A.emit('reaction', '🔥');
  const react = await reactP;
  if (!react || react.emoji !== '🔥' || react.username !== 'Ariyan') fail('reaction wrong');
  ok('reaction works');

  const nextP = once(B, 'load-track');
  const skipAck = await emitAck(A, 'skip');
  if (!skipAck || !skipAck.ok) fail('skip ack');
  const nt = await nextP;
  if (!nt || nt.title !== 'Two') fail('skip did not advance: ' + JSON.stringify(nt));
  ok('skip advances queue');

  B.emit('play', 10);
  await sleep(300);
  ok('listener play ignored without crash');

  // clear the 2s track-ended window opened by the skip above
  await sleep(2200);

  // ---- robustness ----
  const nullAck = await emitAck(A, 'queue-add', null);
  if (!nullAck || nullAck.ok !== false || nullAck.error !== 'bad-track') fail('null queue-add: ' + JSON.stringify(nullAck));
  const alive = await emitAck(A, 'sync-request');
  if (!alive || !alive.track) fail('server unresponsive/wrong after null payload');
  ok('null queue-add rejected without crash');

  const speedP = once(B, 'speed-change');
  const speedAck = await emitAck(A, 'set-speed', 1.5);
  if (!speedAck || !speedAck.ok) fail('set-speed ack: ' + JSON.stringify(speedAck));
  const sv = await speedP;
  if (sv !== 1.5) fail('speed-change broadcast: ' + sv);
  const badSpeed = await emitAck(A, 'set-speed', 3);
  if (!badSpeed || badSpeed.ok !== false || badSpeed.error !== 'bad-speed') fail('bad speed accepted: ' + JSON.stringify(badSpeed));
  const deniedSpeed = await emitAck(B, 'set-speed', 2);
  if (!deniedSpeed || deniedSpeed.ok !== false) fail('listener set-speed should be denied');
  const stSpeed = await emitAck(B, 'sync-request');
  if (stSpeed.speed !== 1.5) fail('state speed wrong: ' + stSpeed.speed);
  ok('speed sync + whitelist + permission');

  const flagsP = once(B, 'room-flags');
  const djAck = await emitAck(A, 'set-dj-only', true);
  if (!djAck || !djAck.ok) fail('set-dj-only ack: ' + JSON.stringify(djAck));
  const f = await flagsP;
  if (!f || !f.djOnly) fail('room-flags wrong: ' + JSON.stringify(f));
  const deniedDj = await emitAck(B, 'set-dj-only', false);
  if (!deniedDj || deniedDj.ok !== false || deniedDj.error !== 'host-only') fail('listener set-dj-only: ' + JSON.stringify(deniedDj));
  ok('dj-only flag + permission');

  const selfKick = await emitAck(A, 'kick', created.uid);
  if (!selfKick || selfKick.ok !== false || selfKick.error !== 'self') fail('self kick: ' + JSON.stringify(selfKick));
  ok('self-kick rejected');

  // ---- track-ended dedup with two controllers ----
  const C = client({ guestId: 'guestC0003', displayName: 'Kian' });
  await once(C, 'connect');
  const jc = await emitAck(C, 'join-room', code, {});
  if (!jc || !jc.ok || jc.role !== 'member' || jc.isHost) fail('member join: ' + JSON.stringify(jc));
  ok('member C joined (not host)');
  await sleep(300);

  for (const title of ['Three', 'Four', 'Five']) {
    const r = await emitAck(A, 'queue-add', { type: 'audio', url: 'https://x.test/' + title.toLowerCase() + '.mp3', title });
    if (!r || !r.ok) fail('queue-add ' + title + ': ' + JSON.stringify(r));
  }

  const loads = [];
  B.on('load-track', (t) => loads.push(t));
  A.emit('track-ended');
  C.emit('track-ended');
  await sleep(700);
  B.off('load-track');
  if (loads.length !== 1) fail('track-ended dedup: expected exactly 1 load, got ' + loads.length);
  if (!loads[0] || loads[0].title !== 'Three') fail('track-ended wrong track: ' + JSON.stringify(loads[0]));
  const st2 = await emitAck(A, 'sync-request');
  const qt = (st2.queue || []).map((x) => x.title);
  if (qt.length !== 2 || qt[0] !== 'Four' || qt[1] !== 'Five') fail('queue after dedup: ' + JSON.stringify(qt));
  ok('track-ended dedup: one advance, queue kept');

  // ---- host grace: a refresh must NOT lose the host title ----
  A.emit('leave-room');
  await sleep(250);
  const midState = await emitAck(B, 'sync-request'); // members via state
  if ((midState.members || []).some((m) => m.isHost)) fail('crown should be empty during grace');
  const rejoinSame = await emitAck(A, 'join-room', code, { hostToken });
  if (!rejoinSame || !rejoinSame.ok || !rejoinSame.isHost) fail('refresh within grace must keep host: ' + JSON.stringify(rejoinSame));
  await sleep(300); // let B drain the members broadcast from the rejoin first
  ok('host refresh within grace keeps hostship');

  // ---- grace expiry: transfer to next member, new secret token ----
  // NOTE: both 'members' listeners must NOT be registered up front — they
  // would all fire on the first (grace) emission. Register the transfer
  // listener only after the grace event is consumed.
  const graceP = once(B, 'members');
  A.emit('leave-room');
  const graceMembers = await graceP;
  if (!Array.isArray(graceMembers) || graceMembers.some((m) => m.isHost)) fail('crown must be empty right after host leave');
  const transferP = once(B, 'members');
  const tokP = once(C, 'host-token');
  const newTok = await tokP;
  if (!newTok || newTok.code !== code || typeof newTok.token !== 'string' || newTok.token === hostToken) fail('host-token event wrong: ' + JSON.stringify(newTok));
  const afterMembers = await transferP;
  const cEntry = afterMembers.find((m) => m.userId === jc.uid);
  if (!cEntry || !cEntry.isHost) fail('C should hold the host title after grace: ' + JSON.stringify(afterMembers));
  const rejoinOld = await emitAck(A, 'join-room', code, { hostToken });
  if (!rejoinOld || !rejoinOld.ok || rejoinOld.isHost) fail('old token must die after transfer: ' + JSON.stringify(rejoinOld));
  A.emit('leave-room');
  await sleep(200);
  ok('grace transfer: new token to C, old token dead, no auto-host for outsiders');

  // ---- kick -> best-effort ban ----
  const kickedP = once(B, 'kicked');
  const kickAck = await emitAck(C, 'kick', joined.uid);
  if (!kickAck || !kickAck.ok) fail('kick listener: ' + JSON.stringify(kickAck));
  const kickedEv = await kickedP;
  if (!kickedEv || kickedEv.code !== code) fail('kicked event: ' + JSON.stringify(kickedEv));
  const rebanned = await emitAck(B, 'join-room', code, {});
  if (!rebanned || rebanned.ok !== false || rebanned.error !== 'banned') fail('banned listener rejoined: ' + JSON.stringify(rebanned));
  ok('kick + ban blocks rejoin');

  // ---- new host can control ----
  const cSkip = await emitAck(C, 'skip');
  if (!cSkip || !cSkip.ok) fail('new host skip: ' + JSON.stringify(cSkip));
  const cState = await emitAck(C, 'sync-request');
  if (!cState.track || cState.track.title !== 'Four') fail('new host skip did not advance: ' + JSON.stringify(cState.track));
  ok('new host controls');

  // ---- djOnly must gate 'track-ended', not just 'skip' ----
  // A track ending moves the queue forward, so letting any member report it
  // lets a non-host fast-forward a room that is supposed to be host-only.
  const N = client({ guestId: 'guestN0004', displayName: 'Noor' });
  await once(N, 'connect');
  const jn = await emitAck(N, 'join-room', code, {});
  if (!jn || !jn.ok || jn.isHost) fail('djOnly helper join: ' + JSON.stringify(jn));
  const addN = await emitAck(C, 'queue-add', { type: 'audio', url: 'https://x.test/six.mp3', title: 'Six' });
  if (!addN || !addN.ok) fail('host queue-add for djOnly test: ' + JSON.stringify(addN));
  await sleep(2200); // clear any track-ended window left by the skip above
  N.emit('track-ended');
  await sleep(600);
  const stDj = await emitAck(N, 'sync-request');
  if (!stDj.track || stDj.track.title !== 'Four') {
    fail('non-host advanced the queue in djOnly: ' + JSON.stringify(stDj.track));
  }
  C.emit('track-ended');
  await sleep(600);
  const stHost = await emitAck(N, 'sync-request');
  if (!stHost.track || stHost.track.title !== 'Five') {
    fail('host could not advance a track that ended: ' + JSON.stringify(stHost.track));
  }
  ok('djOnly gates track-ended: member denied, host allowed');
  N.emit('leave-room');
  await sleep(200);

  // ---- a room must never be left permanently hostless ----
  // If the grace timer fires while the room is empty there is nobody to
  // promote, and nothing would otherwise ever start the clock again.
  const H = client({ guestId: 'guestH0005', displayName: 'Hoda' });
  await once(H, 'connect');
  const hc = await emitAck(H, 'create-room', {});
  if (!hc || !hc.ok) fail('hostless setup create: ' + JSON.stringify(hc));
  const hcode = hc.code;
  H.emit('leave-room');
  await sleep(1400); // > HOST_GRACE_MS, room now empty and crownless
  const J = client({ guestId: 'guestJ0006', displayName: 'Jadi' });
  await once(J, 'connect');
  const jj = await emitAck(J, 'join-room', hcode, {});
  if (!jj || !jj.ok) fail('hostless join: ' + JSON.stringify(jj));
  if (jj.isHost) fail('a fresh joiner must not take the crown instantly');
  await sleep(1400); // grace restarts on join
  const js = await emitAck(J, 'sync-request');
  if (!(js.members || []).some((m) => m.isHost)) {
    fail('room stuck permanently hostless: ' + JSON.stringify(js.members));
  }
  const jc2 = await emitAck(J, 'queue-clear');
  if (!jc2 || !jc2.ok) fail('recovered host cannot control: ' + JSON.stringify(jc2));
  ok('hostless room recovers a host on the next join');
  J.emit('leave-room');
  await sleep(200);

  // ---- the old GET /api/room/:code answered without any rate limit ----
  const oracle = await rawGet('/api/room/' + hcode, {});
  if (oracle !== 404) fail('GET /api/room/:code should be gone, got ' + oracle);
  ok('unused /api/room/:code removed (no room-code oracle)');

  // ---- rate limit keyed per forwarded client when TRUST_PROXY=1 ----
  // its own data dir: two processes must never race on the same rooms.json
  dataDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-test-proxy-'));
  const proxySrv = startServer({ PORT: String(PORT2), TRUST_PROXY: '1', SB_DATA_DIR: dataDir2 });
  extraServers.push(proxySrv);
  await waitRunning(proxySrv, 'TRUST_PROXY server');
  const pbase = 'http://localhost:' + PORT2;
  // Both sockets carry the SAME forged leftmost value; only the rightmost
  // (added by our edge) differs. If the server keyed on the leftmost entry
  // both would share a bucket and the second connection would be refused.
  const hdrA = { 'x-forwarded-for': 'forged.example, 10.0.0.7' };
  const hdrB = { 'x-forwarded-for': 'forged.example, 10.0.0.8' };
  const PA = io(pbase, { auth: { guestId: 'guestP0007', displayName: 'ProxyA' }, reconnection: false, extraHeaders: hdrA });
  const PB = io(pbase, { auth: { guestId: 'guestQ0008', displayName: 'ProxyB' }, reconnection: false, extraHeaders: hdrB });
  openSockets.push(PA, PB);
  await once(PA, 'connect');
  await once(PB, 'connect');
  let paLimited = false;
  for (let i = 0; i < 40 && !paLimited; i++) {
    const r = await emitAck(PA, 'join-room', 'ZZZZZ', {});
    if (r && r.ok === false && r.error === 'rate-limited') paLimited = true;
  }
  if (!paLimited) fail('TRUST_PROXY=1 did not rate limit on the forwarded client key');
  const pbProbe = await emitAck(PB, 'join-room', 'ZZZZZ', {});
  if (pbProbe && pbProbe.error === 'rate-limited') {
    fail('buckets are not isolated per forwarded client (leftmost entry was trusted?)');
  }
  ok('TRUST_PROXY=1 keys on the rightmost forwarded client, per-IP buckets isolated');

  // ---- rate limit (shares the per-IP window with everything above) ----
  const R = client({ guestId: 'guestR0007', displayName: 'Rate' });
  await once(R, 'connect');
  let gotLimited = false;
  for (let i = 0; i < 40 && !gotLimited; i++) {
    const r = await emitAck(R, 'join-room', 'ZZZZZ', {});
    if (r && r.ok === false && r.error === 'rate-limited') gotLimited = true;
  }
  if (!gotLimited) fail('rate limiter never fired in 40 attempts');
  ok('rate limit fires on room-code brute force');

  // ---- TRUST_PROXY stays opt-in: a forged header must not mint a new bucket ----
  // The bucket for this IP is exhausted right above. If X-Forwarded-For were
  // honoured by default, this connection would draw a fresh one and sail
  // straight through — it has to be refused instead.
  const spoof = client(
    { guestId: 'guestS0009', displayName: 'Spoof' },
    { extraHeaders: { 'x-forwarded-for': '203.0.113.9' } }
  );
  await once(spoof, 'connect');
  const sp = await emitAck(spoof, 'join-room', 'ZZZZZ', {});
  if (!sp || sp.error !== 'rate-limited') {
    fail('TRUST_PROXY must be opt-in; forged X-Forwarded-For bypassed the limiter: ' + JSON.stringify(sp));
  }
  spoof.close();
  ok('forged X-Forwarded-For ignored while TRUST_PROXY is off');

  // ---- shutdown flushes the debounced save ----
  // scheduleSave() waits 1.5s, so a host killing us inside that window used
  // to drop the last write on the floor. SIGTERM now flushes synchronously
  // before anything is torn down.
  await sleep(1600); // let any save queued by earlier tests land first
  const roomsFile = path.join(dataDir, 'rooms.json');
  const flagFile = path.join(dataDir, 'raise.sig');
  // Swap in a server we can ask to shut down deterministically. POSIX gets
  // the real signal; Windows cannot deliver one to a child process at all,
  // so test/raise-sig.js raises it internally — same handlers either way.
  if (server) {
    const old = server;
    const gone = new Promise((res) => old.once('exit', res));
    old.kill();
    await gone;
  }
  await sleep(300); // let the port go
  server = startServer({ SB_SIG_FLAG: flagFile }, 'test/raise-sig.js');
  await waitRunning(server, 'server for shutdown test');

  const S = client({ guestId: 'guestT0010', displayName: 'Tara' });
  await once(S, 'connect');
  const sc = await emitAck(S, 'create-room', {});
  if (!sc || !sc.ok) fail('flush setup create: ' + JSON.stringify(sc));
  const flushChat = await emitAck(S, 'chat-message', 'flush-me-please');
  if (!flushChat || !flushChat.ok) fail('flush setup chat: ' + JSON.stringify(flushChat));
  S.close();
  await sleep(200); // still well inside the 1.5s debounce window
  const before = fs.existsSync(roomsFile) ? fs.readFileSync(roomsFile, 'utf8') : '';
  if (before.indexOf(sc.code) !== -1) fail('test precondition: room already flushed before shutdown');

  // Watch for exit BEFORE triggering, and bound the wait: a server that
  // never handles the signal would otherwise hang the suite forever
  // instead of reporting a failure.
  const exited = new Promise((res) => {
    if (server.exitCode !== null) return res();
    const t = setTimeout(() => res('timeout'), 8000);
    server.once('exit', () => { clearTimeout(t); res('exit'); });
  });
  if (process.platform === 'win32') fs.writeFileSync(flagFile, '1');
  else server.kill('SIGTERM');
  if ((await exited) === 'timeout') {
    fail('server did not exit on shutdown — the flush handlers are missing');
  }

  const after = fs.existsSync(roomsFile) ? fs.readFileSync(roomsFile, 'utf8') : '';
  const restored = after ? JSON.parse(after) : {};
  if (!restored[sc.code]) fail('shutdown did not flush the pending room');
  if (after.indexOf('flush-me-please') === -1) fail('shutdown did not flush the pending chat');
  ok('shutdown flushes pending room state to disk');

  console.log('ALL PASS');
  shutdown(0);
})().catch((e) => { console.error(e); shutdown(1); });
