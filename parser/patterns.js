const keySequences = {
  arrowUp: '\x1b[A',
  arrowDown: '\x1b[B',
  arrowLeft: '\x1b[D',
  arrowRight: '\x1b[C',
  enter: '\r',
};

module.exports = {
  approval: [
    /Allow\s+(.*?)\s*\?\s*\[?(y\/n|Y\/n|yes\/no)\]?/,
    /Do you want to (.*?)\?\s*\[?(y\/n)\]?/,
    /\? (Allow|Deny|Accept|Reject)/,
    /Press y to allow/i,
  ],
  confirmation: [
    /\?\s*\(y\/n\)\s*$/,
    /Continue\?\s*\[Y\/n\]/i,
    /Are you sure/i,
  ],
  oauthUrl: [
    /https?:\/\/[^\s]+(?:oauth|auth|login|callback)[^\s]*/i,
    /Open this URL[:\s]*(https?:\/\/[^\s]+)/i,
    /Visit[:\s]*(https?:\/\/[^\s]+)/i,
  ],
  interactiveMenu: [
    /[❯›>]\s+\S/,
    /\[\s?[x ]\s?\]/,
    /^\s*\d+[.)]\s+\S/,
  ],
  toolStart: [
    /^(Read|Write|Edit|Bash|Glob|Grep|Agent|Skill|WebFetch|WebSearch|NotebookEdit)\s*[:(]/,
  ],
  diffHeader: /^---\s+\S/,
  diffHeaderPlus: /^\+\+\+\s+\S/,
  diffHunk: /^@@\s/,
  diffLine: /^[+\- ]/,
  codeBlockFence: /^```(\w*)/,
  codeBlockEnd: /^```\s*$/,
  errorPatterns: [
    /^Error:/i,
    /^(TypeError|ReferenceError|SyntaxError|RangeError):/,
    /^\s+at\s+\S+\s+\(/,
    /^ENOENT|EPERM|EACCES/,
  ],
  progressPatterns: [
    /Searching\s+\d+\s+files/i,
    /Reading\s+\d+\s+files/i,
    /Processing\s+\d+/i,
  ],
  ansiStrip: /\x1B(?:\[[0-9;]*[a-zA-Z]|\].*?(?:\x07|\x1B\\))/g,
  keySequences,
};
