// server.js — SyncBeat v2
// Express serves the static frontend; Socket.IO handles rooms.
// Guest identity: every visitor picks a display name (no password).
// Features: queue + history, chat, reactions, member/listener roles,
// host (DJ) admin, file persistence with TTL sweeps.

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Input checking and the small secrets derived from it live apart — see
// lib/validate.js. Everything here is pure, so keeping it in one place makes
// it the part of the server you can reason about without the rest loaded.
const V = require('./lib/validate');
const {
  avatarColor, validDisplayName, validGuestId, rid,
  safePos, cleanTitle, cleanChat, UPLOAD_PATH_RE, makeTrackItem,
  ownerTag, newOwnerSecret, adoptOwnerSecret,
  cleanPassword, makePassword, passwordMatches, uploadExtOf,
} = V;

const app = express();
const server = http.createServer(app);

// ---------------------------------------------------------- security
// Only browser origins that match our own host may connect (WS has no
// CORS, so without this any website can drive the server). Non-browser
// clients (tests, curl) send no Origin and are allowed.
const EXTRA_ORIGINS = (process.env.EXTRA_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const o = new URL(origin);
    return o.host === req.headers.host || EXTRA_ORIGINS.includes(o.host);
  } catch (e) { return false; }
}
const io = new Server(server, {
  allowRequest: (req, cb) => cb(null, originAllowed(req)),
});

// brute-force guard for create/join (room codes are guessable): 30
// attempts / minute / IP.
//
// Behind a reverse proxy (Render/Railway/nginx) req.socket.remoteAddress is
// the proxy's own address, so keying on it would give EVERY visitor one
// shared bucket — 30 attempts/minute for the whole site. Opt in with
// TRUST_PROXY=1 and we read the client out of the forwarded headers instead.
// It stays opt-in on purpose: with no proxy in front, a client can forge
// X-Forwarded-For and mint itself a fresh bucket per request.
const TRUST_PROXY = /^(1|true|yes|on)$/i.test(process.env.TRUST_PROXY || '');
function firstHeader(v) {
  if (Array.isArray(v)) v = v[0];
  if (typeof v !== 'string') return '';
  // X-Real-IP is a single value; if a proxy ever comma-joins it, the first
  // entry is the client that proxy saw.
  return v.split(',')[0].trim();
}
function lastHeader(v) {
  if (Array.isArray(v)) v = v[0];
  if (typeof v !== 'string') return '';
  const parts = v.split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}
function rateKeyOf(handshake) {
  const h = (handshake && handshake.headers) || {};
  if (TRUST_PROXY) {
    // A proxy APPENDS the peer it accepted the connection from, so the
    // rightmost entry is the one added by our own edge and a value forged
    // by the client sits further left, ignored. This is the same "trust one
    // hop" rule Express uses for `trust proxy: 1`; set it only when exactly
    // one proxy stands between the internet and this process.
    const k = lastHeader(h['x-forwarded-for']) || firstHeader(h['x-real-ip']);
    if (k) return k;
  }
  return handshake && handshake.address;
}
const rateHits = new Map();
function rateOk(key, limit, windowMs) {
  const now = Date.now();
  let e = rateHits.get(key);
  if (!e || now - e.start > windowMs) { e = { start: now, count: 0 }; rateHits.set(key, e); }
  e.count++;
  return e.count <= limit;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, e] of rateHits) if (now - e.start > 120000) rateHits.delete(k);
}, 60000).unref();

// The host may vanish for a moment (refresh/reconnect); hold the transfer
// this long so an honest rejoin with the token keeps the host title.
const HOST_GRACE_MS = parseInt(process.env.HOST_GRACE_MS || '30000', 10);

// Ceiling on live rooms (overridable) so a code-guessing flood cannot grow
// the in-memory map without bound between sweeps.
const MAX_ROOMS = parseInt(process.env.MAX_ROOMS || '2000', 10);

app.use(express.static(path.join(__dirname, 'public')));

// whitelists used by the restore IIFE below as well as the handlers
const VALID_SPEEDS = [0.75, 1, 1.25, 1.5, 2];

// ---------------------------------------------------------- playback clock
// Position is extrapolated from (now - updatedAt). Using Date.now() there
// means time the machine spent asleep counts as playback: a laptop closed
// mid-track jumps the playhead by the whole sleep on wake, and every client
// then seeks past the end and cascades through the queue. hrtime does not
// advance while the machine is suspended, which matches what the players do.
// updatedAt (wall clock) is still kept for persistence and readability.
const monoNow = () => process.hrtime.bigint();
function stamp(room) {
  room.updatedAt = Date.now();
  room.updatedAtMono = monoNow();
}

// ---------------------------------------------------------- command sequence
// Every playback change bumps room.seq and the new value rides along with the
// broadcast. A client that merely APPLIES a command echoes the seq it was
// given; if the room has already moved on, that echo is stale and is dropped.
// Without this a buffering client's late 'play' can undo a pause the host
// issued in the meantime and resume everyone behind their back.
function bumpSeq(room) {
  room.seq = (room.seq || 0) + 1;
  return room.seq;
}
function echoKind(room, seq) {
  if (typeof seq !== 'number' || !isFinite(seq)) return 'fresh';
  return seq === (room.seq || 0) ? 'echo' : 'stale';
}

// ---------------------------------------------------------- queue ownership
// addedBy.ownerTag is a HASH of a per-member secret: it rides along with the
// queue so everyone can see who added what, but only the holder of the secret
// can delete the item. guestId cannot do this job — the client picks it, so
// claiming someone else's is trivial (reproduced before this was added).

// ---------------------------------------------------------- room password
// Optional: a room with no password behaves exactly as before. Only the hash
// and its per-room salt are stored and only a boolean is ever broadcast, so
// the password itself never leaves the creator's browser.

// ---------------------------------------------------------- persistence
const DATA_DIR = process.env.SB_DATA_DIR || path.join(__dirname, 'data');
const store = require('./lib/store').open(DATA_DIR);

