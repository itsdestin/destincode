import { useCallback, useEffect, useState } from 'react';
import { Button, EmptyState, ErrorState, LoadingState } from './ui';
import { BugReportPopup } from './development/BugReportPopup';
import { describeRule } from './permissions/describe-rule';
import type { PermissionRule, StoredProject, StoredRule } from '../../shared/permission-types';

// Settings → Permissions (M5 item 2a). Lists every "Always allow" a NATIVE
// session remembered and lets the user take it back. Modelled on
// ProvidersSection.tsx: same useState/useCallback load shape, same
// danger-outline → in-place inline confirm (never a modal).
//
// DELIBERATELY NOT gated on window.claude.native.supported, unlike
// ProvidersSection. remote-shim.ts hardcodes that flag false, so copying the
// gate would render nothing over remote access — killing the one transport
// where revoking a grant from a phone matters. Spec 2026-08-11, "Open item for
// Phase 1 review".
//
// Narrow viewport (640px) is handled with Tailwind's sm: prefix rather than
// useNarrowViewport(), per .claude/rules/narrow-viewport.md: the hook is for
// DOM-structure branches, classes for class-only changes. Nothing is hidden
// when narrow — the row stacks and Remove goes full-width.

// ── Plain-language helpers ───────────────────────────────────────────────────

/** Heading for each project, disambiguated ACROSS the whole list.
 *
 *  WHY not just basename(cwd): a worktree and its parent repo routinely share a
 *  basename (`…/youcoded-dev/youcoded` and `…/youcoded-dev/worktrees/youcoded`),
 *  which renders two identical headings over two genuinely different rule sets —
 *  the user would revoke from whichever one they guessed. Each colliding heading
 *  grows by one parent folder at a time until it is unique, so the common case
 *  stays a bare folder name and only the ambiguous ones pay for the extra words.
 *  Projects with no recorded cwd are absent from the returned map; the caller
 *  falls back to the slug and says the folder was never recorded. */
function folderHeadings(projects: StoredProject[]): Map<string, string> {
  // Split on both separators — a cwd recorded on Windows uses backslashes.
  const segments = new Map<string, string[]>();
  for (const p of projects) {
    if (!p.cwd) continue;
    const segs = p.cwd.split(/[\\/]+/).filter(Boolean);
    if (segs.length > 0) segments.set(p.slug, segs);
  }

  const depth = new Map<string, number>();
  for (const slug of segments.keys()) depth.set(slug, 1);

  const labelFor = (slug: string) => {
    const segs = segments.get(slug)!;
    const d = Math.min(depth.get(slug)!, segs.length);
    return segs.slice(segs.length - d).join('/');
  };

  // Widen every colliding label by one parent, repeatedly. Bounded by the
  // deepest path so two identical paths (impossible — the slug would collide
  // too) could never spin forever.
  const maxDepth = Math.max(1, ...[...segments.values()].map((s) => s.length));
  for (let pass = 0; pass < maxDepth; pass++) {
    const byLabel = new Map<string, string[]>();
    for (const slug of segments.keys()) {
      const label = labelFor(slug);
      byLabel.set(label, [...(byLabel.get(label) ?? []), slug]);
    }
    let widened = false;
    for (const slugs of byLabel.values()) {
      if (slugs.length < 2) continue;
      for (const slug of slugs) {
        const room = segments.get(slug)!.length;
        const current = depth.get(slug)!;
        if (current < room) { depth.set(slug, current + 1); widened = true; }
      }
    }
    if (!widened) break;
  }

  const headings = new Map<string, string>();
  for (const slug of segments.keys()) headings.set(slug, labelFor(slug));
  return headings;
}

/** What a pattern-less grant actually covers, in the user's words. describeRule
 *  only reports THAT a rule is broad; the noun depends on the tool. */
function broadNote(tool: string): string {
  if (tool === 'Bash') return 'Covers every command, not just the one it first asked about.';
  if (tool === 'Edit' || tool === 'Write' || tool === 'Read') {
    return 'Covers every file, not just the one it first asked about.';
  }
  return 'Covers every use of this tool, not just the one it first asked about.';
}

