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

app.use(express.static(path.join(__dirname, 'public')));

// whitelists used by the restore IIFE below as well as the handlers
const VALID_SPEEDS = [0.75, 1, 1.25, 1.5, 2];

// ---------------------------------------------------------- persistence
const DATA_DIR = process.env.SB_DATA_DIR || path.join(__dirname, 'data');
const ROOMS_FILE = path.join(DATA_DIR, 'rooms.json');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { /* exists */ }

function loadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error('loadJson failed for', file, e.message);
    return fallback;
  }
}
let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persistNow();
  }, 1500);
}
function persistNow() {
  try {
    const portable = {};
    for (const [code, r] of Object.entries(rooms)) {
      portable[code] = {
        hostId: r.hostId,
        hostToken: r.hostToken || null,
        banned: (r.banned || []).slice(0, 200),
        djOnly: !!r.djOnly,
        track: r.track,
        queue: (r.queue || []).slice(0, 100),
        history: (r.history || []).slice(-30),
        chat: (r.chat || []).slice(-100),
        isPlaying: !!r.isPlaying,
        position: r.position || 0,
        speed: VALID_SPEEDS.includes(r.speed) ? r.speed : 1,
        updatedAt: r.updatedAt || Date.now(),
        createdAt: r.createdAt || Date.now(),
        lastActive: r.lastActive || Date.now(),
      };
    }
    // Atomic write: a crash mid-write must not truncate rooms.json.
    const tmp = ROOMS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(portable, null, 1));
    fs.renameSync(tmp, ROOMS_FILE);
  } catch (e) {
    console.error('persist failed:', e.message);
  }
}

// ---------------------------------------------------------- guest identity
// No passwords: the client sends { guestId, displayName }; the server
// validates the shape and derives the avatar color from the name.
function avatarColor(name) {
  let h = 0;
  for (let i = 0; i < String(name).length; i++) h = (h * 31 + String(name).charCodeAt(i)) >>> 0;
  return 'hsl(' + (h % 360) + ' 45% 55%)';
}
function validDisplayName(name) {
  if (typeof name !== 'string') return null;
  const n = name.trim().replace(/\s+/g, ' ');
  // 2..20 chars, letters (incl. Persian/Arabic range), digits, _ - .
  if (!/^[\p{L}\p{N}_.\- ]{2,20}$/u.test(n)) return null;
  return n;
}
function validGuestId(id) {
  if (typeof id !== 'string') return null;
  id = id.trim();
  if (!/^[A-Za-z0-9_-]{6,32}$/.test(id)) return null;
  return id;
}
const rid = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// NOTE: there used to be a GET /api/room/:code here reporting whether a code
// existed (and how many people were inside). Nothing ever called it, and it
// answered an unbounded number of requests — a free oracle for enumerating
// room codes that bypassed the rate limiter below entirely. Removed.

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
  const saved = loadJson(ROOMS_FILE, {});
  for (const [code, s] of Object.entries(saved)) {
    if (!code || !s) continue;
    rooms[code] = {
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
      updatedAt: Date.now(),
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
  return room.position + ((Date.now() - room.updatedAt) / 1000) * speed;
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
  };
}
function touch(room) {
  room.lastActive = Date.now();
  scheduleSave();
}

