// Windows cannot deliver a signal to a child process — child.kill('SIGTERM')
// there is a hard TerminateProcess, so the shutdown handlers in server.js
// would never run and the flush could not be tested. This wrapper boots
// server.js as usual and then, when the test drops the flag file named by
// SB_SIG_FLAG, raises SIGTERM on its own behalf: process.emit() runs exactly
// the listeners server.js registered, which is the code under test.
//
// POSIX runs use the real signal instead; this file is only used as a
// fallback so the same assertion holds on every platform.
require('../server.js');

const fs = require('fs');
const flag = process.env.SB_SIG_FLAG;
if (flag) {
  setInterval(() => {
    try { if (fs.existsSync(flag)) process.emit('SIGTERM'); } catch (e) { /* gone */ }
  }, 50);
}
