// REFERENCE COPY — the canonical version is the WRAPPER_JS constant in PtyBridge.kt.
// PtyBridge.start() deploys WRAPPER_JS to ~/.claude-mobile/claude-wrapper.js at
// every launch. This file exists only for readability / version control.
//
// If you edit this file, also update WRAPPER_JS in PtyBridge.kt (and vice versa).
//
// ARCHITECTURE (post-termux-exec-fix):
// termux-exec LD_PRELOAD handles ALL exec routing through linker64 for C/Rust
// programs (the vast majority of subprocess calls). This wrapper no longer does
// exec routing — it only handles Android/Claude Code quirks that termux-exec
// cannot: /tmp path rewriting, fs.accessSync X_OK bypass, shell path fixing,
// -l flag stripping, BASH_ENV injection, and xdg-open/browser-open interception.
//
// Go programs (gh, fzf, micro) bypass termux-exec via raw syscalls and are
// handled by custom bash wrappers in linker64-env.sh instead.

'use strict';
var child_process = require('child_process');
var fs = require('fs');
var PREFIX = process.env.PREFIX || '';
var BASH_ENV_FILE = process.env.BASH_ENV || '';
var HOME = process.env.HOME || '';
var TERMUX_PREFIX = '/data/data/com.termux/files/usr';
// Android has two paths to the same app directory: /data/user/0/pkg/ and /data/data/pkg/
var ALT_PREFIX = '';
if (PREFIX.indexOf('/data/user/0/') === 0) ALT_PREFIX = '/data/data/' + PREFIX.substring('/data/user/0/'.length);
else if (PREFIX.indexOf('/data/data/') === 0) ALT_PREFIX = '/data/user/0/' + PREFIX.substring('/data/data/'.length);
var BROWSER_OPEN = HOME + '/.claude-mobile/browser-open';

// --- /tmp rewriting (Android has no /tmp) ---
function fixTmp(p) {
    if (typeof p === 'string') {
        if (p === '/tmp') return HOME + '/tmp';
        if (p.startsWith('/tmp/')) return HOME + '/tmp/' + p.substring(5);
        if (p === '/var/tmp') return HOME + '/tmp';
        if (p.startsWith('/var/tmp/')) return HOME + '/tmp/' + p.substring(9);
    }
    return p;
}
function fixTmpArgs(args) {
    if (!Array.isArray(args)) return args;
    return args.map(function(a) { return typeof a === 'string' ? fixTmp(a) : a; });
}
function fixTmpInShellCmd(cmd) {
    if (typeof cmd !== 'string') return cmd;
    return cmd.replace(/(^|[\s=:])\/tmp\b/g, '$1' + HOME + '/tmp').replace(/(^|[\s=:])\/var\/tmp\b/g, '$1' + HOME + '/tmp');
}

// --- Prefix rewriting (Termux hardcoded paths → our prefix) ---
function isEB(f) { return f && (PREFIX && f.startsWith(PREFIX + '/') || f.startsWith(TERMUX_PREFIX + '/') || (ALT_PREFIX && f.startsWith(ALT_PREFIX + '/'))); }
function fixPath(f) {
    if (f.startsWith(TERMUX_PREFIX + '/')) return PREFIX + f.substring(TERMUX_PREFIX.length);
    if (ALT_PREFIX && f.startsWith(ALT_PREFIX + '/')) return PREFIX + f.substring(ALT_PREFIX.length);
    return f;
}

// --- Shell path fixing (Termux Node.js has hardcoded shell path) ---
function fixShell(s) { if (s === true) return PREFIX + '/bin/bash'; return (typeof s === 'string' && isEB(s)) ? fixPath(s) : s; }
function fixOpts(o) { if (o && o.shell != null && o.shell !== false) { var s = fixShell(o.shell); if (s !== o.shell) return Object.assign({}, o, {shell: s}); } return o; }
function fixExecShell(o) {
    o = Object.assign({}, o || {});
    if (!o.shell || o.shell === true) o.shell = PREFIX + '/bin/bash';
    else if (typeof o.shell === 'string' && isEB(o.shell)) o.shell = fixPath(o.shell);
    return o;
}

// --- fs.accessSync X_OK bypass (SELinux denies execute check on app data) ---
var _as = fs.accessSync;
fs.accessSync = function(p, m) {
    p = fixTmp(p);
    if (isEB(p) && m !== undefined && (m & fs.constants.X_OK)) return _as.call(this, fixPath(p), fs.constants.R_OK);
    var a = Array.prototype.slice.call(arguments); a[0] = p;
    return _as.apply(this, a);
};

