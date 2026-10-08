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
const openSockets = [];
function client(auth) {
  const s = io(BASE, { auth, reconnection: false });
  openSockets.push(s);
  return s;
}
function shutdown(code) {
  openSockets.forEach((s) => { try { s.close(); } catch (e) {} });
  if (server) { try { server.kill(); } catch (e) {} }
  if (dataDir) { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {} }
  process.exit(code);
}

function rawGet(headers) {
  return new Promise((res, rej) => {
    const req = http.get(
      BASE + '/socket.io/?EIO=4&transport=polling',
      { headers },
      (r) => { r.resume(); res(r.statusCode); }
    );
    req.on('error', rej);
    req.setTimeout(4000, () => req.destroy(new Error('raw timeout')));
  });
}

(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-test-'));
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST_GRACE_MS: '900', SB_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let srvErr = '';
  server.stderr.on('data', (d) => { srvErr += d; });
  let srvOut = '';
  server.stdout.on('data', (d) => { srvOut += d; });
  for (let i = 0; i < 100 && !srvOut.includes('running on'); i++) await sleep(100);
  if (!srvOut.includes('running on')) fail('server did not start: ' + srvErr);

  // ---- origin gate (WS has no CORS; only our own origin may drive us) ----
  const evil = await rawGet({ Origin: 'http://evil.example' });
  if (evil !== 403) fail('evil origin should be 403, got ' + evil);
  const own = await rawGet({ Origin: BASE });
  if (own !== 200) fail('own origin should be 200, got ' + own);
  const none = await rawGet({});
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

  // ---- rate limit (LAST: shares the per-IP window with everything above) ----
  const R = client({ guestId: 'guestR0007', displayName: 'Rate' });
  await once(R, 'connect');
  let gotLimited = false;
  for (let i = 0; i < 40 && !gotLimited; i++) {
    const r = await emitAck(R, 'join-room', 'ZZZZZ', {});
    if (r && r.ok === false && r.error === 'rate-limited') gotLimited = true;
  }
  if (!gotLimited) fail('rate limiter never fired in 40 attempts');
  ok('rate limit fires on room-code brute force');

  console.log('ALL PASS');
  shutdown(0);
})().catch((e) => { console.error(e); shutdown(1); });
