import React, { useState } from 'react';
import { ToolCallState } from '../../../shared/types';

// Parsed views for expanded tool cards. Keeps one file per phase so adding a
// new tool is a single switch case. Falls back to a polished raw view for
// anything we haven't specialized yet.

function basename(fp: string): string {
  const parts = fp.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || fp;
}

function parentDir(fp: string): string {
  const parts = fp.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.slice(0, -1).join('/');
}

// Reveal literal \n / \" that JSON.stringify would otherwise hide, and collapse
// very long string values so raw fallback stays scannable.
function unescapeForDisplay(s: string): string {
  return s.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\t/g, '\t');
}

function CollapsibleBlock({ children, maxLines = 20 }: { children: string; maxLines?: number }) {
  const [open, setOpen] = useState(false);
  const lines = children.split('\n');
  const overflow = lines.length > maxLines;
  const shown = open || !overflow ? children : lines.slice(0, maxLines).join('\n');
  return (
    <div className="relative">
      <pre className="text-xs text-fg-dim bg-panel rounded-sm p-2 overflow-auto whitespace-pre font-mono">
        {shown}
        {overflow && !open && <span className="text-fg-muted">{'\n'}…</span>}
      </pre>
      {overflow && (
        <button
          onClick={() => setOpen(o => !o)}
          className="mt-1 text-[10px] uppercase tracking-wider text-fg-muted hover:text-fg-2"
        >
          {open ? 'Show less' : `Show ${lines.length - maxLines} more lines`}
        </button>
      )}
    </div>
  );
}

function PathHeader({ fp, extra }: { fp: string; extra?: React.ReactNode }) {
  const dir = parentDir(fp);
  return (
    <div className="flex items-center gap-1.5 text-[11px] font-mono">
      {dir && <span className="text-fg-muted">{dir}/</span>}
      <span className="text-fg-2 font-medium">{basename(fp)}</span>
      {extra}
    </div>
  );
}

function Chip({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'neutral' | 'add' | 'remove' | 'warn' }) {
  const toneClass =
    tone === 'add' ? 'bg-green-600/20 text-green-300 border-green-600/40'
    : tone === 'remove' ? 'bg-red-600/20 text-red-300 border-red-600/40'
    : tone === 'warn' ? 'bg-amber-600/20 text-amber-300 border-amber-600/40'
    : 'bg-inset text-fg-muted border-edge';
  return (
    <span className={`px-1.5 py-px text-[10px] uppercase tracking-wider rounded-sm border ${toneClass}`}>
      {children}
    </span>
  );
}

// Unified diff with a left-edge color bar + subtle row tint. Line numbers are
// approximate — Edit doesn't tell us the line number of the change, so we show
// relative numbering starting at 1. (A future pass can parse the `cat -n`
// snippet in the response to anchor to the real line.)
function DiffView({ oldStr, newStr }: { oldStr: string; newStr: string }) {
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');

  return (
    <div className="text-xs font-mono rounded-sm overflow-hidden border border-edge">
      {oldLines.map((line, i) => (
        <div key={`o-${i}`} className="flex items-start bg-red-600/10 border-l-2 border-red-500/60">
          <span className="w-8 text-right px-1.5 py-0.5 text-fg-muted select-none shrink-0">{i + 1}</span>
          <span className="w-4 text-red-400 select-none shrink-0">−</span>
          <span className="py-0.5 pr-2 text-red-200 whitespace-pre-wrap break-all flex-1">{line || ' '}</span>
        </div>
      ))}
      {newLines.map((line, i) => (
        <div key={`n-${i}`} className="flex items-start bg-green-600/10 border-l-2 border-green-500/60">
          <span className="w-8 text-right px-1.5 py-0.5 text-fg-muted select-none shrink-0">{i + 1}</span>
          <span className="w-4 text-green-400 select-none shrink-0">+</span>
          <span className="py-0.5 pr-2 text-green-200 whitespace-pre-wrap break-all flex-1">{line || ' '}</span>
        </div>
      ))}
    </div>
  );
}

function EditView({ tool }: { tool: ToolCallState }) {
  const fp = (tool.input.file_path as string) || '';
  const oldStr = (tool.input.old_string as string) || '';
  const newStr = (tool.input.new_string as string) || '';
  const replaceAll = tool.input.replace_all as boolean | undefined;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <PathHeader fp={fp} />
        {replaceAll && <Chip tone="warn">Replace all</Chip>}
      </div>
      {(oldStr || newStr) ? (
        <DiffView oldStr={oldStr} newStr={newStr} />
      ) : (
        <div className="text-xs text-fg-muted italic">No change content.</div>
      )}
      {tool.error && <ErrorBlock error={tool.error} />}
    </div>
  );
}

function WriteView({ tool }: { tool: ToolCallState }) {
  const fp = (tool.input.file_path as string) || '';
  const content = (tool.input.content as string) || '';
  const lineCount = content ? content.split('\n').length : 0;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <PathHeader fp={fp} />
        <Chip tone="add">New file</Chip>
        {lineCount > 0 && <span className="text-[10px] text-fg-muted">{lineCount} lines</span>}
      </div>
      {content ? (
        <div className="text-xs font-mono rounded-sm overflow-hidden border border-green-600/30 bg-green-600/5">
          <CollapsibleBlock maxLines={20}>{content}</CollapsibleBlock>
        </div>
      ) : (
        <div className="text-xs text-fg-muted italic">Empty file.</div>
      )}
      {tool.error && <ErrorBlock error={tool.error} />}
    </div>
  );
}

function ErrorBlock({ error }: { error: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-red-500 mb-1">Error</div>
      <pre className="text-xs text-red-400 bg-panel rounded-sm p-2 overflow-auto max-h-48 whitespace-pre-wrap">
        {error}
      </pre>
    </div>
  );
}

// Polished version of the old raw view: unescapes \n in string values, hides
// input fields that duplicate what the card header already shows, and collapses
// long responses.
function RawFallbackView({ tool }: { tool: ToolCallState }) {
  // ExitPlanMode renders its plan in a separate bubble — strip it here to
  // avoid double-showing.
  const input = tool.toolName === 'ExitPlanMode'
    ? Object.fromEntries(Object.entries(tool.input).filter(([k]) => k !== 'plan'))
    : tool.input;

  const formatted = Object.entries(input).length
    ? JSON.stringify(input, null, 2).replace(/"([^"\\]*(?:\\.[^"\\]*)*)"/g, (match, str) => {
        // Unescape \n in string values so they display as real line breaks.
        if (!str.includes('\\n') && !str.includes('\\"')) return match;
        return '"' + unescapeForDisplay(str) + '"';
      })
    : '';

  return (
    <div className="space-y-2">
      {formatted && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-fg-muted mb-1">Input</div>
          <CollapsibleBlock maxLines={15}>{formatted}</CollapsibleBlock>
        </div>
      )}
      {tool.response && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-fg-muted mb-1">Response</div>
          <CollapsibleBlock maxLines={20}>{tool.response}</CollapsibleBlock>
        </div>
      )}
      {tool.error && <ErrorBlock error={tool.error} />}
    </div>
  );
}

// Dispatcher — add a case when a new tool gets a custom view.
export default function ToolBody({ tool }: { tool: ToolCallState }) {
  return (
    <div className="px-3 pb-3 border-t border-edge pt-2">
      {(() => {
        switch (tool.toolName) {
          case 'Edit':
            return <EditView tool={tool} />;
          case 'Write':
            return <WriteView tool={tool} />;
          default:
            return <RawFallbackView tool={tool} />;
        }
      })()}
    </div>
  );
}
