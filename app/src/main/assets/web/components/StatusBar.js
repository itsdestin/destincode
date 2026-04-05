"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = StatusBar;
const jsx_runtime_1 = require("react/jsx-runtime");
const theme_context_1 = require("../state/theme-context");
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
const THEME_LABELS = {
    light: 'Light',
    dark: 'Dark',
    midnight: 'Midnight',
    creme: 'Crème',
};
function StatusBar({ statusData, onRunSync }) {
    const { usage, updateStatus, contextPercent, syncStatus, syncWarnings } = statusData;
    const warnings = parseSyncWarnings(syncWarnings);
    const { theme, cycleTheme } = (0, theme_context_1.useTheme)();
    return ((0, jsx_runtime_1.jsxs)("div", { className: "flex flex-wrap items-center gap-x-2 gap-y-1 px-2 sm:px-3 py-1 text-[10px] text-fg-muted border-t border-edge-dim", children: [usage?.five_hour != null && ((0, jsx_runtime_1.jsxs)("span", { className: "flex items-center gap-1 sm:gap-1.5 px-1.5 py-0.5 rounded bg-panel border border-edge-dim", children: [(0, jsx_runtime_1.jsx)("span", { children: "5h:" }), (0, jsx_runtime_1.jsxs)("span", { className: utilizationColor(usage.five_hour.utilization), children: [usage.five_hour.utilization, "%"] }), (0, jsx_runtime_1.jsx)("span", { className: "text-fg-faint hidden sm:inline", children: format5hReset(usage.five_hour.resets_at) })] })), usage?.seven_day != null && ((0, jsx_runtime_1.jsxs)("span", { className: "flex items-center gap-1 sm:gap-1.5 px-1.5 py-0.5 rounded bg-panel border border-edge-dim", children: [(0, jsx_runtime_1.jsx)("span", { children: "7d:" }), (0, jsx_runtime_1.jsxs)("span", { className: utilizationColor(usage.seven_day.utilization), children: [usage.seven_day.utilization, "%"] }), (0, jsx_runtime_1.jsx)("span", { className: "text-fg-faint hidden sm:inline", children: format7dReset(usage.seven_day.resets_at) })] })), contextPercent != null && ((0, jsx_runtime_1.jsxs)("span", { children: ["Ctx:", ' ', (0, jsx_runtime_1.jsxs)("span", { className: contextColor(contextPercent), children: [contextPercent, "%"] })] })), warnings.map((w, i) => ((0, jsx_runtime_1.jsx)("button", { onClick: onRunSync, className: `px-1.5 py-0.5 rounded border text-[9px] sm:text-[10px] ${warnStyles[w.level]} ${onRunSync ? 'cursor-pointer hover:brightness-125 transition-all' : ''}`, children: w.text }, i))), (0, jsx_runtime_1.jsx)("button", { onClick: cycleTheme, className: "px-1.5 py-0.5 rounded bg-panel border border-edge-dim cursor-pointer hover:bg-inset transition-colors", title: "Click to cycle theme", children: THEME_LABELS[theme] }), updateStatus && ((0, jsx_runtime_1.jsx)("button", { onClick: () => window.claude.shell.openChangelog(), className: "px-1.5 py-0.5 rounded bg-panel border border-edge-dim cursor-pointer hover:bg-inset transition-colors ml-auto hidden sm:inline-flex", children: updateStatus.update_available ? ((0, jsx_runtime_1.jsxs)("span", { className: "text-[#FF9800]", children: ["v", updateStatus.current, " \u2192 v", updateStatus.latest] })) : ((0, jsx_runtime_1.jsxs)("span", { children: ["v", updateStatus.current] })) }))] }));
}