// --- fs /tmp patching (sync + async + streams) ---
['writeFileSync','readFileSync','existsSync','statSync','lstatSync','readdirSync',
 'mkdirSync','unlinkSync','rmdirSync','chmodSync','renameSync','copyFileSync'].forEach(function(m) {
    var orig = fs[m]; if (!orig) return;
    fs[m] = function() { var a = Array.prototype.slice.call(arguments); if (typeof a[0] === 'string') a[0] = fixTmp(a[0]); if (m === 'renameSync' || m === 'copyFileSync') { if (typeof a[1] === 'string') a[1] = fixTmp(a[1]); } return orig.apply(this, a); };
});
['writeFile','readFile','stat','lstat','readdir','mkdir','unlink','rmdir','chmod','rename','copyFile','access'].forEach(function(m) {
    var orig = fs[m]; if (!orig) return;
    fs[m] = function() { var a = Array.prototype.slice.call(arguments); if (typeof a[0] === 'string') a[0] = fixTmp(a[0]); if ((m === 'rename' || m === 'copyFile') && typeof a[1] === 'string') a[1] = fixTmp(a[1]); return orig.apply(this, a); };
});
var _openSync = fs.openSync; fs.openSync = function(p) { var a = Array.prototype.slice.call(arguments); a[0] = fixTmp(a[0]); return _openSync.apply(this, a); };
var _open = fs.open; fs.open = function(p) { var a = Array.prototype.slice.call(arguments); a[0] = fixTmp(a[0]); return _open.apply(this, a); };
var _cws = fs.createWriteStream; fs.createWriteStream = function(p) { var a = Array.prototype.slice.call(arguments); if (typeof a[0] === 'string') a[0] = fixTmp(a[0]); return _cws.apply(this, a); };
var _crs = fs.createReadStream; fs.createReadStream = function(p) { var a = Array.prototype.slice.call(arguments); if (typeof a[0] === 'string') a[0] = fixTmp(a[0]); return _crs.apply(this, a); };

// --- Bash quirk helpers ---
function stripLogin(args) { return args.filter(function(a) { return a !== '-l'; }); }
function injectEnv(cmd, args) {
    if (BASH_ENV_FILE && cmd.endsWith('/bash') && Array.isArray(args) && args[0] === '-c' && args.length >= 2) {
        args = args.slice();
        args[1] = '. "' + BASH_ENV_FILE + '" 2>/dev/null; ' + args[1];
    }
    return args;
}

