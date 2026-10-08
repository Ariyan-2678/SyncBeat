// echo.js — deciding what a media event means.
//
// The player fires 'play' / 'pause' / 'seeked' for two completely different
// reasons and the difference matters:
//
//   1. the local user pressed a button  -> tell the room, as a fresh command
//   2. the player is reacting to a command that just arrived from the server
//      (or to us swapping tracks)       -> do not bounce it back
//
// Getting (2) wrong as (1) makes N clients pass the same command around the
// room, and a late one can undo a newer instruction — the host pauses and a
// buffering client's delayed 'play' resumes everyone. Getting (1) wrong as
// (2) silently eats the user's own button press.
//
// So there are two short-lived lists:
//   echoes — we expect this because we are applying a SERVER command. The
//            event is sent back tagged with that command's seq, letting the
//            server drop it if the room has already moved on.
//   drops  — we expect this because WE swapped tracks or left the room. The
//            server already knows, so the event is not sent at all. Kept
//            short on purpose: a longer window would swallow real clicks.
//
// Whatever matches neither list is a genuine local action.
//
// Exposed as a browser global and as a CommonJS module so this decision logic
// can be unit-tested without a media element.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SyncEcho = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ECHO_MS = 6000; // a buffering player can take this long to report in
  const DROP_MS = 900;  // teardown events fire almost immediately

  function create() {
    let echoes = [];
    let drops = [];

    function take(list, kind) {
      const now = Date.now();
      for (let i = 0; i < list.length; i++) {
        if (list[i].until < now) { list.splice(i, 1); i--; continue; }
        if (list[i].kind === kind) return list.splice(i, 1)[0];
      }
      return null;
    }
    function push(list, kinds, ms, seq) {
      const list2 = Array.isArray(kinds) ? kinds : [kinds];
      const until = Date.now() + ms;
      // the newest instruction supersedes any older one of that kind
      for (let i = list.length - 1; i >= 0; i--) {
        if (list2.indexOf(list[i].kind) >= 0) list.splice(i, 1);
      }
      list2.forEach((k) => list.push({ kind: k, seq: seq, until: until }));
    }

    return {
      // We are applying a command that came from the server with this seq;
      // the events it provokes should be reported back tagged with it.
      expectEcho(kinds, seq) { push(echoes, kinds, ECHO_MS, seq); },
      // We caused this ourselves; the events it provokes should be silent.
      expectDrop(kinds) { push(drops, kinds, DROP_MS); },
      // Consume the matching expectation and say what to do with the event.
      resolve(kind) {
        const e = take(echoes, kind);
        if (e) return { send: true, seq: e.seq };
        if (take(drops, kind)) return { send: false, seq: undefined };
        return { send: true, seq: undefined };
      },
      // For events that have no room on the wire at all (track-ended).
      consumeDrop(kind) { return !!take(drops, kind); },
      clear() { echoes = []; drops = []; },
      // introspection for tests
      size() { return { echoes: echoes.length, drops: drops.length }; },
    };
  }

  return { create: create, ECHO_MS: ECHO_MS, DROP_MS: DROP_MS };
});