// Rooms are written one at a time and only when they change. Every keystroke
// used to serialize and rewrite *every* room on the server into rooms.json.
const dirty = new Set();
let saveTimer = null;
function markDirty(code) {
  if (!code) return;
  dirty.add(code);
  if (saveTimer) return;
  saveTimer = setTimeout(flushDirty, 1500);
  // Never the reason the process stays alive — the listening server is, and
  // shutdown() flushes anything still pending on the way out.
  saveTimer.unref && saveTimer.unref();
}
function flushDirty() {
  saveTimer = null;
  const codes = Array.from(dirty);
  dirty.clear();
  for (const code of codes) {
    try {
      const r = rooms[code];
      if (r) store.putRoom(code, r); else store.deleteRoom(code);
    } catch (e) {
      console.error('persist failed for ' + code + ':', e.message);
    }
  }
}
// Synchronous, so it is safe on the way out of the process.
function persistNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  flushDirty();
}

// ---------------------------------------------------------- guest identity
// No passwords: the client sends { guestId, displayName }; the server
// validates the shape and derives the avatar color from the name.

// NOTE: there used to be a GET /api/room/:code here reporting whether a code
// existed (and how many people were inside). Nothing ever called it, and it
// answered an unbounded number of requests — a free oracle for enumerating
// room codes that bypassed the rate limiter below entirely. Removed.

// ---------------------------------------------------------- uploads
// Links keep working exactly as before, but finding a host that permits
// hotlinking is a chore — so a file can be sent straight to the server and
// played back from there. Everything else (seeking, sync, persistence) is
// unchanged because an upload is just another audio URL.
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch (e) { /* exists */ }
// The shape check lives in lib/validate.js; only the "is it actually on our
// disk" half needs the filesystem, so it is injected here.
const validTrackInput = (input) =>
  V.validTrackInput(input, (name) => fs.existsSync(path.join(UPLOAD_DIR, name)));
const MAX_UPLOAD_BYTES = parseInt(process.env.MAX_UPLOAD_MB || '30', 10) * 1024 * 1024;
const MAX_UPLOAD_TOTAL = parseInt(process.env.MAX_UPLOAD_TOTAL_MB || '512', 10) * 1024 * 1024;
const UPLOAD_TTL_MS = 24 * 3600 * 1000;
// An upload is addressed as /uploads/<32 hex>.<ext>. Nothing else is ever
// accepted, so the path cannot be walked out of the uploads directory.

// Range requests come free with express.static, so seeking works unchanged.
app.use('/uploads', express.static(UPLOAD_DIR, { index: false, maxAge: '1h' }));

// ---------------------------------------------------------- YouTube search
// Paste-a-link is the hard part of using this app: finding a URL that
// actually plays is harder than finding the song. Search needs a key —
// there is no supported no-key way to search YouTube — so the feature sits
// behind YOUTUBE_API_KEY and says so rather than pretending.
//
// The search happens here, not in the browser: the key must not reach the
// client, and it sidesteps CORS. Quota is ~100 units per query against a
// free daily budget of 10,000.
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';
// Overridable so the mapping can be tested against a stub instead of needing
// a live key and burning quota.
const YOUTUBE_API_BASE = process.env.YOUTUBE_API_BASE || 'https://www.googleapis.com';
app.get('/api/search', async (req, res) => {
  if (!originAllowed(req)) return res.status(403).json({ ok: false, error: 'origin' });
  if (!YOUTUBE_API_KEY) return res.json({ ok: false, error: 'no-key' });
  const q = String(req.query.q || '').trim().slice(0, 100);
  if (!q) return res.json({ ok: true, results: [] });
  const key = rateKeyOf({ headers: req.headers, address: req.socket.remoteAddress });
  if (!rateOk('search:' + key, 30, 60000)) {
    return res.status(429).json({ ok: false, error: 'rate-limited' });
  }
  const url = YOUTUBE_API_BASE + '/youtube/v3/search' +
    '?part=snippet&type=video&videoCategoryId=10&maxResults=8' +
    '&key=' + encodeURIComponent(YOUTUBE_API_KEY) +
    '&q=' + encodeURIComponent(q);
  let j;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return res.status(502).json({ ok: false, error: 'upstream' });
    j = await r.json();
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'upstream' });
  }
  const results = (Array.isArray(j.items) ? j.items : [])
    .filter((i) => i && i.id && i.id.videoId && i.snippet)
    .map((i) => ({
      id: i.id.videoId,
      title: String(i.snippet.title || '').slice(0, 140),
      channel: String(i.snippet.channelTitle || '').slice(0, 60),
      thumb: i.snippet.thumbnails && i.snippet.thumbnails.default
        ? i.snippet.thumbnails.default.url : null,
    }));
  res.json({ ok: true, results });
});

app.post('/api/upload',
  // Checks that must run before the body is buffered.
  (req, res, next) => {
    // The same gate as the socket. WebSocket had no CORS to lean on and
    // neither does a plain POST that a foreign page can fire blind.
    if (!originAllowed(req)) return res.status(403).json({ ok: false, error: 'origin' });
    const key = rateKeyOf({ headers: req.headers, address: req.socket.remoteAddress });
    if (!rateOk('upload:' + key, 20, 3600000)) {
      return res.status(429).json({ ok: false, error: 'rate-limited' });
    }
    const len = parseInt(req.headers['content-length'] || '', 10);
    if (!len) return res.status(411).json({ ok: false, error: 'empty' });
    if (len > MAX_UPLOAD_BYTES) return res.status(413).json({ ok: false, error: 'too-large' });
    next();
  },
  express.raw({ type: '*/*', limit: MAX_UPLOAD_BYTES }),
  (req, res) => {
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ ok: false, error: 'empty' });
    const ext = uploadExtOf(req.headers['x-filename'], req.headers['content-type']);
    if (!ext) return res.status(415).json({ ok: false, error: 'bad-type' });
    if (store.uploadBytes() + buf.length > MAX_UPLOAD_TOTAL) {
      return res.status(507).json({ ok: false, error: 'storage-full' });
    }
    const id = crypto.randomBytes(16).toString('hex');
    const stored = id + '.' + ext;
    try { fs.writeFileSync(path.join(UPLOAD_DIR, stored), buf); } catch (e) {
      console.error('upload failed:', e.message);
      return res.status(500).json({ ok: false, error: 'write-failed' });
    }
    store.addUpload(stored, buf.length);
    let name = '';
    try { name = decodeURIComponent(String(req.headers['x-filename'] || '')); } catch (e) { name = ''; }
    res.json({ ok: true, path: '/uploads/' + stored, title: cleanTitle(name.replace(/\.[^.]+$/, ''), 'آپلود') });
  });

