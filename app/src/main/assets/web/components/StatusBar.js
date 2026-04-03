"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = StatusBar;
const jsx_runtime_1 = require("react/jsx-runtime");
const MODELS = ['sonnet', 'opus', 'haiku'];
const MODEL_DISPLAY = {
    sonnet: { label: 'Sonnet', color: '#9CA3AF', bg: 'rgba(156,163,175,0.15)', border: 'rgba(156,163,175,0.25)' },
    opus:   { label: 'Opus',   color: '#818CF8', bg: 'rgba(129,140,248,0.15)', border: 'rgba(129,140,248,0.25)' },
    haiku:  { label: 'Haiku',  color: '#2DD4BF', bg: 'rgba(45,212,191,0.15)',  border: 'rgba(45,212,191,0.25)' },
};
function utilizationColor(pct) {
    if (pct >= 80)
        return 'text-[#DD4444]';
    if (pct >= 50)
        return 'text-[#FF9800]';
    return 'text-[#4CAF50]';
}
function contextColor(pct) {
    if (pct < 20)
        return 'text-[#DD4444]';
    if (pct < 50)
        return 'text-[#FF9800]';
    return 'text-[#4CAF50]';
}
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function formatTime12(d) {
    let h = d.getHours();
    const m = d.getMinutes();
    const ampm = h >= 12 ? 'pm' : 'am';
    h = h % 12 || 12;
    return `${h}:${m.toString().padStart(2, '0')}${ampm}`;
}
function format5hReset(iso) {
    try {
        const d = new Date(iso);
        return `Resets @ ${formatTime12(d)}`;
    }
    catch {
        return '';
    }
}
function format7dReset(iso) {
    try {
        const d = new Date(iso);
        return `Resets ${DAYS[d.getDay()]} @ ${formatTime12(d)}`;
    }
    catch {
        return '';
    }
}
// Map raw warning codes to the same descriptive text used in the terminal statusline
const WARNING_MAP = {
    'OFFLINE': { text: 'DANGER: No Internet Connection', level: 'danger' },
    'PERSONAL:NOT_CONFIGURED': { text: 'DANGER: No Sync Act. for Personal Data', level: 'danger' },
    'PERSONAL:STALE': { text: 'WARN: No Recent Personal Sync (>24h)', level: 'warn' },
};
function parseSyncWarnings(raw) {
    if (!raw)
        return [];
    return raw.split('\n').filter(Boolean).map((line) => {
        // Check for exact match first
        if (WARNING_MAP[line])
            return WARNING_MAP[line];
        // Prefix match for SKILLS:* and PROJECTS:*
        if (line.startsWith('SKILLS:'))
            return { text: 'DANGER: Unsynced Skills', level: 'danger' };
        if (line.startsWith('PROJECTS:'))
            return { text: 'DANGER: Projects Excluded From Sync', level: 'danger' };
        // Fallback: pass through raw text
        if (line.startsWith('DANGER:') || line.startsWith('OFFLINE')) {
            return { text: line, level: 'danger' };
        }
        return { text: line, level: 'warn' };
    });
}
const warnStyles = {
    danger: 'bg-[#DD4444]/15 text-[#DD4444] border-[#DD4444]/25',
    warn: 'bg-[#FF9800]/15 text-[#FF9800] border-[#FF9800]/25',
};
function StatusBar({ statusData, onRunSync, model, onCycleModel }) {
    const { usage, updateStatus, contextPercent, syncStatus, syncWarnings } = statusData;
    const warnings = parseSyncWarnings(syncWarnings);
    return ((0, jsx_runtime_1.jsxs)("div", { className: "flex flex-wrap items-center gap-x-2 gap-y-1 px-2 sm:px-3 py-1 text-[10px] text-gray-500 border-t border-gray-800/50", children: [usage?.five_hour != null && ((0, jsx_runtime_1.jsxs)("span", { className: "flex items-center gap-1 sm:gap-1.5 px-1.5 py-0.5 rounded bg-gray-900 border border-gray-700/50", children: [(0, jsx_runtime_1.jsx)("span", { children: "5h:" }), (0, jsx_runtime_1.jsxs)("span", { className: utilizationColor(usage.five_hour.utilization), children: [usage.five_hour.utilization, "%"] }), (0, jsx_runtime_1.jsx)("span", { className: "text-gray-600 hidden sm:inline", children: format5hReset(usage.five_hour.resets_at) })] })), usage?.seven_day != null && ((0, jsx_runtime_1.jsxs)("span", { className: "flex items-center gap-1 sm:gap-1.5 px-1.5 py-0.5 rounded bg-gray-900 border border-gray-700/50", children: [(0, jsx_runtime_1.jsx)("span", { children: "7d:" }), (0, jsx_runtime_1.jsxs)("span", { className: utilizationColor(usage.seven_day.utilization), children: [usage.seven_day.utilization, "%"] }), (0, jsx_runtime_1.jsx)("span", { className: "text-gray-600 hidden sm:inline", children: format7dReset(usage.seven_day.resets_at) })] })), contextPercent != null && ((0, jsx_runtime_1.jsxs)("span", { children: ["Ctx:", ' ', (0, jsx_runtime_1.jsxs)("span", { className: contextColor(contextPercent), children: [contextPercent, "%"] })] })), model && ((0, jsx_runtime_1.jsx)("button", { onClick: onCycleModel, className: "px-1.5 py-0.5 rounded border cursor-pointer hover:brightness-125 transition-colors", style: { backgroundColor: MODEL_DISPLAY[model].bg, color: MODEL_DISPLAY[model].color, borderColor: MODEL_DISPLAY[model].border }, title: "Model: " + MODEL_DISPLAY[model].label + " (tap to cycle)", children: MODEL_DISPLAY[model].label })), warnings.map((w, i) => ((0, jsx_runtime_1.jsx)("button", { onClick: onRunSync, className: `px-1.5 py-0.5 rounded border text-[9px] sm:text-[10px] ${warnStyles[w.level]} ${onRunSync ? 'cursor-pointer hover:brightness-125 transition-all' : ''}`, children: w.text }, i))), updateStatus && ((0, jsx_runtime_1.jsx)("button", { onClick: () => window.claude.shell.openChangelog(), className: "px-1.5 py-0.5 rounded bg-gray-900 border border-gray-700/50 cursor-pointer hover:bg-gray-800 transition-colors ml-auto hidden sm:inline-flex", children: updateStatus.update_available ? ((0, jsx_runtime_1.jsxs)("span", { className: "text-[#FF9800]", children: ["v", updateStatus.current, " \u2192 v", updateStatus.latest] })) : ((0, jsx_runtime_1.jsxs)("span", { children: ["v", updateStatus.current] })) }))] }));
}
