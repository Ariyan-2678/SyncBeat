// store.js — where rooms and upload metadata live.
//
// Previously every change rewrote the whole rooms.json: one chat message in
// one room serialized and re-wrote every room on the server, and a crash
// mid-write could still lose the tail of it (atomic rename helped, but the
// work was O(all rooms) per keystroke either way).
//
// SQLite comes with Node itself (22.5+), so this buys per-room writes,
// real crash safety, and queries the JSON format could not answer — such as
// "which uploaded files does any room still reference?" — without adding a
// dependency or an operation to run.
//
// node:sqlite is still flagged experimental by Node. It prints a warning on
// every boot; we filter that one specifically and leave everything else
// alone (see silenceSqliteWarning below).
const fs = require('fs');
const path = require('path');

function silenceSqliteWarning() {
  const forwarded = process.listeners('warning').slice();
  process.removeAllListeners('warning');
  process.on('warning', (w) => {
    if (w && w.name === 'ExperimentalWarning' && /SQLite/i.test(w.message)) return;
    forwarded.forEach((fn) => { try { fn(w); } catch (e) { /* listener threw */ } });
  });
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rooms (
  code        TEXT PRIMARY KEY,
  host_id     TEXT,
  host_token  TEXT,
  dj_only     INTEGER NOT NULL DEFAULT 0,
  banned      TEXT    NOT NULL DEFAULT '[]',
  track       TEXT,
  queue       TEXT    NOT NULL DEFAULT '[]',
  history     TEXT    NOT NULL DEFAULT '[]',
  chat        TEXT    NOT NULL DEFAULT '[]',
  is_playing  INTEGER NOT NULL DEFAULT 0,
  position    REAL    NOT NULL DEFAULT 0,
  speed       REAL    NOT NULL DEFAULT 1,
  seq         INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  last_active INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS uploads (
  name       TEXT PRIMARY KEY,
  bytes      INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
`;

function json(value, fallback) {
  if (value == null) return fallback;
  try { return JSON.parse(value); } catch (e) { return fallback; }
}

function open(dir) {
  silenceSqliteWarning();
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'syncbeat.db'));
  db.exec(SCHEMA);

  // ---- legacy import: a rooms.json from before this existed
  const legacy = path.join(dir, 'rooms.json');
  const imported = countRooms(db);
  if (imported === 0 && fs.existsSync(legacy)) {
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(legacy, 'utf8')); } catch (e) {
      console.error('could not read legacy rooms.json:', e.message);
    }
    const put = db.prepare(
      'INSERT OR REPLACE INTO rooms (code, host_id, host_token, dj_only, banned, track, queue,' +
      ' history, chat, is_playing, position, speed, seq, created_at, updated_at, last_active)' +
      ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    let n = 0;
    for (const [code, s] of Object.entries(saved)) {
      if (!code || !s) continue;
      put.run(
        code, s.hostId || null, typeof s.hostToken === 'string' ? s.hostToken : null,
        s.djOnly ? 1 : 0,
        JSON.stringify(Array.isArray(s.banned) ? s.banned.slice(0, 200) : []),
        s.track ? JSON.stringify(s.track) : null,
        JSON.stringify(Array.isArray(s.queue) ? s.queue : []),
        JSON.stringify(Array.isArray(s.history) ? s.history : []),
        JSON.stringify(Array.isArray(s.chat) ? s.chat : []),
        s.isPlaying ? 1 : 0,
        typeof s.position === 'number' ? s.position : 0,
        typeof s.speed === 'number' ? s.speed : 1,
        0,
        s.createdAt || Date.now(), s.updatedAt || Date.now(), s.lastActive || Date.now());
      n++;
    }
    // Park it rather than delete: the import is idempotent only while the
    // database is empty, and someone may want the original back.
    if (n) {
      try { fs.renameSync(legacy, legacy + '.imported'); } catch (e) { /* leave it */ }
      console.log('imported rooms from rooms.json:', n);
    }
  }

  const stmts = {
    all: db.prepare('SELECT * FROM rooms'),    get: db.prepare('SELECT * FROM rooms WHERE code = ?'),
    del: db.prepare('DELETE FROM rooms WHERE code = ?'),
    put: db.prepare(
      'INSERT OR REPLACE INTO rooms (code, host_id, host_token, dj_only, banned, track, queue,' +
      ' history, chat, is_playing, position, speed, seq, created_at, updated_at, last_active)' +
      ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'),
    uploadAdd: db.prepare('INSERT OR REPLACE INTO uploads (name, bytes, created_at) VALUES (?,?,?)'),
    uploadDel: db.prepare('DELETE FROM uploads WHERE name = ?'),
    uploads: db.prepare('SELECT name, bytes FROM uploads'),
    uploadTotal: db.prepare('SELECT COALESCE(SUM(bytes), 0) AS total FROM uploads'),
  };

  // Files already on disk from before this table existed (or left by a crash
  // between the write and the insert) would otherwise be invisible to the
  // size cap and un-sweepable. Adopt them.
  (function adoptOrphanUploads() {
    const uploadDir = path.join(dir, 'uploads');
    let files;
    try { files = fs.readdirSync(uploadDir); } catch (e) { return; }
    const known = new Set(stmts.uploads.all().map((r) => r.name));
    for (const name of files) {
      if (known.has(name)) continue;
      try {
        const st = fs.statSync(path.join(uploadDir, name));
        if (!st.isFile()) continue;
        stmts.uploadAdd.run(name, st.size, Math.round(st.mtimeMs || Date.now()));
      } catch (e) { /* raced with a sweep */ }
    }
  })();

  return {
    allRooms() {
      const out = {};
      for (const row of stmts.all.all()) {
        out[row.code] = {
          hostId: row.host_id || null,
          hostToken: row.host_token || null,
          djOnly: !!row.dj_only,
          banned: json(row.banned, []),
          track: json(row.track, null),
          queue: json(row.queue, []),
          history: json(row.history, []),
          chat: json(row.chat, []),
          isPlaying: !!row.is_playing,
          position: typeof row.position === 'number' ? row.position : 0,
          speed: row.speed,
          seq: row.seq || 0,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          lastActive: row.last_active,
        };
      }
      return out;
    },
    putRoom(code, room) {
      stmts.put.run(
        code, room.hostId || null, room.hostToken || null,
        room.djOnly ? 1 : 0,
        JSON.stringify((room.banned || []).slice(0, 200)),
        room.track ? JSON.stringify(room.track) : null,
        JSON.stringify((room.queue || []).slice(0, 100)),
        JSON.stringify((room.history || []).slice(-30)),
        JSON.stringify((room.chat || []).slice(-100)),
        room.isPlaying ? 1 : 0,
        room.position || 0,
        room.speed,
        room.seq || 0,
        room.createdAt || Date.now(),
        room.updatedAt || Date.now(),
        room.lastActive || Date.now());
    },
    deleteRoom(code) { stmts.del.run(code); },
    addUpload(name, bytes) { stmts.uploadAdd.run(name, bytes, Date.now()); },
    removeUpload(name) { stmts.uploadDel.run(name); },
    uploads() { return stmts.uploads.all().map((r) => ({ name: r.name, bytes: r.bytes })); },
    uploadBytes() { return stmts.uploadTotal.get().total || 0; },
    close() { try { db.close(); } catch (e) { /* already closed */ } },
  };
}

function countRooms(db) {
  try { return db.prepare('SELECT COUNT(*) AS n FROM rooms').get().n; } catch (e) { return 0; }
}

module.exports = { open };
