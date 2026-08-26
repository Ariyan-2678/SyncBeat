// server.js — Sync Music Rooms
// Express serves the static frontend; Socket.IO handles real-time room sync.

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// In-memory room state.
// rooms[code] = { host, users:Set, track:{type,url}|null, isPlaying, position, updatedAt }
const rooms = {};

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  let code;
  do {
    code = '';
    for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms[code]);
  return code;
}

// Estimate the current playback position for a late-joining client.
function currentPosition(room) {
  if (!room.track) return 0;
  if (!room.isPlaying) return room.position;
  const elapsed = (Date.now() - room.updatedAt) / 1000;
  return room.position + elapsed;
}

function roomState(room) {
  return {
    track: room.track,
    isPlaying: room.isPlaying,
    position: currentPosition(room),
    users: room.users.size,
  };
}

io.on('connection', (socket) => {
  let joinedCode = null;

  socket.on('create-room', (cb) => {
    const code = makeCode();
    rooms[code] = {
      host: socket.id,
      users: new Set([socket.id]),
      track: null,
      isPlaying: false,
      position: 0,
      updatedAt: Date.now(),
    };
    joinedCode = code;
    socket.join(code);
    if (typeof cb === 'function') cb({ ok: true, code, isHost: true });
    io.to(code).emit('room-users', rooms[code].users.size);
  });

  socket.on('join-room', (code, cb) => {
    code = (code || '').toUpperCase().trim();
    const room = rooms[code];
    if (!room) {
      if (typeof cb === 'function') cb({ ok: false, error: 'Room not found' });
      return;
    }
    room.users.add(socket.id);
    joinedCode = code;
    socket.join(code);
    if (typeof cb === 'function') {
      cb({ ok: true, code, isHost: room.host === socket.id, state: roomState(room) });
    }
    io.to(code).emit('room-users', room.users.size);
  });

  // Anyone can load a track for the whole room.
  socket.on('load-track', ({ type, url }) => {
    const room = rooms[joinedCode];
    if (!room) return;
    room.track = { type, url };
    room.isPlaying = false;
    room.position = 0;
    room.updatedAt = Date.now();
    io.to(joinedCode).emit('load-track', room.track);
  });

  socket.on('play', (position) => {
    const room = rooms[joinedCode];
    if (!room) return;
    room.isPlaying = true;
    if (typeof position === 'number') room.position = position;
    room.updatedAt = Date.now();
    socket.to(joinedCode).emit('play', room.position);
  });

  socket.on('pause', (position) => {
    const room = rooms[joinedCode];
    if (!room) return;
    room.isPlaying = false;
    if (typeof position === 'number') room.position = position;
    room.updatedAt = Date.now();
    socket.to(joinedCode).emit('pause', room.position);
  });

  socket.on('seek', (position) => {
    const room = rooms[joinedCode];
    if (!room) return;
    if (typeof position === 'number') room.position = position;
    room.updatedAt = Date.now();
    socket.to(joinedCode).emit('seek', room.position);
  });

  // Periodic sync heartbeat from any client keeps late/lagging peers aligned.
  socket.on('sync-request', (cb) => {
    const room = rooms[joinedCode];
    if (!room) return;
    if (typeof cb === 'function') cb(roomState(room));
  });

  socket.on('disconnect', () => {
    const room = rooms[joinedCode];
    if (!room) return;
    room.users.delete(socket.id);
    if (room.users.size === 0) {
      delete rooms[joinedCode];
      return;
    }
    // Reassign host if the host left.
    if (room.host === socket.id) {
      room.host = room.users.values().next().value;
    }
    io.to(joinedCode).emit('room-users', room.users.size);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Sync Music Rooms running on http://localhost:${PORT}`);
});
