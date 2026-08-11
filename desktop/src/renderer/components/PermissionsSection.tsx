import { useCallback, useEffect, useState } from 'react';
import { Button, EmptyState, ErrorState, FOCUS_RING, LoadingState, SettingRow, SETTING_ROW_BASE } from './ui';
import { BugReportPopup } from './development/BugReportPopup';
import {
  describeRule,
  broadNote,
  ruleKind,
  RULE_KIND_ORDER,
  RULE_KIND_LABEL,
  type RuleKind,
} from './permissions/describe-rule';
import type { PermissionRule, StoredProject, StoredRule } from '../../shared/permission-types';

// Settings → Permissions (M5 item 2a). Everything a NATIVE session remembered
// because the user chose "Always allow", with a way to take it back.
//
// THIS IS AN OVERVIEW, NOT A LOG. The first version listed every approval ever
// granted as one flat line each and was rejected for exactly that: "i don't
// want a separate line for every single permission i've ever approved". So the
// default view is three lines of orientation (what this is · how many · which
// folders) and the rows themselves are two levels down, behind a folder you
// opened and a kind you were looking for.
//
// The shapes here are the settings family's, NOT ProvidersSection's. That file
// hand-rolls its rows and is grandfathered as legacy in
// setting-row-authority.test.tsx; the first version was modelled on it and
// inherited the drift. The exemplars actually followed:
//   · rows            SettingsPanel.tsx Connected Devices — <SettingRow variant="item">
//   · collapsible     OpenTasksPopup.tsx — label-styled <button> with count + caret
//   · destructive     SyncPanel.tsx DevicesTab — outline opens, filled commits,
//                     in place, with autoFocus + Escape-to-cancel
//   · truncating tail LocalModelsSection.tsx — "Show all N"
//
// DELIBERATELY NOT gated on window.claude.native.supported, unlike
// ProvidersSection. remote-shim.ts hardcodes that flag false, so copying the
// gate would render nothing over remote access — killing the one transport
// where revoking a grant from a phone matters. Spec 2026-08-11, "Open item for
// Phase 1 review".
//
// No `sm:` breakpoints anywhere: the dialog is size="panel" (420px) and never
// gets wider, so a breakpoint that only fires above 640px is dead code that
// merely looks responsive. Long text truncates or wraps instead.

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

/** One short sentence naming an approval, for the accessible names on its
 *  buttons. A list of twenty buttons all announcing "Remove" is unusable with a
 *  screen reader, which is why DevicesTab labels its own the same way. */
function plainName(rule: StoredRule): string {
  const d = describeRule(rule);
  return d.subject !== undefined ? `${d.verb} ${d.subject}` : d.verb;
}

/** Split a folder's approvals into the four kind buckets, preserving order. */
function groupByKind(rules: StoredRule[]): Record<RuleKind, StoredRule[]> {
  const out: Record<RuleKind, StoredRule[]> = { commands: [], files: [], connections: [], other: [] };
  for (const rule of rules) out[ruleKind(rule)].push(rule);
  return out;
}

/** Rows shown per kind before "Show all N". 5 visible with a 7th hidden is
 *  worth a click; hiding a single row behind one is not, which is why the cut
 *  only applies above 6. */
const ROWS_PER_KIND = 5;

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
  const total = withRules.reduce((n, p) => n + p.rules.length, 0);

  // The whole point of the overview: one plain sentence that answers "how much
  // have I approved?" before any folder is opened.
  const summary = withRules.length === 1
    ? `${total} ${total === 1 ? 'approval' : 'approvals'} in one folder.`
    : `${total} approvals across ${withRules.length} folders.`;

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
        <div className="space-y-3">
          <p className="text-2xs text-fg-muted">{summary}</p>

          {/* The one real section label on this screen: a static string over the
              whole list. Folder NAMES are user data and are rendered as rows —
              putting one in a label would uppercase it and destroy its real
              casing, which is what the first version did. */}
          <div>
            <h3 className="text-3xs font-medium text-fg-muted tracking-wider uppercase mb-2">Approved folders</h3>
            <div className="space-y-1">
              {withRules.map((project) => (
                <FolderGroup
                  key={project.slug}
                  project={project}
                  heading={headings.get(project.slug) ?? null}
                  // Default-open heuristic: a short screen should not need a
                  // click to be read, a long one should not dump 60 rows. Open
                  // only when the whole list is small — at most two folders, and
                  // at most eight approvals in this one.
                  defaultOpen={withRules.length <= 2 && project.rules.length <= 8}
                  onChanged={refresh}
                />
              ))}
            </div>
          </div>

          {/* Always visible, never hover-revealed — the list can go stale while
              this screen is open (a session can add a grant behind it), and
              every "couldn't be found" message below points the user here. */}
          <Button variant="secondary" size="sm" onClick={() => void refresh()}>
            Refresh
          </Button>
        </div>
      )}

      <BugReportPopup open={showBugReport} onClose={() => setShowBugReport(false)} />
    </section>
  );
}

