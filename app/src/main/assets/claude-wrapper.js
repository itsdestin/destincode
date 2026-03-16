// REFERENCE COPY — the canonical version is the WRAPPER_JS constant in PtyBridge.kt.
// PtyBridge.start() deploys WRAPPER_JS to ~/.claude-mobile/claude-wrapper.js at
// every launch. This file exists only for readability / version control.
//
// If you edit this file, also update WRAPPER_JS in PtyBridge.kt (and vice versa).

'use strict';
var child_process = require('child_process');
var fs = require('fs');
var LINKER64 = '/system/bin/linker64';
var PREFIX = process.env.PREFIX || '';
var BASH_ENV_FILE = process.env.BASH_ENV || '';
function isEB(f) { return f && PREFIX && f.startsWith(PREFIX + '/'); }
var _as = fs.accessSync;
fs.accessSync = function(p, m) {
    if (isEB(p) && m !== undefined && (m & fs.constants.X_OK)) return _as.call(this, p, fs.constants.R_OK);
    return _as.apply(this, arguments);
};
function injectEnv(cmd, args) {
    if (BASH_ENV_FILE && cmd.endsWith('/bash') && Array.isArray(args) && args[0] === '-c' && args.length >= 2) {
        args = args.slice();
        args[1] = '. "' + BASH_ENV_FILE + '" 2>/dev/null; ' + args[1];
    }
    return args;
}
var _efs = child_process.execFileSync;
child_process.execFileSync = function(file) {
    if (isEB(file)) {
        var args = arguments.length > 1 && Array.isArray(arguments[1]) ? arguments[1] : [];
        var opts = arguments.length > 1 && Array.isArray(arguments[1]) ? arguments[2] : arguments[1];
        args = injectEnv(file, args);
        return _efs.call(this, LINKER64, [file].concat(args), opts);
    }
    return _efs.apply(this, arguments);
};
var _ef = child_process.execFile;
child_process.execFile = function(file) {
    if (isEB(file)) {
        var rest = Array.prototype.slice.call(arguments, 1);
        var args = rest.length > 0 && Array.isArray(rest[0]) ? rest[0] : [];
        var remaining = rest.length > 0 && Array.isArray(rest[0]) ? rest.slice(1) : rest;
        args = injectEnv(file, args);
        return _ef.apply(this, [LINKER64, [file].concat(args)].concat(remaining));
    }
    return _ef.apply(this, arguments);
};
// Strip -l flag from bash args. Claude Code sends ["-c", "-l", cmd] but
// via linker64 bash treats -l as the command string, not an option.
function stripLogin(args) {
    return args.filter(function(a) { return a !== '-l'; });
}
var _sp = child_process.spawn;
child_process.spawn = function(command, args, options) {
    if (isEB(command)) {
        var actualArgs = Array.isArray(args) ? args : [];
        var actualOpts = Array.isArray(args) ? options : args;
        actualArgs = stripLogin(actualArgs);
        actualArgs = injectEnv(command, actualArgs);
        return _sp.call(this, LINKER64, [command].concat(actualArgs), actualOpts);
    }
    return _sp.call(this, command, args, options);
};
var _sps = child_process.spawnSync;
child_process.spawnSync = function(command, args, options) {
    if (isEB(command)) {
        var actualArgs = Array.isArray(args) ? args : [];
        var actualOpts = Array.isArray(args) ? options : args;
        actualArgs = stripLogin(actualArgs);
        actualArgs = injectEnv(command, actualArgs);
        return _sps.call(this, LINKER64, [command].concat(actualArgs), actualOpts);
    }
    return _sps.call(this, command, args, options);
};
var cliPath = process.argv[2];
if (!cliPath) { process.stderr.write('claude-wrapper: missing CLI path\n'); process.exit(1); }
process.argv = [process.argv[0], cliPath].concat(process.argv.slice(3));
require(cliPath);
