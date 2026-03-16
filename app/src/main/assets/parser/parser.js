const net = require('net');
const fs = require('fs');
const path = require('path');
const patterns = require('./patterns');

const SOCKET_PATH = process.env.PARSER_SOCKET
  || `${process.env.HOME}/.claude-mobile/parser.sock`;

try { fs.unlinkSync(SOCKET_PATH); } catch {}
fs.mkdirSync(path.dirname(SOCKET_PATH), { recursive: true });

let clientSocket = null;
let inputBuffer = '';

// State machine
let mode = 'NORMAL'; // NORMAL | IN_TOOL | IN_DIFF | IN_CODE_BLOCK | IN_ERROR
let stateData = {};   // context for current mode

function emit(event) {
  if (clientSocket && !clientSocket.destroyed) {
    clientSocket.write(JSON.stringify(event) + '\n');
  }
}

function clean(line) {
  return line.replace(patterns.ansiStrip, '').trim();
}

function exitMode() {
  const prev = mode;
  const data = stateData;
  mode = 'NORMAL';
  stateData = {};

  // Emit closing events
  if (prev === 'IN_TOOL') {
    emit({ type: 'tool_end', tool: data.tool || '' });
  } else if (prev === 'IN_DIFF') {
    emit({
      type: 'diff_block',
      filename: data.filename || '',
      hunks: data.hunks || [],
    });
  } else if (prev === 'IN_CODE_BLOCK') {
    emit({
      type: 'code_block',
      language: data.language || '',
      code: (data.lines || []).join('\n'),
    });
  } else if (prev === 'IN_ERROR') {
    emit({
      type: 'error',
      message: data.message || '',
      details: (data.lines || []).join('\n'),
    });
  }
}

function processLine(rawLine) {
  const cleanLine = clean(rawLine);
  if (!cleanLine && mode === 'NORMAL') return;

  // --- Mode-specific processing ---

  if (mode === 'IN_CODE_BLOCK') {
    if (patterns.codeBlockEnd.test(cleanLine)) {
      exitMode();
    } else {
      stateData.lines = stateData.lines || [];
      stateData.lines.push(cleanLine);
    }
    return;
  }

  if (mode === 'IN_DIFF') {
    if (patterns.diffLine.test(cleanLine) || patterns.diffHunk.test(cleanLine)) {
      const currentHunk = stateData.hunks[stateData.hunks.length - 1];
      if (currentHunk) currentHunk.lines += cleanLine + '\n';
      return;
    }
    // Line doesn't look like diff anymore — exit
    exitMode();
    // Fall through to process this line in NORMAL mode
  }

  if (mode === 'IN_ERROR') {
    // Stack trace continuation
    const isStackLine = patterns.errorPatterns.some(p => p.test(cleanLine));
    if (isStackLine || /^\s+at\s/.test(cleanLine)) {
      stateData.lines = stateData.lines || [];
      stateData.lines.push(cleanLine);
      return;
    }
    if (cleanLine === '') {
      exitMode();
      return;
    }
    exitMode();
    // Fall through
  }

  if (mode === 'IN_TOOL') {
    // Tool output continues until we see another tool or blank lines
    if (cleanLine === '') {
      stateData.blankCount = (stateData.blankCount || 0) + 1;
      if (stateData.blankCount >= 2) exitMode();
      return;
    }
    stateData.blankCount = 0;
    // Check if a new tool starts
    for (const p of patterns.toolStart) {
      if (p.test(cleanLine)) {
        exitMode();
        // Fall through to process as new tool
        break;
      }
    }
    if (mode === 'IN_TOOL') {
      // Still in tool output — emit as text within tool context
      emit({ type: 'text', text: cleanLine });
      return;
    }
  }

  // --- NORMAL mode classification ---

  // Approval prompts (aggressive)
  for (const p of patterns.approval) {
    const m = cleanLine.match(p);
    if (m) {
      emit({ type: 'approval_prompt', tool: '', summary: m[1] || cleanLine });
      return;
    }
  }

  // OAuth URLs (aggressive)
  for (const p of patterns.oauthUrl) {
    const m = cleanLine.match(p);
    if (m) {
      const url = m[1] || cleanLine.match(/https?:\/\/[^\s]+/)?.[0] || '';
      if (url) {
        emit({ type: 'oauth_redirect', url });
        return;
      }
    }
  }

  // Confirmation prompts (aggressive)
  for (const p of patterns.confirmation) {
    if (p.test(cleanLine)) {
      emit({ type: 'confirmation', question: cleanLine });
      return;
    }
  }

  // Interactive menu detection (aggressive)
  for (const p of patterns.interactiveMenu) {
    if (p.test(cleanLine)) {
      emit({ type: 'interactive_menu', raw: cleanLine });
      return;
    }
  }

  // Tool start (conservative)
  for (const p of patterns.toolStart) {
    const m = cleanLine.match(p);
    if (m) {
      emit({ type: 'tool_start', tool: m[1], args: cleanLine.slice(m[0].length) });
      mode = 'IN_TOOL';
      stateData = { tool: m[1], blankCount: 0 };
      return;
    }
  }

  // Diff header (conservative)
  if (patterns.diffHeader.test(cleanLine)) {
    stateData = { pendingDiffMinus: cleanLine };
    // Wait for +++ line to confirm
    mode = 'NORMAL'; // stay normal, check next line
    return;
  }
  if (stateData.pendingDiffMinus && patterns.diffHeaderPlus.test(cleanLine)) {
    const filename = cleanLine.replace(/^\+\+\+\s+/, '').replace(/^[ab]\//, '');
    mode = 'IN_DIFF';
    stateData = { filename, hunks: [{ header: '', lines: '' }] };
    return;
  }
  stateData.pendingDiffMinus = null;

  // Code block fence (conservative)
  const fenceMatch = cleanLine.match(patterns.codeBlockFence);
  if (fenceMatch && !patterns.codeBlockEnd.test(cleanLine)) {
    mode = 'IN_CODE_BLOCK';
    stateData = { language: fenceMatch[1] || '', lines: [] };
    return;
  }

  // Error patterns (conservative)
  for (const p of patterns.errorPatterns) {
    if (p.test(cleanLine)) {
      mode = 'IN_ERROR';
      stateData = { message: cleanLine, lines: [cleanLine] };
      return;
    }
  }

  // Progress patterns (conservative)
  for (const p of patterns.progressPatterns) {
    if (p.test(cleanLine)) {
      emit({ type: 'progress', message: cleanLine });
      return;
    }
  }

  // Default: text
  emit({ type: 'text', text: cleanLine });
}

function processBuffer() {
  const lines = inputBuffer.split('\n');
  inputBuffer = lines.pop() || '';
  for (const line of lines) {
    processLine(line);
  }
}

const server = net.createServer((socket) => {
  clientSocket = socket;
  socket.on('data', (data) => {
    inputBuffer += data.toString();
    processBuffer();
  });
  socket.on('end', () => { clientSocket = null; });
  socket.on('error', () => { clientSocket = null; });
});

server.listen(SOCKET_PATH, () => {
  console.error(`Parser listening on ${SOCKET_PATH}`);
});

process.on('SIGTERM', () => {
  if (mode !== 'NORMAL') exitMode();
  server.close();
  try { fs.unlinkSync(SOCKET_PATH); } catch {}
  process.exit(0);
});