// ── One folder ───────────────────────────────────────────────────────────────

function FolderGroup({
  project, heading, defaultOpen, onChanged,
}: {
  project: StoredProject;
  heading: string | null;
  defaultOpen: boolean;
  onChanged: () => Promise<void>;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const count = project.rules.length;
  const label = heading ?? project.slug;
  const groups = groupByKind(project.rules);

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
    <div>
      {/* A ROW, not a label. The folder name is user data — rendering it through
          a section label's `tracking-wider uppercase` destroyed its real casing
          and made the legacy no-cwd slug read as shouting. The family renders
          data in rows (SettingsPanel puts an IP address in a SettingRow title),
          so this wears SettingRow's own item geometry and type roles.
          SettingRow itself cannot host it: SettingRowProps has no aria-expanded
          pass-through, its <button> branch appends a static right-chevron that
          cannot express open/closed, and supplying a caret via `control`
          demotes the row to a non-focusable <div>. Taking SETTING_ROW_BASE by
          reference is the nearest row-shaped alternative that still has exactly
          one definition of the geometry. */}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`${SETTING_ROW_BASE} hover:bg-inset cursor-pointer ${FOCUS_RING}`}
      >
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium text-fg truncate">{label}</div>
          {/* The path belongs with the name, so it is the row's description.
              It truncates because folderHeadings() has already guaranteed the
              TITLE is unique — the path is supporting detail, and letting it
              wrap would make a collapsed list of folders tall again. The
              never-recorded line is a sentence, not data, so it wraps. */}
          {project.cwd ? (
            <p className="text-3xs -mt-0.5 text-fg-muted truncate">{project.cwd}</p>
          ) : (
            <p className="text-3xs -mt-0.5 text-fg-muted">
              {"This folder wasn't recorded, so only its internal name is shown."}
            </p>
          )}
        </div>
        {/* Count + caret in the accessory slot: a collapsed folder still says
            how much is hidden inside it. */}
        <span className="text-3xs text-fg-muted shrink-0">{count} {open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className="space-y-3 pt-2 pb-1 pl-2">
          {RULE_KIND_ORDER.filter((kind) => groups[kind].length > 0).map((kind) => (
            <KindGroup
              key={kind}
              kind={kind}
              rules={groups[kind]}
              slug={project.slug}
              onChanged={onChanged}
            />
          ))}

          {/* Per-folder bulk removal. It lives at the BOTTOM of the open folder,
              not in the heading row, so it cannot be hit while aiming at the
              disclosure toggle — and it is a `ghost` button, the lightest
              variant in the family, because it is the widest-reaching action on
              this screen and has no precedent in settings to inherit weight
              from. The confirm gate below is the same one every row uses. */}
          {/* Only when there is more than one to remove: "Remove all 1" is just
              the row's own Remove button wearing a second, scarier label.
              px-0.5 + the ghost button's own px-2.5 puts this label on the same
              12px left edge as every row title above it. */}
          {count > 1 && (
          <div className="px-0.5">
            {!confirming ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { setConfirming(true); setNote(null); }}
              >
                Remove all {count} for this folder
              </Button>
            ) : (
              <div
                className="space-y-2 rounded-lg bg-inset border border-edge-dim p-2.5"
                // Escape cancels, matching DevicesTab — the trigger has just
                // unmounted, so there is nothing else to escape back to.
                onKeyDown={(e) => { if (e.key === 'Escape') setConfirming(false); }}
              >
                <p className="text-2xs text-fg-dim leading-relaxed">
                  {`Remove all ${count} approvals for ${label}? You'll be asked again the next time any of them comes up.`}
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="secondary"
                    onClick={() => setConfirming(false)}
                    aria-label={`Keep the approvals for ${label}`}
                    className="flex-1 py-2"
                  >
                    Cancel
                  </Button>
                  {/* autoFocus: the trigger just unmounted, so without this a
                      keyboard user drops to <body> and re-tabs from the top. */}
                  <Button
                    variant="danger"
                    autoFocus
                    disabled={busy}
                    onClick={() => void confirmClear()}
                    aria-label={`Confirm removing all approvals for ${label}`}
                    className="flex-1 py-2"
                  >
                    {busy ? 'Removing…' : 'Remove all'}
                  </Button>
                </div>
              </div>
            )}
            {note && <p className="text-3xs text-destructive-fg mt-1">{note}</p>}
          </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── One kind of approval, inside a folder ────────────────────────────────────

function KindGroup({
  kind, rules, slug, onChanged,
}: { kind: RuleKind; rules: StoredRule[]; slug: string; onChanged: () => Promise<void> }) {
  const [showAll, setShowAll] = useState(false);
  // Never hide a single row behind a click — the cut only pays for itself once
  // there is more than one row on the other side of it.
  const visible = showAll || rules.length <= ROWS_PER_KIND + 1 ? rules : rules.slice(0, ROWS_PER_KIND);

  return (
    <div>
      {/* Section labels have exactly one spelling — the classes below are the
          canonical string, in the canonical order (section-label-authority). */}
      <h3 className="text-3xs font-medium text-fg-muted tracking-wider uppercase mb-2 px-3">{RULE_KIND_LABEL[kind]}</h3>
      <div className="space-y-1">
        {visible.map((rule) => (
          <RuleRow key={ruleKey(rule)} slug={slug} rule={rule} onChanged={onChanged} />
        ))}
        {visible.length < rules.length && (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="text-3xs text-fg-2 hover:underline px-3"
          >
            Show all {rules.length}
          </button>
        )}
      </div>
    </div>
  );
}

// ── One remembered approval ──────────────────────────────────────────────────

function RuleRow({
  slug, rule, onChanged,
}: { slug: string; rule: StoredRule; onChanged: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const described = describeRule(rule);
  const name = plainName(rule);
  // Plain words under the title, never a status glyph. describeRule already
  // reports MCP grants as not-broad, so the breadth note never fires on one.
  const detail = [
    described.broad ? broadNote(rule.tool) : null,
    grantedLabel(rule.grantedAt),
  ].filter(Boolean).join(' · ');

  const confirmRemove = async () => {
    setBusy(true);
    setNote(null);
    try {
      // The SLUG, never the cwd: cwdToProjectSlug collapses ':', '\', '/' and
      // spaces all to '-', so a path cannot be reconstructed from a slug and the
      // store is keyed by the slug alone.
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
    <div>
      <SettingRow
        variant="item"
        title={
          <>
            {described.verb}
            {described.subject !== undefined && (
              <> <span className="font-mono text-fg-2 break-all">{described.subject}</span></>
            )}
          </>
        }
        description={detail || undefined}
        // The trigger unmounts while the confirm is open, exactly as DevicesTab
        // does — two "Remove" buttons for one row would be ambiguous.
        control={confirming ? undefined : (
          <Button
            variant="danger-outline"
            size="sm"
            className="shrink-0"
            aria-label={`Remove approval: ${name}`}
            onClick={() => { setConfirming(true); setNote(null); }}
          >
            Remove
          </Button>
        )}
      />

      {confirming && (
        <div
          className="mt-1.5 space-y-2 rounded-lg bg-inset border border-edge-dim p-2.5"
          onKeyDown={(e) => { if (e.key === 'Escape') setConfirming(false); }}
        >
          <p className="text-2xs text-fg-dim leading-relaxed">
            {"You'll be asked the next time this comes up."}
          </p>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              onClick={() => setConfirming(false)}
              aria-label={`Keep approval: ${name}`}
              className="flex-1 py-2"
            >
              Cancel
            </Button>
            {/* Filled danger commits, outline opened it. */}
            <Button
              variant="danger"
              autoFocus
              disabled={busy}
              onClick={() => void confirmRemove()}
              aria-label={`Confirm removing approval: ${name}`}
              className="flex-1 py-2"
            >
              {busy ? 'Removing…' : 'Remove'}
            </Button>
          </div>
        </div>
      )}

      {note && <p className="text-3xs text-destructive-fg mt-1 px-3">{note}</p>}
    </div>
  );
}