/** "Approved Jul 27, 2026", or nothing at all. Rules stored before this screen
 *  existed carry no date, and a missing date is shown as a missing date rather
 *  than as today. */
function grantedLabel(grantedAt?: string): string | null {
  if (!grantedAt) return null;
  const when = new Date(grantedAt);
  if (Number.isNaN(when.getTime())) return null;
  return `Approved ${when.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
}

/** React list key. remember() dedupes exact repeats, so (tool, pattern, action)
 *  is unique within a project — the same triple the removal API matches on. */
function ruleKey(rule: PermissionRule): string {
  return `${rule.tool}::${rule.pattern ?? ''}::${rule.action}`;
}

/** Hand the backend a bare PermissionRule, not the StoredRule the list returned:
 *  grantedAt is provenance the matcher never looks at, and sending it invites a
 *  future exact-shape comparison to silently stop matching. */
function toPermissionRule(rule: StoredRule): PermissionRule {
  return {
    tool: rule.tool,
    ...(rule.pattern !== undefined ? { pattern: rule.pattern } : {}),
    action: rule.action,
  };
}

// ── The section ──────────────────────────────────────────────────────────────

export default function PermissionsSection() {
  const [projects, setProjects] = useState<StoredProject[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  // The general ErrorState's two actions both land on the app's existing
  // bug-report surface, exactly as the Remote Access section does: "Report bug"
  // files it and "Diagnose with Claude" is the same popup's summarize path. One
  // destination, no invented flow. It portals, so nesting it here is safe.
  const [showBugReport, setShowBugReport] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const list = await window.claude.permissions.list();
      setProjects(Array.isArray(list) ? list : []);
      setLoadFailed(false);
    } catch {
      // No guessed cause in the copy — we do not know why it failed, so the
      // general two-action card is the honest surface (docs/error-message-standards.md).
      setLoadFailed(true);
      setProjects((prev) => prev ?? []);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const headings = projects ? folderHeadings(projects) : new Map<string, string>();
  const withRules = (projects ?? []).filter((p) => p.rules.length > 0);

  return (
    <section className="space-y-3">
      <p className="text-2xs text-fg-dim leading-relaxed">
        {'Things you told the assistant it can always do without asking again. Removing one just means it asks you next time.'}
      </p>

      {projects === null ? (
        <LoadingState what="your approvals" variant="inline" />
      ) : loadFailed ? (
        <ErrorState
          mode="general"
          title="Unable to show your approvals."
          explainer="Nothing was changed. Diagnosing will collect the app's logs so Claude can look at what happened."
          onReportBug={() => setShowBugReport(true)}
          onDiagnose={() => setShowBugReport(true)}
        />
      ) : withRules.length === 0 ? (
        <EmptyState
          message={"You haven't approved anything yet. When you choose “Always allow” during a conversation, it shows up here."}
        />
      ) : (
        <div className="space-y-4">
          {withRules.map((project) => (
            <ProjectGroup
              key={project.slug}
              project={project}
              heading={headings.get(project.slug) ?? null}
              onChanged={refresh}
            />
          ))}
          {/* Always visible, never hover-revealed — the list can go stale while
              this screen is open (a session can add a grant behind it). */}
          <Button variant="secondary" size="sm" onClick={() => void refresh()}>
            Refresh
          </Button>
        </div>
      )}

      <BugReportPopup open={showBugReport} onClose={() => setShowBugReport(false)} />
    </section>
  );
}

// ── One project's group ──────────────────────────────────────────────────────

function ProjectGroup({
  project, heading, onChanged,
}: { project: StoredProject; heading: string | null; onChanged: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const confirmClear = async () => {
    setBusy(true);
    setNote(null);
    try {
      const hit = await window.claude.permissions.removeProject(project.slug);
      setConfirming(false);
      if (hit) {
        await onChanged();
      } else {
        // Same honesty rule as the per-rule remove: false means the list on
        // screen was already out of date, so say that instead of reporting a
        // success that did not happen.
        setNote("These approvals couldn't be found. They may have already been removed — use Refresh to see the current list.");
      }
    } catch {
      setNote('These approvals could not be removed. Nothing was changed.');
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-1">
      <div className="flex items-end gap-3 px-1">
        <div className="flex-1 min-w-0">
          <h4 className="text-xs font-medium text-fg truncate">{heading ?? project.slug}</h4>
          {project.cwd ? (
            <p className="text-3xs text-fg-muted font-mono truncate">{project.cwd}</p>
          ) : (
            <p className="text-3xs text-fg-muted">
              {"This folder wasn't recorded, so only its internal name is shown."}
            </p>
          )}
        </div>
        {!confirming && (
          <Button variant="danger-outline" size="sm" className="shrink-0" onClick={() => { setConfirming(true); setNote(null); }}>
            Remove all
          </Button>
        )}
      </div>

      {/* Inline confirm — in place, never a modal (ProvidersSection:346-364). */}
      {confirming && (
        <div className="space-y-2 rounded-lg bg-inset border border-edge-dim p-3">
          <p className="text-2xs text-fg-dim leading-relaxed">
            {"Remove all "}{project.rules.length}{" approvals for this folder? You'll be asked the next time any of them comes up."}
          </p>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setConfirming(false)} className="flex-1 py-2">
              Cancel
            </Button>
            <Button variant="danger" onClick={() => void confirmClear()} disabled={busy} className="flex-1 py-2">
              {busy ? 'Removing…' : 'Remove all'}
            </Button>
          </div>
        </div>
      )}

      {note && <p className="text-3xs text-destructive-fg px-1">{note}</p>}

      <div className="divide-y divide-edge-dim/60">
        {project.rules.map((rule) => (
          <RuleRow key={ruleKey(rule)} slug={project.slug} rule={rule} onChanged={onChanged} />
        ))}
      </div>
    </div>
  );
}

// ── One remembered rule ──────────────────────────────────────────────────────

function RuleRow({
  slug, rule, onChanged,
}: { slug: string; rule: StoredRule; onChanged: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const described = describeRule(rule);
  const granted = grantedLabel(rule.grantedAt);

  const confirmRemove = async () => {
    setBusy(true);
    setNote(null);
    try {
      const hit = await window.claude.permissions.remove(slug, toPermissionRule(rule));
      setConfirming(false);
      if (hit) {
        await onChanged();
      } else {
        // The rule was NOT on disk, so the row on screen came from a stale
        // read. Keep the row and say so — reporting success here would teach
        // the user to trust a list that lied to them.
        setNote("This approval couldn't be found. It may have already been removed — use Refresh to see the current list.");
      }
    } catch {
      setNote('This approval could not be removed. Nothing was changed.');
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="py-2 px-1">
      {/* Stacks below 640px so the Remove button keeps its full tap target
          instead of being squeezed beside a long command. Nothing is hidden. */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-xs text-fg">
            {described.verb}
            {described.subject !== undefined && (
              <> <span className="font-mono text-fg-2 break-all">{described.subject}</span></>
            )}
          </p>
          {/* Plain words, no status glyph. describeRule already reports MCP
              grants as not-broad, so this never fires on an MCP row. */}
          {described.broad && <p className="text-3xs text-fg-muted mt-0.5">{broadNote(rule.tool)}</p>}
          {granted && <p className="text-3xs text-fg-muted mt-0.5">{granted}</p>}
        </div>
        {!confirming && (
          <Button
            variant="danger-outline"
            size="sm"
            className="w-full sm:w-auto sm:shrink-0"
            onClick={() => { setConfirming(true); setNote(null); }}
          >
            Remove
          </Button>
        )}
      </div>

      {confirming && (
        <div className="mt-2 space-y-2 rounded-lg bg-inset border border-edge-dim p-3">
          <p className="text-2xs text-fg-dim leading-relaxed">
            {"You'll be asked the next time this comes up."}
          </p>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setConfirming(false)} className="flex-1 py-2">
              Cancel
            </Button>
            {/* Filled danger commits, outline opens it — the ProvidersSection pair. */}
            <Button variant="danger" onClick={() => void confirmRemove()} disabled={busy} className="flex-1 py-2">
              {busy ? 'Removing…' : 'Remove'}
            </Button>
          </div>
        </div>
      )}

      {note && <p className="text-3xs text-destructive-fg mt-2">{note}</p>}
    </div>
  );
}