// --- Browser-open interception (Android has no xdg-open) ---
function isBrowserOpen(name) {
    var fn = String(name).replace(/^.*\//, '');
    return fn === 'xdg-open' || fn === 'open' || fn === 'browser-open' || String(name).endsWith('/browser-open');
}
function handleBrowserOpen(args) {
    var a = Array.isArray(args) ? args : [];
    var url = a.find(function(x) { return typeof x === 'string' && x.startsWith('http'); });
    if (url) { try { fs.writeFileSync(HOME + '/.claude-mobile/open-url', url); } catch(e) {} return true; }
    return false;
}

// --- child_process patches ---
// These no longer route through linker64 (termux-exec handles that via LD_PRELOAD).
// They only fix /tmp paths, -l flags, BASH_ENV injection, shell paths, and browser-open.

var _efs = child_process.execFileSync;
child_process.execFileSync = function(file) {
    if (isBrowserOpen(file)) {
        var a0 = arguments.length > 1 && Array.isArray(arguments[1]) ? arguments[1] : [];
        if (handleBrowserOpen(a0)) return Buffer.alloc(0);
    }
    file = fixTmp(file);
    if (isEB(file)) file = fixPath(file);
    var args = arguments.length > 1 && Array.isArray(arguments[1]) ? arguments[1] : [];
    var opts = arguments.length > 1 && Array.isArray(arguments[1]) ? arguments[2] : arguments[1];
    if (file.endsWith('/bash') || file.endsWith('/sh')) {
        args = stripLogin(args);
        var ci = args.indexOf('-c');
        if (ci !== -1 && ci + 1 < args.length && typeof args[ci + 1] === 'string') { args = args.slice(); args[ci + 1] = fixTmpInShellCmd(args[ci + 1]); }
    }
    args = fixTmpArgs(args);
    args = injectEnv(file, args);
    return _efs.call(this, file, args, opts);
};

var _ef = child_process.execFile;
child_process.execFile = function(file) {
    if (isBrowserOpen(file)) {
        var rest0 = Array.prototype.slice.call(arguments, 1);
        var a0 = rest0.length > 0 && Array.isArray(rest0[0]) ? rest0[0] : [];
        if (handleBrowserOpen(a0)) {
            var cb0 = rest0.find(function(x) { return typeof x === 'function'; });
            if (cb0) cb0(null, '', '');
            return;
        }
    }
    file = fixTmp(file);
    if (isEB(file)) file = fixPath(file);
    var rest = Array.prototype.slice.call(arguments, 1);
    var args = rest.length > 0 && Array.isArray(rest[0]) ? rest[0] : [];
    var remaining = rest.length > 0 && Array.isArray(rest[0]) ? rest.slice(1) : rest;
    if (file.endsWith('/bash') || file.endsWith('/sh')) {
        args = stripLogin(args);
        var ci = args.indexOf('-c');
        if (ci !== -1 && ci + 1 < args.length && typeof args[ci + 1] === 'string') { args = args.slice(); args[ci + 1] = fixTmpInShellCmd(args[ci + 1]); }
    }
    args = fixTmpArgs(args);
    args = injectEnv(file, args);
    return _ef.apply(this, [file, args].concat(remaining));
};

function spawnFix(orig, command, args, options) {
    if (isBrowserOpen(command)) {
        var urlArgs = Array.isArray(args) ? args : [];
        if (handleBrowserOpen(urlArgs)) return orig.call(this, '/system/bin/sh', ['-c', 'true'], {});
    }
    command = fixTmp(String(command));
    if (isEB(command)) command = fixPath(command);
    var o = Array.isArray(args) ? options : args;
    var hasShell = o && o.shell && o.shell !== false;
    // Fix shell path for shell:true (Termux Node has hardcoded path)
    if (hasShell) {
        var fo = fixOpts(o);
        if (Array.isArray(args)) return orig.call(this, command, fixTmpArgs(args), fo);
        return orig.call(this, command, fo);
    }
    // No shell — fix args for bash/sh invocations
    var actualArgs = Array.isArray(args) ? args : [];
    if (command.endsWith('/bash') || command.endsWith('/sh')) {
        actualArgs = stripLogin(actualArgs);
        var ci = actualArgs.indexOf('-c');
        if (ci !== -1 && ci + 1 < actualArgs.length && typeof actualArgs[ci + 1] === 'string') {
            actualArgs = actualArgs.slice();
            actualArgs[ci + 1] = fixTmpInShellCmd(actualArgs[ci + 1]);
        }
    }
    actualArgs = fixTmpArgs(actualArgs);
    actualArgs = injectEnv(command, actualArgs);
    return orig.call(this, command, actualArgs, o);
}

var _sp = child_process.spawn;
child_process.spawn = function(command, args, options) { return spawnFix.call(this, _sp, command, args, options); };
var _sps = child_process.spawnSync;
child_process.spawnSync = function(command, args, options) { return spawnFix.call(this, _sps, command, args, options); };

// exec/execSync always use a shell — fix the shell path
var _exec = child_process.exec;
child_process.exec = function(cmd, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = undefined; }
    var m = typeof cmd === 'string' && cmd.match(/^(?:.*\/)?(?:xdg-open|open|browser-open)\s+(https?:\/\/\S+)/);
    if (m) { try { fs.writeFileSync(HOME + '/.claude-mobile/open-url', m[1]); } catch(e) {} cmd = 'true'; }
    return _exec.call(this, fixTmpInShellCmd(cmd), fixExecShell(opts), cb);
};
var _execSync = child_process.execSync;
child_process.execSync = function(cmd, opts) {
    var m2 = typeof cmd === 'string' && cmd.match(/^(?:.*\/)?(?:xdg-open|open|browser-open)\s+(https?:\/\/\S+)/);
    if (m2) { try { fs.writeFileSync(HOME + '/.claude-mobile/open-url', m2[1]); } catch(e) {} cmd = 'true'; }
    return _execSync.call(this, fixTmpInShellCmd(cmd), fixExecShell(opts));
};

var cliPath = process.argv[2];
if (!cliPath) { process.stderr.write('claude-wrapper: missing CLI path\n'); process.exit(1); }
process.argv = [process.argv[0], cliPath].concat(process.argv.slice(3));
require(cliPath);