// Files nobody points at any more — their room expired, or the track was
// removed — would otherwise sit on the disk forever.
function referencedUploads() {
  const used = new Set();
  for (const r of Object.values(rooms)) {
    [r.track].concat(r.queue || [], r.history || []).forEach((t) => {
      if (t && typeof t.url === 'string' && UPLOAD_PATH_RE.test(t.url)) used.add(t.url.slice(8));
    });
  }
  return used;
}
function sweepUploads() {
  const used = referencedUploads();
  const cutoff = Date.now() - UPLOAD_TTL_MS;
  let dropped = 0;
  for (const { name, bytes } of store.uploads()) {
    if (used.has(name)) continue;
    try {
      const st = fs.statSync(path.join(UPLOAD_DIR, name));
      // age from the file, so a room that keeps referencing it wins over age
      if (!st.isFile() || st.mtimeMs > cutoff) continue;
      fs.unlinkSync(path.join(UPLOAD_DIR, name));
    } catch (e) { continue; /* already gone */ }
    store.removeUpload(name);
    dropped += bytes;
  }
  return dropped;
}
setInterval(() => {
  const dropped = sweepUploads();
  if (dropped) console.log('swept uploads:', dropped);
}, 60 * 60 * 1000).unref();

// ---------------------------------------------------------- rooms
// rooms[code] = {
//   hostId: uid|null, hostToken (secret, only to holder), banned[guestId],
//   members: {socketId: {userId(uid), guestId, username, color, role, isHost}},
//   track|null, queue[], history[], chat[],
//   isPlaying, position, updatedAt, createdAt, lastActive, djOnly,
//   speed, _skipUntil, _hostTimer
// }
const rooms = {};
(function restoreRooms() {
  const saved = store.allRooms();
  for (const [code, s] of Object.entries(saved)) {
    if (!code || !s) continue;
    rooms[code] = {
      code,
      hostId: s.hostId || null,
      hostToken: typeof s.hostToken === 'string' ? s.hostToken : null,
      banned: Array.isArray(s.banned) ? s.banned.slice(0, 200) : [],
      members: {},
      track: s.track || null,
      queue: Array.isArray(s.queue) ? s.queue : [],
      history: Array.isArray(s.history) ? s.history : [],
      chat: Array.isArray(s.chat) ? s.chat : [],
      isPlaying: false, // never resume playing after a restart
      position: typeof s.position === 'number' ? s.position : 0,
      seq: 0,
      queueSort: s.queueSort === 'votes' ? 'votes' : 'added',
      passwordHash: s.passwordHash || null,
      passwordSalt: s.passwordSalt || null,
      updatedAt: Date.now(),
      updatedAtMono: monoNow(),
      createdAt: s.createdAt || Date.now(),
      lastActive: s.lastActive || Date.now(),
      djOnly: !!s.djOnly,
      speed: VALID_SPEEDS.includes(s.speed) ? s.speed : 1,
    };
  }
  if (Object.keys(rooms).length) console.log('restored rooms:', Object.keys(rooms).length);
})();

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms[code]);
  return code;
}
function currentPosition(room) {
  if (!room.track) return 0;
  if (!room.isPlaying) return room.position;
  // media time advances at room.speed, not wall-clock time
  const speed = VALID_SPEEDS.includes(room.speed) ? room.speed : 1;
  let secs;
  if (typeof room.updatedAtMono === 'bigint') {
    secs = Number(monoNow() - room.updatedAtMono) / 1e9;
  } else {
    secs = (Date.now() - room.updatedAt) / 1000;
  }
  return room.position + (secs > 0 ? secs : 0) * speed;
}
function liveMembers(room) {
  return Object.values(room.members).map((m) => ({
    userId: m.userId,
    username: m.username,
    color: m.color,
    role: m.role,
    isHost: !!m.isHost,
  }));
}
function liveMemberCount(room) {
  return Object.keys(room.members).length;
}
function roomState(room) {
  return {
    track: room.track,
    queue: room.queue || [],
    history: (room.history || []).slice(-20),
    chat: (room.chat || []).slice(-50),
    isPlaying: room.isPlaying,
    position: currentPosition(room),
    users: liveMemberCount(room),
    members: liveMembers(room),
    hostId: room.hostId,
    djOnly: !!room.djOnly,
    speed: VALID_SPEEDS.includes(room.speed) ? room.speed : 1,
    // only a boolean: the hash never leaves the server
    private: !!room.passwordHash,
    queueSort: room.queueSort === 'votes' ? 'votes' : 'added',
    seq: room.seq || 0,
  };
}

// Heartbeat answer. The 5s drift check only needs to know whether the room is
// playing and roughly where it is, but it was asking for roomState() and so
// shipped the whole chat log, queue and member list to every client four
// times a minute each.
function tickState(room) {
  return {
    track: !!room.track,
    isPlaying: room.isPlaying,
    position: currentPosition(room),
    speed: VALID_SPEEDS.includes(room.speed) ? room.speed : 1,
    seq: room.seq || 0,
  };
}
function touch(room) {
  room.lastActive = Date.now();
  markDirty(room.code);
}
const VALID_EMOJI = ['❤️', '🔥', '👏', '😂', '😮', '👎', '🎵'];

