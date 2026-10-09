// SyncBeat e2e — spawns its own server (fresh temp data dir) and drives it
// with socket.io-client. Run: npm test
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');
const { io } = require('socket.io-client');
const SyncEcho = require('../public/echo.js');

// The suite reads the SQLite file directly to prove what reached disk. Node
// prints an ExperimentalWarning for node:sqlite on that require; keep the
// test output readable without hiding anything else.
(function silenceSqliteWarning() {
  const forwarded = process.listeners('warning').slice();
  process.removeAllListeners('warning');
  process.on('warning', (w) => {
    if (w && w.name === 'ExperimentalWarning' && /SQLite/i.test(w.message)) return;
    forwarded.forEach((fn) => { try { fn(w); } catch (e) { /* listener threw */ } });
  });
})();

const ROOT = path.join(__dirname, '..');
// Unique per run: a server left behind by an earlier run (Windows is slow to
// release these) would otherwise make this one fail to bind and look like a
// product bug.
const PORT = 3099 + (process.pid % 400);
const BASE = 'http://localhost:' + PORT;
// second server, used to exercise the TRUST_PROXY=1 rate-limit key and the
// room cap
const PORT2 = PORT + 1;
const BASE2 = 'http://localhost:' + PORT2;
const fail = (m) => { console.error('FAIL:', m); shutdown(1); };
const ok = (m) => console.log('ok:', m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const once = (s, ev) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('event timeout: ' + ev)), 10000);
  s.once(ev, (v) => { clearTimeout(t); res(v); });
});
const emitAck = (s, ev, ...args) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('ack timeout: ' + ev)), 10000);
  s.emit(ev, ...args, (r) => { clearTimeout(t); res(r); });
});

let server = null;
let dataDir = null;
let dataDir2 = null;
const extraDataDirs = [];
const openSockets = [];
const extraServers = [];
function client(auth, opts, base) {
  const s = io(base || BASE, { auth, reconnection: false, ...(opts || {}) });
  openSockets.push(s);
  return s;
}
// Read a room back out of the SQLite file. Used to prove that what we
// *think* we saved is actually on disk, which a socket-level check cannot.
function readRoomFrom(dbFile, code) {
  if (!fs.existsSync(dbFile)) return null;
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const row = db.prepare('SELECT * FROM rooms WHERE code = ?').get(code);
    return row ? { chat: String(row.chat || ''), queue: String(row.queue || '') } : null;
  } finally { db.close(); }
}
function shutdown(code) {
  openSockets.forEach((s) => { try { s.close(); } catch (e) {} });
  if (server) { try { server.kill(); } catch (e) {} }
  extraServers.forEach((s) => { try { s.kill(); } catch (e) {} });
  if (dataDir) { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {} }
  if (dataDir2) { try { fs.rmSync(dataDir2, { recursive: true, force: true }); } catch (e) {} }
  extraDataDirs.forEach((d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} });
  process.exit(code);
}

