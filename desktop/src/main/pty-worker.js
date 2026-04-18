#!/usr/bin/env node
// PTY Worker — runs in a separate Node.js process (not Electron)
// so that node-pty uses Node's native binary, not Electron's.
// Communicates with the Electron main process via IPC (process.send).

const pty = require('node-pty');
const path = require('path');
const fs = require('fs');

// Resolve a command to its absolute path by searching PATH (+ PATHEXT on Windows).
// Uses only Node builtins — the `which` npm package is unavailable here because it
// lives inside the asar archive, which this child process can't read.
// On macOS/Linux, pty.spawn can resolve bare command names via execvp, but Windows
// ConPTY cannot — it needs an absolute path. This function handles both platforms.
function resolveCommand(cmd) {
  // On Windows, check PATHEXT extensions (.cmd, .exe, etc.)
  // On Unix, just check the bare name (extensions array = [''])
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').toLowerCase().split(';')
    : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    for (const ext of extensions) {
      const full = path.join(dir, cmd + ext);
      if (fs.existsSync(full)) return full;
    }
  }
  return cmd; // fallback to bare name (works on macOS/Linux via execvp)
}

let ptyProcess = null;

process.on('message', (msg) => {
  switch (msg.type) {
    case 'spawn': {
      // Resolve full path — node-pty on Windows needs it (no shell lookup)
      const shell = resolveCommand(msg.command || 'claude');
      const args = msg.args || [];
      ptyProcess = pty.spawn(shell, args, {
        name: 'xterm-256color',
        cols: msg.cols || 120,
        rows: msg.rows || 30,
        cwd: msg.cwd || require('os').homedir(),
        env: {
          ...process.env,
          // Pass our session ID so hook scripts can include it in payloads
          CLAUDE_DESKTOP_SESSION_ID: msg.sessionId || '',
          // Pass the unique pipe name so relay.js connects to the right instance
          CLAUDE_DESKTOP_PIPE: msg.pipeName || '',
        },
      });

      ptyProcess.onData((data) => {
        process.send({ type: 'data', data });
      });

      ptyProcess.onExit(({ exitCode }) => {
        process.send({ type: 'exit', exitCode });
        process.exit(0);
      });

      process.send({ type: 'spawned', pid: ptyProcess.pid });
      break;
    }
    case 'input': {
      // Two stacked fixes for Windows ConPTY + Ink paste handling:
      //
      // (A) Atomic-write-then-Enter bug: Claude Code's Ink has a 500ms
      //     PASTE_TIMEOUT that treats bulk writes as one paste event and
      //     swallows a trailing \r. Split "content + trailing \r" into two
      //     writes with ENTER_DELAY_MS > PASTE_TIMEOUT so Enter arrives as
      //     a distinct keystroke that submits.
      //
      // (B) ConPTY input-buffer truncation: Windows ConPTY drops bytes when
      //     a single write exceeds its buffer (symptom: paste >~600 chars →
      //     only the tail reaches Claude). Chunk writes >CHUNK_SIZE into
      //     small pieces with CHUNK_DELAY_MS gaps so ConPTY can drain
      //     between them. Each gap must stay < 500ms PASTE_TIMEOUT so Ink
      //     continues treating the stream as one paste. 64-byte / 50ms was
      //     the smallest/slowest config that reliably delivered 2500+ chars
      //     end-to-end in manual testing; 128/30ms and 256/10ms both still
      //     dropped middle sections.
      //
      // Single-char writes, escape sequences without trailing \r, and
      // bracketed-paste data (\x1b[200~...\x1b[201~) pass through untouched.
      if (!ptyProcess) break;
      const text = msg.data;
      const CHUNK_SIZE = 64;
      const CHUNK_DELAY_MS = 50;
      const ENTER_DELAY_MS = 600;

      const writeChunked = (body, onDone) => {
        if (body.length <= CHUNK_SIZE) {
          ptyProcess.write(body);
          if (onDone) setTimeout(onDone, 0);
          return;
        }
        let offset = 0;
        const sendNext = () => {
          if (!ptyProcess) return;
          const end = Math.min(offset + CHUNK_SIZE, body.length);
          ptyProcess.write(body.slice(offset, end));
          offset = end;
          if (offset < body.length) setTimeout(sendNext, CHUNK_DELAY_MS);
          else if (onDone) setTimeout(onDone, 0);
        };
        sendNext();
      };

      if (typeof text === 'string' && text.length > 1 && text.endsWith('\r')) {
        const preamble = text.slice(0, -1);
        writeChunked(preamble, () => {
          setTimeout(() => { if (ptyProcess) ptyProcess.write('\r'); }, ENTER_DELAY_MS);
        });
      } else if (typeof text === 'string' && text.length > CHUNK_SIZE) {
        writeChunked(text);
      } else {
        ptyProcess.write(text);
      }
      break;
    }
    case 'resize': {
      if (ptyProcess) ptyProcess.resize(msg.cols, msg.rows);
      break;
    }
    case 'kill': {
      if (ptyProcess) ptyProcess.kill();
      break;
    }
  }
});

process.on('disconnect', () => {
  if (ptyProcess) ptyProcess.kill();
  process.exit(0);
});
