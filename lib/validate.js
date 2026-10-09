// validate.js — everything that decides whether a piece of input is usable,
// and the small secrets derived from it. Pure: no sockets, no filesystem, no
// state, so it is the one part of the server that can be reasoned about on
// its own.
const crypto = require('crypto');

// ---------------------------------------------------------- guest identity
// No passwords: the client sends { guestId, displayName }; we validate the
// shape and derive the avatar colour from the name.
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

// ---------------------------------------------------------- tracks
const VALID_TRACK_TYPES = ['audio', 'youtube', 'soundcloud'];
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
function validTrackInput(input, uploadExists) {
  const raw = input || {};
  const type = raw.type;
  if (!VALID_TRACK_TYPES.includes(type) || typeof raw.url !== 'string') return null;
  const url = raw.url.trim();
  if (!url || url.length > 2048) return null;
  if (type === 'youtube') {
    if (!/^[\w-]{11}$/.test(url)) return null;
  } else if (type === 'audio' && UPLOAD_PATH_RE.test(url)) {
    // One of our own uploads. The path is fully server-generated so it cannot
    // escape the uploads directory, but the file still has to be there.
    if (typeof uploadExists === 'function' && !uploadExists(url.slice(8))) return null;
  } else if (!/^https?:\/\//i.test(url)) return null;
  return { type, url };
}
// An upload is addressed as /uploads/<32 hex>.<ext>. Nothing else is ever
// accepted, so the path cannot be walked out of the uploads directory.
const UPLOAD_PATH_RE = /^\/uploads\/[a-f0-9]{32}\.[a-z0-9]{2,5}$/;

function makeTrackItem(input, title, user) {
  return {
    id: rid(),
    type: input.type,
    url: input.url,
    title: cleanTitle(title, input.type === 'youtube' ? 'YouTube · ' + input.url : input.url.slice(0, 80)),
    addedBy: {
      userId: user.id,
      guestId: user.guestId,
      username: user.username,
      ownerId: user.ownerTag, // hash — safe to broadcast, useless without the secret
    },
    addedAt: Date.now(),
    votes: 0,
    voters: [],
  };
}

// ---------------------------------------------------------- queue ownership
// addedBy.ownerTag is a HASH of a per-member secret: it rides along with the
// queue so everyone can see who added what, but only the holder of the secret
// can delete the item. guestId cannot do this job — the client picks it, so
// claiming someone else's is trivial (reproduced before this was added).
const OWNER_SECRET_RE = /^[A-Za-z0-9_-]{24,64}$/;
const ownerTag = (secret) =>
  crypto.createHash('sha256').update(secret).digest('base64url').slice(0, 32);
const newOwnerSecret = () => crypto.randomBytes(24).toString('base64url');
function adoptOwnerSecret(v) {
  return typeof v === 'string' && OWNER_SECRET_RE.test(v) ? v : newOwnerSecret();
}

// ---------------------------------------------------------- room password
// Optional: a room with no password behaves exactly as one with none. Only
// the hash and its per-room salt are kept, and only a boolean is ever
// broadcast, so the password itself never leaves the creator's browser.
const PASSWORD_MAX = 64;
function cleanPassword(p) {
  if (typeof p !== 'string') return null;
  const t = p.trim();
  if (!t) return null;
  return t.slice(0, PASSWORD_MAX);
}
function hashPassword(salt, password) {
  // scrypt rather than a bare digest: this is a guessable secret and a wrong
  // guess should cost more than a comparison. Modest parameters — a room
  // password is not a bank login, and join attempts are already rate-limited.
  return crypto.scryptSync(password, salt, 32, { N: 4096, r: 8, p: 1 }).toString('base64url');
}
function makePassword(password) {
  const salt = crypto.randomBytes(16).toString('base64url');
  return { passwordSalt: salt, passwordHash: hashPassword(salt, password) };
}
function passwordMatches(room, password) {
  if (!room.passwordHash) return true;
  if (!password) return false;
  const want = Buffer.from(room.passwordHash);
  const got = Buffer.from(hashPassword(room.passwordSalt, password));
  // timingSafeEqual throws on a length mismatch, and a stored hash from an
  // older or corrupted row is not worth a crash over.
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

// ---------------------------------------------------------- uploads
const UPLOAD_EXT = new Set(['mp3', 'm4a', 'm4b', 'aac', 'ogg', 'oga', 'opus', 'wav', 'flac', 'weba']);
const EXT_BY_MIME = {
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac',
  'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/webm': 'weba',
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/flac': 'flac',
};
function uploadExtOf(nameHeader, contentType) {
  const type = String(contentType || '').toLowerCase().split(';')[0].trim();
  let name = '';
  try { name = decodeURIComponent(String(nameHeader || '')).trim(); } catch (e) { name = ''; }
  // Browsers label .m4a / .oga inconsistently, so the extension wins when the
  // content-type at least agrees this is audio.
  if (type && type !== 'application/octet-stream' &&
      type.indexOf('audio/') !== 0 && type !== 'video/mp4') return null;
  const m = /\.([A-Za-z0-9]{2,5})$/.exec(name);
  const fromName = m && UPLOAD_EXT.has(m[1].toLowerCase()) ? m[1].toLowerCase() : null;
  return fromName || EXT_BY_MIME[type] || null;
}

module.exports = {
  avatarColor, validDisplayName, validGuestId, rid,
  VALID_TRACK_TYPES, safePos, cleanTitle, cleanChat, validTrackInput,
  UPLOAD_PATH_RE, makeTrackItem,
  ownerTag, newOwnerSecret, adoptOwnerSecret,
  cleanPassword, makePassword, passwordMatches,
  uploadExtOf,
};