const VALID_TRACK_TYPES = ['audio', 'youtube', 'soundcloud'];
const VALID_EMOJI = ['❤️', '🔥', '👏', '😂', '😮', '👎', '🎵'];
function safePos(p) {
  return typeof p === 'number' && isFinite(p) && p >= 0 ? p : null;
}
function cleanTitle(t, fallback) {
  if (typeof t === 'string') {
    t = t.trim().slice(0, 140);
    if (t) return t;
  }
  return fallback;
}
function cleanChat(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim().replace(/\s+/g, ' ');
  if (!t || t.length > 500) return null;
  return t;
}
function validTrackInput(input) {
  const raw = input || {};
  const type = raw.type;
  if (!VALID_TRACK_TYPES.includes(type) || typeof raw.url !== 'string') return null;
  const url = raw.url.trim();
  if (!url || url.length > 2048) return null;
  if (type === 'youtube') {
    if (!/^[\w-]{11}$/.test(url)) return null;
  } else if (!/^https?:\/\//i.test(url)) return null;
  return { type, url };
}
function makeTrackItem(input, title, user) {
  return {
    id: rid(),
    type: input.type,
    url: input.url,
    title: cleanTitle(title, input.type === 'youtube' ? 'YouTube · ' + input.url : input.url.slice(0, 80)),
    addedBy: { userId: user.id, guestId: user.guestId, username: user.username },
    addedAt: Date.now(),
  };
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

function emitMembers(room, code) {
  io.to(code).emit('room-users', liveMemberCount(room));
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
      dropped++;
    }
  }
  if (dropped) { console.log('swept rooms:', dropped); scheduleSave(); }
}, 10 * 60 * 1000);

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
  socket.user = {
    id: crypto.randomBytes(9).toString('base64url'),
    guestId: gid,
    username: name,
    color: avatarColor(name),
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
    if (joinedCode) leaveRoom(socket, joinedCode);
    const code = makeCode();
    // Secret host capability — returned ONLY to the creator here.
    const hostToken = crypto.randomBytes(24).toString('base64url');
    rooms[code] = {
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
      updatedAt: Date.now(),
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
      room.track = item;
      room.isPlaying = false;
      room.position = 0;
      room.updatedAt = Date.now();
      touch(room);
      io.to(joinedCode).emit('load-track', room.track);
      io.to(joinedCode).emit('queue-update', room.queue);
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
    const mine = item.addedBy && item.addedBy.guestId === socket.user.guestId;
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

  function advance(room, code) {
    // Block follow-up 'track-ended' emits from the OTHER clients for 2s —
    // every client fires ENDED for the same track, and without this window
    // N clients would skip N tracks.
    room._skipUntil = Date.now() + 2000;
    if (room.track) {
      room.history.push({ ...room.track, playedAt: Date.now() });
      room.history = room.history.slice(-30);
      io.to(code).emit('history-update', room.history.slice(-20));
    }
    if (room.queue.length) {
      room.track = room.queue.shift();
      room.isPlaying = false;
      room.position = 0;
      room.updatedAt = Date.now();
      io.to(code).emit('load-track', room.track);
      io.to(code).emit('queue-update', room.queue);
    } else {
      room.track = null;
      room.isPlaying = false;
      room.position = 0;
      room.updatedAt = Date.now();
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

  socket.on('play', (position) => {
    const room = needRoom();
    if (!room) return;
    if (!canControl(room, memberOf(room, socket))) return;
    const pos = safePos(position);
    room.isPlaying = true;
    if (pos !== null) room.position = pos;
    room.updatedAt = Date.now();
    touch(room);
    socket.to(joinedCode).emit('play', room.position);
  });

  socket.on('pause', (position) => {
    const room = needRoom();
    if (!room) return;
    if (!canControl(room, memberOf(room, socket))) return;
    const pos = safePos(position);
    room.isPlaying = false;
    if (pos !== null) room.position = pos;
    room.updatedAt = Date.now();
    touch(room);
    socket.to(joinedCode).emit('pause', room.position);
  });

  socket.on('seek', (position) => {
    const room = needRoom();
    if (!room) return;
    if (!canControl(room, memberOf(room, socket))) return;
    const pos = safePos(position);
    if (pos === null) return;
    room.position = pos;
    room.updatedAt = Date.now();
    touch(room);
    socket.to(joinedCode).emit('seek', room.position);
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
    io.to(joinedCode).emit('room-flags', { djOnly: room.djOnly, hostId: room.hostId });
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
    // rebase position at the OLD speed first, then switch — otherwise the
    // estimated clock jumps by the speed ratio
    room.position = currentPosition(room);
    room.updatedAt = Date.now();
    room.speed = v;
    touch(room);
    io.to(joinedCode).emit('speed-change', v);
    if (typeof cb === 'function') cb({ ok: true, speed: v });
  });

  socket.on('sync-request', (cb) => {
    const room = needRoom();
    if (!room) return;
    if (typeof cb === 'function') cb(roomState(room));
  });

  socket.on('disconnect', () => {
    if (joinedCode) leaveRoom(socket, joinedCode);
  });
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