// Votes are advisory — the host still decides what plays — but a group needs
// a way to say "this one next" without everyone shouting in chat.
function sortQueue(room) {
  if (room.queueSort !== 'votes') return;
  // Array#sort is stable, so equal counts keep the order they were added in
  room.queue.sort((a, b) => (b.votes || 0) - (a.votes || 0));
}
function canManageItem(room, socket, item) {
  if (!item || !item.addedBy) return false;
  return roomHost(socket, room) || item.addedBy.ownerId === socket.user.ownerTag;
}
function memberOf(room, socket) {
  return room.members[socket.id] || null;
}
function isListener(member) {
  return member && member.role === 'listener';
}
// host = the member record holding the flag; set only by create or a
// valid hostToken claim — never by "whoever claims it".
function roomHost(socket, room) {
  const m = room.members[socket.id];
  return !!(m && m.isHost);
}
function setHost(room, member) {
  for (const m of Object.values(room.members)) m.isHost = false;
  if (member) {
    member.isHost = true;
    room.hostId = member.userId;
  } else {
    room.hostId = null;
  }
}
function canControl(room, member) {
  if (!member || isListener(member)) return false;
  if (room.djOnly && !member.isHost) return false;
  return true;
}

// The SoundCloud widget exposes no playback-rate control, so a room speed
// other than 1x would run the server clock ahead of the audio and leave
// every SC track drifting forever (the heartbeat would then re-seek it every
// 5s and it would stutter). Snap to 1x whenever one of those is loaded.
function lockSpeedFor(room, code) {
  if (!room.track || room.track.type !== 'soundcloud') return false;
  if (room.speed === 1) return false;
  room.speed = 1;
  io.to(code).emit('speed-change', 1);
  return true;
}
function soundcloudSpeedBlocked(room, v) {
  return !!(room.track && room.track.type === 'soundcloud' && v !== 1);
}

function emitMembers(room, code) {
  // One event only: the client used to set the online count from a second
  // 'room-users' payload as well, so the number was written twice per update.
  io.to(code).emit('members', liveMembers(room));
}

function leaveRoom(socket, code) {
  const room = rooms[code];
  if (!room || !room.members[socket.id]) return;
  socket.leave(code);
  const wasHost = !!room.members[socket.id].isHost;
  delete room.members[socket.id];
  const remaining = Object.values(room.members);
  if (wasHost) {
    // Grace period: a refresh/reconnect must not steal the host title.
    // The token stays valid for the original holder until it expires.
    setHost(room, null);
    if (room._hostTimer) { clearTimeout(room._hostTimer); room._hostTimer = null; }
    // Restart the window from now — even if everyone else has already gone,
    // so the holder's 30s isn't extended by the room emptying.
    ensureHostTimer(room, code);
  }
  touch(room);
  if (remaining.length) emitMembers(room, code);
  // NOTE: rooms persist after emptying (invite link keeps working);
  // the sweeper below deletes rooms idle > 24h.
}

// Grace expired and the token holder never came back: mint a NEW token
// (old one dies with it) and hand it privately to the next member.
function transferHost(room, code) {
  room._hostTimer = null;
  const entries = Object.entries(room.members);
  if (!entries.length) return;
  let [, next] = entries.find(([, m]) => m.role !== 'listener') || entries[0];
  if (isListener(next)) next.role = 'member'; // an all-listener room promotes
  room.hostToken = crypto.randomBytes(24).toString('base64url');
  setHost(room, next);
  const sid = Object.keys(room.members).find((s) => room.members[s] === next);
  if (sid) io.to(sid).emit('host-token', { code, token: room.hostToken });
  touch(room);
  emitMembers(room, code);
}

// A room with no host must have a grace timer running, or it can get stuck
// hostless for good: the timer fires while the room is empty, transferHost()
// finds nobody to promote and returns, and nothing ever starts another one.
// Joining a room with no host therefore (re)arms the clock, which leaves the
// original token holder one more HOST_GRACE_MS to reclaim before anyone else
// is promoted. Callers that are about to hand out the crown skip this.
function ensureHostTimer(room, code) {
  if (room._hostTimer) return;
  if (Object.values(room.members).some((m) => m.isHost)) return;
  room._hostTimer = setTimeout(() => transferHost(room, code), HOST_GRACE_MS);
  room._hostTimer.unref && room._hostTimer.unref();
}

// Expire rooms idle for more than a day (and with nobody inside).
setInterval(() => {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  let dropped = 0;
  for (const [code, r] of Object.entries(rooms)) {
    if (liveMemberCount(r) === 0 && (r.lastActive || 0) < cutoff) {
      delete rooms[code];
      markDirty(code); // flushDirty turns a missing room into a DELETE
      dropped++;
    }
  }
  if (dropped) { console.log('swept rooms:', dropped); }
}, 10 * 60 * 1000).unref();

// ---------------------------------------------------------- socket identity (guest)
io.use((socket, next) => {
  const a = (socket.handshake && socket.handshake.auth) || {};
  const name = validDisplayName(a.displayName);
  const gid = validGuestId(a.guestId);
  if (!name || !gid) return next(new Error('name-required'));
  // resolved once per connection — see rateKeyOf()
  socket.rateKey = rateKeyOf(socket.handshake);
  // uid is server-issued per connection: what gets broadcast and what
  // kicks/host checks run on — client-declared guestId is NOT identity
  // (it's only a handle for best-effort bans and the display name).
  // Per-member queue-ownership secret. join-room may re-adopt an earlier one
  // so a refresh keeps the right to delete what this browser queued.
  socket.ownerSecret = newOwnerSecret();
  socket.user = {
    id: crypto.randomBytes(9).toString('base64url'),
    guestId: gid,
    username: name,
    color: avatarColor(name),
    ownerTag: ownerTag(socket.ownerSecret),
  };
  next();
});