// A plain HTTP request that also hands back the body and headers — uploads
// need to verify what actually comes back off the disk.
function httpRequest(method, p, headers, body) {
  return new Promise((res, rej) => {
    const h = Object.assign({}, headers);
    if (body) h['Content-Length'] = Buffer.byteLength(body);
    const req = http.request(BASE + p, { method, headers: h }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => res({ status: r.statusCode, headers: r.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', rej);
    req.setTimeout(8000, () => req.destroy(new Error('http timeout: ' + p)));
    if (body) req.write(body);
    req.end();
  });
}
const rawGet = (p, headers) => httpRequest('GET', p, headers).then((r) => r.status);
const rawHandshake = (headers) =>
  rawGet('/socket.io/?EIO=4&transport=polling', headers);

// Spawn a server under test. env overrides PORT / HOST_GRACE_MS / SB_DATA_DIR.
function startServer(env, script) {
  const srv = spawn(process.execPath, [script || 'server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(PORT), HOST_GRACE_MS: '900',
      SB_DATA_DIR: dataDir, TRUST_PROXY: '0',
      // small on purpose so the oversize-upload check stays cheap
      MAX_UPLOAD_MB: '1', ...(env || {}),
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

  // ---- queue ownership, self-starting queue, stale echoes, slim heartbeat ----
  const O = client({ guestId: 'guestO0011', displayName: 'Omid' });
  await once(O, 'connect');
  const oc = await emitAck(O, 'create-room', {});
  if (!oc || !oc.ok) fail('ownership setup create: ' + JSON.stringify(oc));
  const ocode = oc.code;
  if (!oc.ownerSecret || !oc.ownerTag || oc.ownerTag === oc.ownerSecret) {
    fail('ownerSecret/ownerTag missing or identical: ' +
      JSON.stringify({ secret: !!oc.ownerSecret, tag: oc.ownerTag }));
  }

  const a1 = await emitAck(O, 'queue-add', { type: 'audio', url: 'https://x.test/alpha.mp3', title: 'Alpha' });
  if (!a1 || !a1.ok) fail('ownership queue-add: ' + JSON.stringify(a1));
  const s0 = await emitAck(O, 'sync-request');
  if (!s0.isPlaying) fail('first track must start playing by itself: ' + JSON.stringify(s0));
  await emitAck(O, 'queue-add', { type: 'audio', url: 'https://x.test/beta.mp3', title: 'Beta' });
  await emitAck(O, 'queue-add', { type: 'audio', url: 'https://x.test/gamma.mp3', title: 'Gamma' });

  const s1 = await emitAck(O, 'sync-request');
  const gamma = (s1.queue || []).find((t) => t.title === 'Gamma');
  if (!gamma || !gamma.addedBy || !gamma.addedBy.ownerId) {
    fail('queued track carries no ownerId: ' + JSON.stringify(gamma));
  } else if (gamma.addedBy.ownerId !== oc.ownerTag) {
    fail('ownerId is not the queueing member\'s tag');
  }
  if (JSON.stringify(s1).indexOf(oc.ownerSecret) !== -1) fail('raw ownerSecret leaked into room state');

  await emitAck(O, 'skip');
  const s2 = await emitAck(O, 'sync-request');
  if (!s2.track || s2.track.title !== 'Beta' || !s2.isPlaying) {
    fail('queue must keep playing across a skip: ' +
      JSON.stringify({ track: s2.track && s2.track.title, playing: s2.isPlaying }));
  }
  ok('queue self-starts and keeps playing across a skip');

  // A second member reusing the host's guestId used to inherit its rights.
  const P = client({ guestId: 'guestO0011', displayName: 'Pari' });
  await once(P, 'connect');
  const jp = await emitAck(P, 'join-room', ocode, {});
  if (!jp || !jp.ok) fail('same-guestId join: ' + JSON.stringify(jp));
  if (jp.ownerTag === oc.ownerTag) fail('ownerTag must be per member, not per guestId');
  const spoil = await emitAck(P, 'queue-remove', gamma.id);
  if (!spoil || spoil.ok !== false) fail('stolen guestId could still delete: ' + JSON.stringify(spoil));

  // ...and the real owner, who is NOT the host, still can.
  const Q = client({ guestId: 'guestQ0012', displayName: 'Qara' });
  await once(Q, 'connect');
  const jq = await emitAck(Q, 'join-room', ocode, {});
  if (!jq || !jq.ok || jq.isHost) fail('third member join: ' + JSON.stringify(jq));
  const qAdd = await emitAck(Q, 'queue-add', { type: 'audio', url: 'https://x.test/delta.mp3', title: 'Delta' });
  if (!qAdd || !qAdd.ok) fail('third member queue-add: ' + JSON.stringify(qAdd));
  const sq = await emitAck(Q, 'sync-request');
  const delta = (sq.queue || []).find((t) => t.title === 'Delta');
  if (!delta) fail('Delta missing from queue: ' + JSON.stringify(sq.queue));
  const otherDenied = await emitAck(P, 'queue-remove', delta.id);
  if (!otherDenied || otherDenied.ok !== false) fail('non-owner could delete: ' + JSON.stringify(otherDenied));
  const ownerOk = await emitAck(Q, 'queue-remove', delta.id);
  if (!ownerOk || !ownerOk.ok) fail('owner could not delete own track: ' + JSON.stringify(ownerOk));
  ok('queue ownership: hash proves it, guestId does not');
  O.emit('leave-room'); P.emit('leave-room'); Q.emit('leave-room');
  await sleep(300);

  // ---- control echoes carry a seq so a late one cannot resurrect state ----
  const O2 = client({ guestId: 'guestO0011', displayName: 'Omid' });
  await once(O2, 'connect');
  const oc2 = await emitAck(O2, 'create-room', {});
  if (!oc2 || !oc2.ok) fail('echo setup create: ' + JSON.stringify(oc2));
  await emitAck(O2, 'queue-add', { type: 'audio', url: 'https://x.test/one.mp3', title: 'One' });
  const e1 = await emitAck(O2, 'sync-request');
  if (!e1.isPlaying) fail('echo setup should be playing');
  O2.emit('pause', 4, (e1.seq || 0) - 9); // seq the room has already moved past
  await sleep(300);
  const e2 = await emitAck(O2, 'sync-request');
  if (!e2.isPlaying) fail('a stale control echo changed the room: ' + JSON.stringify(e2));
  O2.emit('pause', 4, e2.seq); // same seq = an echo of what we already applied
  await sleep(300);
  const e3 = await emitAck(O2, 'sync-request');
  if (e3.isPlaying !== false || e3.seq !== e2.seq) {
    fail('a matching-seq echo should apply silently: ' +
      JSON.stringify({ playing: e3.isPlaying, seq: [e2.seq, e3.seq] }));
  }
  ok('control echoes: stale seq dropped, current seq applied without rebroadcast');

  // ---- heartbeat payload ----
  const tick = await emitAck(O2, 'ping-state');
  const tickJson = JSON.stringify(tick || null);
  if (!tick || 'chat' in tick || 'queue' in tick || 'history' in tick || 'members' in tick) {
    fail('ping-state is not slim: ' + tickJson);
  } else if (tickJson.length * 3 > JSON.stringify(await emitAck(O2, 'sync-request')).length) {
    fail('ping-state is not meaningfully smaller: ' + tickJson.length);
  }
  ok('heartbeat returns only what the drift check needs');

  // ---- SoundCloud cannot honour a playback rate ----
  await emitAck(O2, 'set-speed', 1.5);
  await emitAck(O2, 'queue-add', { type: 'soundcloud', url: 'https://soundcloud.com/a/b', title: 'Cloudy' });
  await emitAck(O2, 'skip');
  const e4 = await emitAck(O2, 'sync-request');
  if (e4.speed !== 1) fail('a SoundCloud track must pin the room to 1x: ' + e4.speed);
  const scRefused = await emitAck(O2, 'set-speed', 1.5);
  if (!scRefused || scRefused.ok !== false || scRefused.error !== 'speed-unsupported') {
    fail('set-speed should be refused on SoundCloud: ' + JSON.stringify(scRefused));
  }
  ok('SoundCloud pins the room speed (the widget has no rate control)');
  O2.emit('leave-room');
  await sleep(200);

  // ---- uploading a file instead of pasting a link ----
  const audioBytes = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(512, 3)]);
  const up = await httpRequest('POST', '/api/upload',
    { 'Content-Type': 'audio/mpeg', 'X-Filename': encodeURIComponent('برنامه من.mp3') }, audioBytes);
  let upJson = null;
  try { upJson = JSON.parse(up.body.toString('utf8')); } catch (e) { /* not json */ }
  if (up.status !== 200 || !upJson || !upJson.ok) fail('upload rejected: ' + up.status + ' ' + up.body);
  else if (!/^\/uploads\/[a-f0-9]{32}\.mp3$/.test(upJson.path || '')) fail('upload path is not server-shaped: ' + upJson.path);
  else if (upJson.title !== 'برنامه من') fail('upload title wrong: ' + upJson.title);
  const fetched = await httpRequest('GET', upJson.path, {});
  if (fetched.status !== 200 || Buffer.compare(fetched.body, audioBytes) !== 0) {
    fail('uploaded file not served back: ' + fetched.status + ' ' + fetched.body.length);
  }
  if (!/^audio\//.test(fetched.headers['content-type'] || '')) {
    fail('upload served with wrong type: ' + fetched.headers['content-type']);
  }
  const ranged = await httpRequest('GET', upJson.path, { Range: 'bytes=0-9' });
  if (ranged.status !== 206 || ranged.body.length !== 10) {
    fail('upload does not support Range, so seeking would break: ' + ranged.status);
  }
  const unknown = await httpRequest('GET', '/uploads/' + 'a'.repeat(32) + '.mp3', {});
  if (unknown.status !== 404) fail('a missing upload should 404, got ' + unknown.status);

  const U = client({ guestId: 'guestU0013', displayName: 'Umid' });
  await once(U, 'connect');
  const uc = await emitAck(U, 'create-room', {});
  if (!uc || !uc.ok) fail('upload setup create: ' + JSON.stringify(uc));
  const queued = await emitAck(U, 'queue-add', { type: 'audio', url: upJson.path, title: upJson.title });
  if (!queued || !queued.ok) fail('queue-add refused an upload: ' + JSON.stringify(queued));
  const ghosted = await emitAck(U, 'queue-add', { type: 'audio', url: '/uploads/' + 'b'.repeat(32) + '.mp3', title: 'Ghost' });
  if (!ghosted || ghosted.ok !== false || ghosted.error !== 'bad-track') {
    fail('queue-add accepted an upload that does not exist: ' + JSON.stringify(ghosted));
  }
  const walked = await emitAck(U, 'queue-add', { type: 'audio', url: '/uploads/../../server.js', title: 'Walk' });
  if (!walked || walked.ok !== false) fail('queue-add accepted a traversal: ' + JSON.stringify(walked));
  ok('upload: served back, seekable, and only real files reach the queue');
  U.emit('leave-room');
  await sleep(200);

  const badType = await httpRequest('POST', '/api/upload',
    { 'Content-Type': 'text/plain', 'X-Filename': 'notes.txt' }, Buffer.from('hi'));
  if (badType.status !== 415) fail('a non-audio upload should be 415, got ' + badType.status);
  const foreign = await httpRequest('POST', '/api/upload',
    { 'Content-Type': 'audio/mpeg', 'X-Filename': 'x.mp3', Origin: 'http://evil.example' }, audioBytes);
  if (foreign.status !== 403) fail('a foreign origin should not be able to fill our disk, got ' + foreign.status);
  const tooBig = await httpRequest('POST', '/api/upload',
    { 'Content-Type': 'audio/mpeg', 'X-Filename': 'big.mp3' }, Buffer.alloc(1024 * 1024 + 512));
  if (tooBig.status !== 413) fail('an oversize upload should be 413, got ' + tooBig.status);
  ok('upload refuses non-audio, foreign origins and oversize bodies');

  let uploadLimited = false;
  for (let i = 0; i < 25 && !uploadLimited; i++) {
    const r = await httpRequest('POST', '/api/upload',
      { 'Content-Type': 'audio/mpeg', 'X-Filename': 'n' + i + '.mp3' }, Buffer.from('x'));
    if (r.status === 429) uploadLimited = true;
  }
  if (!uploadLimited) fail('upload rate limit never fired');
  ok('upload rate limit (20/hour/IP)');

  // ---- rate limit keyed per forwarded client when TRUST_PROXY=1 ----
  // its own data dir: two processes must never race on the same rooms.json
  dataDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-test-proxy-'));
  const proxySrv = startServer({
    PORT: String(PORT2), TRUST_PROXY: '1', SB_DATA_DIR: dataDir2, MAX_ROOMS: '2',
  });
  extraServers.push(proxySrv);
  await waitRunning(proxySrv, 'TRUST_PROXY server');
  await sleep(300); // let the listener settle before the first handshake
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

  // ---- ceiling on live rooms (same server, fresh data dir => 0 rooms) ----
  const cap1 = await emitAck(PB, 'create-room', {});
  const cap2 = await emitAck(PB, 'create-room', {});
  const cap3 = await emitAck(PB, 'create-room', {});
  const capCreated = [cap1, cap2, cap3].filter((r) => r && r.ok).length;
  const capFull = [cap1, cap2, cap3].find((r) => r && r.error === 'server-full');
  if (capCreated !== 2 || !capFull) {
    fail('MAX_ROOMS not enforced: ' + JSON.stringify([cap1, cap2, cap3]));
  }
  ok('room cap enforced (MAX_ROOMS)');

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
  const dbFile = path.join(dataDir, 'syncbeat.db');
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
  if (readRoomFrom(dbFile, sc.code)) fail('test precondition: room already flushed before shutdown');

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

  const after = readRoomFrom(dbFile, sc.code);
  if (!after) fail('shutdown did not flush the pending room');
  else if (after.chat.indexOf('flush-me-please') === -1) fail('shutdown did not flush the pending chat: ' + after.chat);
  ok('shutdown flushes pending room state to disk');

  // ---- a rooms.json left over from before SQLite is imported on first boot ----
  const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-legacy-'));
  extraDataDirs.push(legacyDir);
  fs.writeFileSync(path.join(legacyDir, 'rooms.json'), JSON.stringify({
    LEGACY: {
      hostId: 'u-legacy', hostToken: 'legacy-token-value-0123456789abcd', banned: ['badguest1'],
      djOnly: false, track: null, queue: [], history: [],
      chat: [{ id: 'm1', username: 'Old', text: 'hello-legacy', at: Date.now() }],
      isPlaying: false, position: 0, speed: 1,
      createdAt: Date.now(), updatedAt: Date.now(), lastActive: Date.now(),
    },
  }));
  const legacyPort = PORT + 2;
  const legacySrv = startServer({ PORT: String(legacyPort), SB_DATA_DIR: legacyDir }, 'test/raise-sig.js');
  extraServers.push(legacySrv);
  await waitRunning(legacySrv, 'legacy-import server');
  await sleep(300);
  const L = client({ guestId: 'guestL0014', displayName: 'Leila' }, {}, 'http://localhost:' + legacyPort);
  await once(L, 'connect');
  const jl = await emitAck(L, 'join-room', 'LEGACY', {});
  if (!jl || !jl.ok) fail('a room from rooms.json should still exist: ' + JSON.stringify(jl));
  else {
    const chat = (jl.state.chat || []).map((m) => m.text).join(' ');
    if (chat.indexOf('hello-legacy') === -1) fail('legacy chat did not survive the import: ' + chat);
    if ((jl.state.members || []).length !== 1) fail('legacy room should be empty on restore');
  }
  const Banned = client({ guestId: 'badguest1', displayName: 'Baddy' }, {}, 'http://localhost:' + legacyPort);
  await once(Banned, 'connect');
  const bj = await emitAck(Banned, 'join-room', 'LEGACY', {});
  if (!bj || bj.ok !== false || bj.error !== 'banned') {
    fail('the imported ban list did not survive: ' + JSON.stringify(bj));
  }
  L.emit('leave-room');
  await sleep(200);
  ok('a rooms.json from the previous version is imported on boot');
  legacySrv.kill();

  // ---- echo policy: is this media event the user's, or the player's? ----
  // Pure logic from public/echo.js — no server needed, but it decides whether
  // a button press reaches the room at all, so it is worth pinning down.
  {
    const e = SyncEcho.create();
    const r1 = e.resolve('play');
    if (!r1.send || r1.seq !== undefined) fail('an unmarked event must be a fresh command: ' + JSON.stringify(r1));

    e.expectEcho('play', 7);
    const r2 = e.resolve('play');
    if (!r2.send || r2.seq !== 7) fail('an echo must carry its seq: ' + JSON.stringify(r2));
    const r3 = e.resolve('play');
    if (!r3.send || r3.seq !== undefined) fail('an expectation is one-shot: ' + JSON.stringify(r3));

    e.expectDrop(['pause', 'seeked', 'ended']);
    if (e.resolve('pause').send !== false) fail('our own teardown must stay silent');
    if (e.resolve('seeked').send !== false) fail('our own seek must stay silent');
    if (e.resolve('play').send !== true) fail('a drop must not cover unrelated events');

    // a server command arriving over our own track swap still wins
    e.expectDrop(['pause']);
    e.expectEcho('pause', 42);
    const r4 = e.resolve('pause');
    if (!r4.send || r4.seq !== 42) fail('the newest instruction supersedes a drop: ' + JSON.stringify(r4));

    // swallow the expected teardown, then let the user's own press through
    const e2 = SyncEcho.create();
    e2.expectDrop(['pause']);
    if (e2.consumeDrop('ended') !== false) fail('a drop must be per event kind');
    if (e2.resolve('pause').send !== false) fail('first teardown event is dropped');
    if (e2.resolve('pause').send !== true) fail('the user\'s own press after that must go out');

    // expired expectations must not still be swallowing events — arm them on
    // the real clock first, then move the clock past both deadlines
    const realNow = Date.now;
    const e3 = SyncEcho.create();
    e3.expectEcho('play', 3);
    e3.expectDrop(['pause']);
    try {
      Date.now = () => realNow() + SyncEcho.ECHO_MS + 1000;
      const late = e3.resolve('play');
      if (!late.send || late.seq !== undefined) fail('expired echo should fall back to a fresh command: ' + JSON.stringify(late));
      if (e3.resolve('pause').send !== true) fail('expired drop should stop swallowing');
    } finally { Date.now = realNow; }

    e.clear();
    if (e.size().echoes !== 0 || e.size().drops !== 0) fail('clear() must empty both lists');
    ok('echo policy: user presses go out, our own events do not, seq survives');
  }

  console.log('ALL PASS');
  shutdown(0);
})().catch((e) => { console.error(e); shutdown(1); });