io.on('connection', (socket) => {
  let joinedCode = null;

  socket.on('create-room', (opts, cb) => {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    if (!rateOk('room:' + socket.rateKey, 30, 60000)) {
      if (typeof cb === 'function') cb({ ok: false, error: 'rate-limited' });
      return;
    }
    // Rooms linger for 24h after emptying, so without a ceiling a client with
    // several IPs could fill memory faster than the sweeper drains it.
    if (Object.keys(rooms).length >= MAX_ROOMS) {
      if (typeof cb === 'function') cb({ ok: false, error: 'server-full' });
      return;
    }
    if (joinedCode) leaveRoom(socket, joinedCode);
    const code = makeCode();
    // Secret host capability — returned ONLY to the creator here.
    const hostToken = crypto.randomBytes(24).toString('base64url');
    // Optional: no password means an open room, exactly as before.
    const pw = cleanPassword(opts && opts.password);
    const locked = pw ? makePassword(pw) : { passwordSalt: null, passwordHash: null };
    rooms[code] = {
      code,
      hostId: null,
      hostToken,
      banned: [],
      members: {},
      track: null,
      queue: [],
      history: [],
      chat: [],
      isPlaying: false,
      position: 0,
      seq: 0,
      passwordSalt: locked.passwordSalt,
      passwordHash: locked.passwordHash,
      queueSort: 'added',
      updatedAt: Date.now(),
      updatedAtMono: monoNow(),
      createdAt: Date.now(),
      lastActive: Date.now(),
      djOnly: false,
      speed: 1,
    };
    const room = rooms[code];
    // The creator is always a controlling member — a listener-host would
    // leave the room with nobody able to play anything (esp. in djOnly).
    room.members[socket.id] = {
      userId: socket.user.id,
      guestId: socket.user.guestId,
      username: socket.user.username,
      color: socket.user.color,
      role: 'member',
      isHost: false,
    };
    setHost(room, room.members[socket.id]);
    joinedCode = code;
    socket.join(code);
    touch(room);
    if (typeof cb === 'function')
      cb({
        ok: true,
        code,
        uid: socket.user.id,
        hostToken,
        ownerSecret: socket.ownerSecret,
        ownerTag: socket.user.ownerTag,
        isHost: true,
        role: room.members[socket.id].role,
        state: roomState(room),
      });
    emitMembers(room, code);
  });

  // join-room(code, [opts], cb) — opts: { asListener, hostToken }
  socket.on('join-room', (code, opts, cb) => {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    code = (code || '').toUpperCase().trim();
    if (!rateOk('room:' + socket.rateKey, 30, 60000)) {
      if (typeof cb === 'function') cb({ ok: false, error: 'rate-limited' });
      return;
    }
    const room = rooms[code];
    if (!room) {
      if (typeof cb === 'function') cb({ ok: false, error: 'Room not found' });
      return;
    }
    if ((room.banned || []).includes(socket.user.guestId)) {
      if (typeof cb === 'function') cb({ ok: false, error: 'banned' });
      return;
    }
    const wantListener = !!(opts && opts.asListener);
    const token = opts && typeof opts.hostToken === 'string' ? opts.hostToken : null;
    const claimed = !!(token && room.hostToken && token === room.hostToken);
    // A private room needs its password, unless you are proving hostship
    // with the token — which the creator already holds.
    if (!claimed && !passwordMatches(room, cleanPassword(opts && opts.password))) {
      if (typeof cb === 'function') cb({ ok: false, error: 'wrong-password' });
      return;
    }
    // Re-adopt the queue-ownership secret this browser already holds, so a
    // refresh does not lose the right to delete its own queued tracks.
    if (opts && opts.ownerSecret !== undefined) {
      socket.ownerSecret = adoptOwnerSecret(opts.ownerSecret);
      socket.user.ownerTag = ownerTag(socket.ownerSecret);
    }
    const existing = room.members[socket.id];
    let member;
    if (code !== joinedCode || !existing) {
      if (joinedCode && joinedCode !== code) leaveRoom(socket, joinedCode);
      member = {
        userId: socket.user.id,
        guestId: socket.user.guestId,
        username: socket.user.username,
        color: socket.user.color,
        role: wantListener ? 'listener' : 'member',
        isHost: false,
      };
      room.members[socket.id] = member;
      joinedCode = code;
      socket.join(code);
      // Hostship only via the secret token. A plain joiner never takes the
      // crown immediately — the oldest this can be granted is after the
      // grace window below expires, during which the token holder can
      // still reclaim it by presenting the token.
      if (claimed) {
        setHost(room, member);
        if (room._hostTimer) { clearTimeout(room._hostTimer); room._hostTimer = null; }
      }
    } else {
      member = existing;
      if (member.role !== (wantListener ? 'listener' : 'member')) {
        member.role = wantListener ? 'listener' : 'member';
      }
      if (claimed) { setHost(room, member); if (room._hostTimer) { clearTimeout(room._hostTimer); room._hostTimer = null; } }
    }
    // Room is hostless (nobody holds the crown, token never claimed): arm
    // the grace clock so it is never stuck that way — see ensureHostTimer.
    if (!member.isHost) ensureHostTimer(room, code);
    touch(room);
    if (typeof cb === 'function') {
      cb({
        ok: true,
        code,
        uid: socket.user.id,
        hostToken: claimed ? room.hostToken : undefined,
        ownerSecret: socket.ownerSecret,
        ownerTag: socket.user.ownerTag,
        isHost: !!member.isHost,
        role: member.role,
        state: roomState(room),
      });
    }
    emitMembers(room, code);
  });

  function needRoom() {
    return rooms[joinedCode] || null;
  }

  // Add a track: plays immediately when nothing is loaded, else enqueues.
  function addTrack(payload, cb) {
    const room = needRoom();
    if (!room) {
      if (typeof cb === 'function') cb({ ok: false, error: 'no-room' });
      return;
    }
    const member = memberOf(room, socket);
    if (!canControl(room, member)) {
      if (typeof cb === 'function') cb({ ok: false, error: 'listeners-cannot-add' });
      return;
    }
    const clean = validTrackInput(payload);
    if (!clean) {
      if (typeof cb === 'function') cb({ ok: false, error: 'bad-track' });
      return;
    }
    const item = makeTrackItem(clean, payload && payload.title, socket.user);
    if (!room.track) {
      // Nothing was playing, so this becomes the current track and starts —
      // loading it paused meant every track needed a fresh ▶ click, and the
      // queue stopped dead after each one. A browser that refuses autoplay
      // keeps the room "playing" anyway; the client's 5s heartbeat retries
      // until the user has interacted with the page.
      room.track = item;
      room.position = 0;
      room.isPlaying = true;
      stamp(room);
      lockSpeedFor(room, joinedCode);
      touch(room);
      io.to(joinedCode).emit('load-track', room.track);
      io.to(joinedCode).emit('queue-update', room.queue);
      io.to(joinedCode).emit('play', 0, bumpSeq(room));
    } else {
      if (room.queue.length >= 100) {
        if (typeof cb === 'function') cb({ ok: false, error: 'queue-full' });
        return;
      }
      room.queue.push(item);
      touch(room);
      io.to(joinedCode).emit('queue-update', room.queue);
    }
    if (typeof cb === 'function') cb({ ok: true, track: item });
  }
  socket.on('load-track', (p, cb) => addTrack(p, cb));
  socket.on('queue-add', (p, cb) => addTrack(p, cb));

  socket.on('queue-remove', (trackId, cb) => {
    const room = needRoom();
    if (!room) {
      if (typeof cb === 'function') cb({ ok: false, error: 'no-room' });
      return;
    }
    const member = memberOf(room, socket);
    if (!member || isListener(member)) {
      if (typeof cb === 'function') cb({ ok: false, error: 'not-allowed' });
      return;
    }
    const i = room.queue.findIndex((t) => t.id === trackId);
    if (i < 0) {
      if (typeof cb === 'function') cb({ ok: false, error: 'not-found' });
      return;
    }
    const item = room.queue[i];
    // Ownership is proven with the secret's hash, not with guestId — anyone
    // can send whatever guestId they like in the handshake.
    const mine = !!(item.addedBy && item.addedBy.ownerId &&
      item.addedBy.ownerId === socket.user.ownerTag);
    const host = roomHost(socket, room);
    if (!mine && !host) {
      if (typeof cb === 'function') cb({ ok: false, error: 'not-allowed' });
      return;
    }
    room.queue.splice(i, 1);
    touch(room);
    io.to(joinedCode).emit('queue-update', room.queue);
    if (typeof cb === 'function') cb({ ok: true });
  });

  socket.on('queue-clear', (cb) => {
    const room = needRoom();
    if (!room) {
      if (typeof cb === 'function') cb({ ok: false, error: 'no-room' });
      return;
    }
    if (!roomHost(socket, room)) {
      if (typeof cb === 'function') cb({ ok: false, error: 'host-only' });
      return;
    }
    room.queue = [];
    touch(room);
    io.to(joinedCode).emit('queue-update', room.queue);
    if (typeof cb === 'function') cb({ ok: true });
  });

  // Reorder: 'next' puts it at the front, 'up'/'down' nudge it. Only the
  // person who queued it (or the host) may move it — same rule as deleting.
  socket.on('queue-move', (args, cb) => {
    const room = needRoom();
    if (!room) {
      if (typeof cb === 'function') cb({ ok: false, error: 'no-room' });
      return;
    }
    const member = memberOf(room, socket);
    if (isListener(member)) {
      if (typeof cb === 'function') cb({ ok: false, error: 'not-allowed' });
      return;
    }
    const id = args && args.id;
    const where = args && args.to;
    const i = room.queue.findIndex((t) => t.id === id);
    if (i < 0) {
      if (typeof cb === 'function') cb({ ok: false, error: 'not-found' });
      return;
    }
    if (!canManageItem(room, socket, room.queue[i])) {
      if (typeof cb === 'function') cb({ ok: false, error: 'not-allowed' });
      return;
    }
    const at = where === 'next' ? 0
      : where === 'up' ? Math.max(0, i - 1)
      : where === 'down' ? Math.min(room.queue.length - 1, i + 1)
      : -1;
    if (at < 0 || at === i) {
      if (typeof cb === 'function') cb({ ok: false, error: 'bad-target' });
      return;
    }
    const [item] = room.queue.splice(i, 1);
    room.queue.splice(at, 0, item);
    // A hand-reordered queue is asking to be left alone; a vote sort would
    // undo it on the next vote.
    if (room.queueSort !== 'added') {
      room.queueSort = 'added';
      io.to(joinedCode).emit('room-flags', {
        djOnly: room.djOnly, hostId: room.hostId, queueSort: room.queueSort,
      });
    }
    touch(room);
    io.to(joinedCode).emit('queue-update', room.queue);
    if (typeof cb === 'function') cb({ ok: true });
  });

  // One vote per member per track, toggled. Listeners can vote — it is not
  // playback control, it is a opinion about what to play.
  socket.on('queue-vote', (trackId, cb) => {
    const room = needRoom();
    if (!room) {
      if (typeof cb === 'function') cb({ ok: false, error: 'no-room' });
      return;
    }
    if (!memberOf(room, socket)) {
      if (typeof cb === 'function') cb({ ok: false, error: 'no-room' });
      return;
    }
    const now = Date.now();
    if (now - (socket._lastVote || 0) < 400) {
      if (typeof cb === 'function') cb({ ok: false, error: 'slow-down' });
      return;
    }
    socket._lastVote = now;
    const item = room.queue.find((t) => t.id === trackId);
    if (!item) {
      if (typeof cb === 'function') cb({ ok: false, error: 'not-found' });
      return;
    }
    const tag = socket.user.ownerTag;
    item.voters = Array.isArray(item.voters) ? item.voters : [];
    const at = item.voters.indexOf(tag);
    if (at >= 0) item.voters.splice(at, 1); else item.voters.push(tag);
    item.votes = item.voters.length;
    sortQueue(room);
    touch(room);
    io.to(joinedCode).emit('queue-update', room.queue);
    if (typeof cb === 'function') cb({ ok: true, votes: item.votes });
  });

  socket.on('queue-sort', (mode, cb) => {
    const room = needRoom();
    if (!room) {
      if (typeof cb === 'function') cb({ ok: false, error: 'no-room' });
      return;
    }
    if (!roomHost(socket, room)) {
      if (typeof cb === 'function') cb({ ok: false, error: 'host-only' });
      return;
    }
    if (mode !== 'added' && mode !== 'votes') {
      if (typeof cb === 'function') cb({ ok: false, error: 'bad-sort' });
      return;
    }
    room.queueSort = mode;
    sortQueue(room);
    touch(room);
    io.to(joinedCode).emit('room-flags', {
      djOnly: room.djOnly, hostId: room.hostId, queueSort: room.queueSort,
    });
    io.to(joinedCode).emit('queue-update', room.queue);
    if (typeof cb === 'function') cb({ ok: true, queueSort: room.queueSort });
  });

  function advance(room, code) {
    // Block follow-up 'track-ended' emits from the OTHER clients for 2s —
    // every client fires ENDED for the same track, and without this window
    // N clients would skip N tracks.
    room._skipUntil = Date.now() + 2000;
    // Whatever control echo is still in flight belongs to the old track now.
    const seq = bumpSeq(room);
    if (room.track) {
      room.history.push({ ...room.track, playedAt: Date.now() });
      room.history = room.history.slice(-30);
      io.to(code).emit('history-update', room.history.slice(-20));
    }
    if (room.queue.length) {
      room.track = room.queue.shift();
      room.position = 0;
      // Keep the queue rolling: leaving isPlaying false here meant every
      // track ended with the room stopped, waiting for another ▶ click.
      room.isPlaying = true;
      stamp(room);
      lockSpeedFor(room, code);
      io.to(code).emit('load-track', room.track);
      io.to(code).emit('queue-update', room.queue);
      io.to(code).emit('play', 0, seq);
    } else {
      room.track = null;
      room.isPlaying = false;
      room.position = 0;
      stamp(room);
      io.to(code).emit('load-track', null);
    }
    touch(room);
  }

  socket.on('skip', (cb) => {
    const room = needRoom();
    if (!room) {
      if (typeof cb === 'function') cb({ ok: false, error: 'no-room' });
      return;
    }
    const member = memberOf(room, socket);
    if (!canControl(room, member)) {
      if (typeof cb === 'function') cb({ ok: false, error: 'not-allowed' });
      return;
    }
    // nothing loaded and queue empty — harmless no-op
    if (!room.track && !room.queue.length) {
      if (typeof cb === 'function') cb({ ok: true });
      return;
    }
    advance(room, joinedCode);
    if (typeof cb === 'function') cb({ ok: true });
  });

  socket.on('track-ended', () => {
    const room = needRoom();
    if (!room || !room.track) return;
    // Every client reports ENDED for the same track; only the first one
    // (outside the window set by the previous advance) advances the queue.
    if (room._skipUntil && Date.now() < room._skipUntil) return;
    const member = memberOf(room, socket);
    // Same gate as 'skip': a track ending is still a way to push the queue
    // forward, so in djOnly mode only the host's report counts. Checking
    // isListener alone let any plain member fast-forward the room.
    if (!canControl(room, member)) return;
    advance(room, joinedCode);
  });

  socket.on('play', (position, seq) => {
    const room = needRoom();
    if (!room) return;
    if (!canControl(room, memberOf(room, socket))) return;
    // A late echo of something the room has already moved past must not
    // resurrect it — that is how a buffering client undid the host's pause.
    const kind = echoKind(room, seq);
    if (kind === 'stale') return;
    const pos = safePos(position);
    room.isPlaying = true;
    if (pos !== null) room.position = pos;
    stamp(room);
    touch(room);
    if (kind === 'echo') return; // applied for the sender, nothing to relay
    socket.to(joinedCode).emit('play', room.position, bumpSeq(room));
  });

  socket.on('pause', (position, seq) => {
    const room = needRoom();
    if (!room) return;
    if (!canControl(room, memberOf(room, socket))) return;
    const kind = echoKind(room, seq);
    if (kind === 'stale') return;
    const pos = safePos(position);
    room.isPlaying = false;
    if (pos !== null) room.position = pos;
    stamp(room);
    touch(room);
    if (kind === 'echo') return;
    socket.to(joinedCode).emit('pause', room.position, bumpSeq(room));
  });

  socket.on('seek', (position, seq) => {
    const room = needRoom();
    if (!room) return;
    if (!canControl(room, memberOf(room, socket))) return;
    const kind = echoKind(room, seq);
    if (kind === 'stale') return;
    const pos = safePos(position);
    if (pos === null) return;
    room.position = pos;
    stamp(room);
    touch(room);
    if (kind === 'echo') return;
    socket.to(joinedCode).emit('seek', room.position, bumpSeq(room));
  });

  socket.on('chat-message', (text, cb) => {
    const room = needRoom();
    if (!room) {
      if (typeof cb === 'function') cb({ ok: false, error: 'no-room' });
      return;
    }
    const member = memberOf(room, socket);
    if (!member) {
      if (typeof cb === 'function') cb({ ok: false, error: 'no-room' });
      return;
    }
    // basic flood guard: 1 message / 300ms per socket
    const now = Date.now();
    if (now - (socket._lastChat || 0) < 300) {
      if (typeof cb === 'function') cb({ ok: false, error: 'slow-down' });
      return;
    }
    const t = cleanChat(text);
    if (!t) {
      if (typeof cb === 'function') cb({ ok: false, error: 'bad-message' });
      return;
    }
    socket._lastChat = now;
    const msg = {
      id: rid(),
      userId: socket.user.id,
      username: socket.user.username,
      color: socket.user.color,
      text: t,
      at: now,
    };
    room.chat.push(msg);
    room.chat = room.chat.slice(-100);
    touch(room);
    io.to(joinedCode).emit('chat-message', msg);
    if (typeof cb === 'function') cb({ ok: true, message: msg });
  });

  socket.on('reaction', (emoji) => {
    const room = needRoom();
    if (!room || !memberOf(room, socket)) return;
    if (!VALID_EMOJI.includes(emoji)) return;
    // flood guard: 1 reaction / 400ms
    const now = Date.now();
    if (now - (socket._lastReact || 0) < 400) return;
    socket._lastReact = now;
    io.to(joinedCode).emit('reaction', {
      emoji,
      userId: socket.user.id,
      username: socket.user.username,
      at: now,
    });
  });

  socket.on('kick', (userId, cb) => {
    const room = needRoom();
    if (!room) {
      if (typeof cb === 'function') cb({ ok: false, error: 'no-room' });
      return;
    }
    if (!roomHost(socket, room)) {
      if (typeof cb === 'function') cb({ ok: false, error: 'host-only' });
      return;
    }
    if (userId === socket.user.id) {
      if (typeof cb === 'function') cb({ ok: false, error: 'self' });
      return;
    }
    const targets = Object.keys(room.members).filter(
      (sid) => room.members[sid].userId === userId
    );
    if (!targets.length) {
      if (typeof cb === 'function') cb({ ok: false, error: 'not-found' });
      return;
    }
    targets.forEach((sid) => {
      const s = io.sockets.sockets.get(sid);
      const kicked = room.members[sid];
      // best-effort ban by guestId (cleared localStorage bypasses it, but
      // it stops the common "rejoin instantly" troll)
      if (kicked && kicked.guestId && Array.isArray(room.banned)) {
        if (!room.banned.includes(kicked.guestId) && room.banned.length < 200) {
          room.banned.push(kicked.guestId);
        }
      }
      if (s) {
        io.to(sid).emit('kicked', { code: joinedCode });
        leaveRoom(s, joinedCode);
      }
    });
    if (typeof cb === 'function') cb({ ok: true });
  });

  socket.on('set-dj-only', (on, cb) => {
    const room = needRoom();
    if (!room) {
      if (typeof cb === 'function') cb({ ok: false, error: 'no-room' });
      return;
    }
    if (!roomHost(socket, room)) {
      if (typeof cb === 'function') cb({ ok: false, error: 'host-only' });
      return;
    }
    room.djOnly = !!on;
    touch(room);
    io.to(joinedCode).emit('room-flags', {
      djOnly: room.djOnly, hostId: room.hostId, queueSort: room.queueSort || 'added',
    });
    if (typeof cb === 'function') cb({ ok: true, djOnly: room.djOnly });
  });

  // Explicit leave from the lobby UI (staying connected).
  socket.on('leave-room', () => {
    if (joinedCode) {
      leaveRoom(socket, joinedCode);
      joinedCode = null;
    }
  });

  // Room playback speed (whitelisted values only) — shared so everyone
  // stays in sync; a listener's speed change is ignored by the server and
  // the client reverts its select on the next state push.
  socket.on('set-speed', (v, cb) => {
    const room = needRoom();
    if (!room) {
      if (typeof cb === 'function') cb({ ok: false, error: 'no-room' });
      return;
    }
    if (!canControl(room, memberOf(room, socket))) {
      if (typeof cb === 'function') cb({ ok: false, error: 'not-allowed' });
      return;
    }
    if (!VALID_SPEEDS.includes(v)) {
      if (typeof cb === 'function') cb({ ok: false, error: 'bad-speed' });
      return;
    }
    // SC has no playback-rate API — changing it would desync the track.
    if (soundcloudSpeedBlocked(room, v)) {
      if (typeof cb === 'function') cb({ ok: false, error: 'speed-unsupported' });
      return;
    }
    // rebase position at the OLD speed first, then switch — otherwise the
    // estimated clock jumps by the speed ratio
    room.position = currentPosition(room);
    room.speed = v;
    stamp(room);
    bumpSeq(room); // invalidate control echoes stamped at the old rate
    touch(room);
    io.to(joinedCode).emit('speed-change', v);
    if (typeof cb === 'function') cb({ ok: true, speed: v });
  });

  socket.on('sync-request', (cb) => {
    const room = needRoom();
    if (!room) return;
    if (typeof cb === 'function') cb(roomState(room));
  });

  // What the 5s drift heartbeat actually needs — see tickState().
  socket.on('ping-state', (cb) => {
    const room = needRoom();
    if (typeof cb !== 'function') return;
    cb(room ? tickState(room) : null);
  });

  socket.on('disconnect', () => {
    if (joinedCode) leaveRoom(socket, joinedCode);
  });
});

// express.raw() refuses a body over its limit; answer it in the same JSON
// shape the rest of /api/upload uses rather than Express's HTML error page.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ ok: false, error: 'too-large' });
  }
  console.error(err);
  res.status(500).json({ ok: false, error: 'server-error' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`SyncBeat v2 running on http://localhost:${PORT}`);
});

// Flush on shutdown. scheduleSave() debounces by 1.5s, and a host (Render,
// Railway, systemd, Ctrl+C) can kill us inside that window — without this
// the last few seconds of chat, queue edits and bans never reach disk.
// persistNow() is synchronous, so it is safe on the way out.
let shuttingDown = false;
function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(sig + ': flushing room state');
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  persistNow();
  try { io.close(); } catch (e) { /* already closing */ }
  // Nothing should need this — io.close() drops the handles — but a stuck
  // connection must not keep the process alive forever.
  setTimeout(() => process.exit(0), 1000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
// Safety net for `process.exit()` from anywhere else: 'exit' only allows
// synchronous work, which persistNow() happens to be.
process.on('exit', () => {
  if (shuttingDown || !saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  persistNow();
});
