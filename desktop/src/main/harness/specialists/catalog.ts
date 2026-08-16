// SpecialistCatalog — reads the three specialist-definition folders
// (personal, Claude Code user-level, Claude Code project-level) and hands
// out a merged, collision- and cap-resolved roster per project folder (cwd).
// Task 4 wires it into the native session host so the assistant's Task tool
// is rebuilt from it at every turn.
//
// WHY no file watchers: the Task tool is rebuilt from this catalog at the
// START of every turn, never mid-turn (native-session-host.ts) — so "drop a
// file in, the next thing you ask can hire it" only needs a re-check before
// each root turn, not a live filesystem subscription. That gets the same
// user-visible result with zero lifecycle to create, leak, or tear down.
//
// WHY staleness is a per-FILE fingerprint, never a directory stat: a
// folder's own mtime does NOT change when a file already inside it is
// edited — only when a file is added or removed. Watching the folder's mtime
// would miss every content edit to an existing specialist file, which is
// the common case (someone tweaking their own helper). The fingerprint is
// therefore `name:mtimeMs:size` for every .md file in the folder, joined —
// a handful of readdirSync/statSync calls per source, cheap enough to run
// before every turn, and never a content hash. Accepted blind spot: an edit
// that keeps the exact same byte size AND lands within the same millisecond
// as the file's previous mtime is invisible to this check until something
// else in that folder changes (a file added, removed, or differently
// edited). Settings' Refresh button (reload()) always re-reads
// unconditionally, so a user who notices a stale specialist can force it.
//
// WHY no teardown cleanup: several conversations can share one cwd, each
// reading this same catalog. Dropping a cwd's cached entries when one of
// those conversations closes would blank the roster out from under the
// OTHER conversations still open on that folder — there is no single owner
// to signal "I'm the last one, it's safe to drop." Entries are a handful of
// small objects per folder; keeping them for the life of the process costs
// far less than getting a correct multi-owner teardown right.
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { NativeHome } from '../../native-home';
import {
  loadClaudeCodeDefinition,
  loadPersonalDefinition,
  STARTER_FILE_CONTENTS,
  STARTER_FILE_NAME,
  type DefinitionLoad,
} from './definition-files';
import { listSpecialists, type SpecialistDefinition, type SpecialistRoster } from './registry';
import { MAX_OFFERED_SPECIALISTS } from './limits';

export type SpecialistSource = 'builtin' | 'personal' | 'claude-code'; // claude-code covers BOTH CC folders; `path` tells them apart

export interface CatalogEntry {
  definition: SpecialistDefinition;
  source: SpecialistSource; // === definition.source
  path?: string;
  warnings: string[];
  offered: boolean;
  fullDescription?: string;
}

// A parse failure OR an id collision — listed in Settings, never offered to
// the assistant.
export interface SkippedFile {
  path: string;
  source: 'personal' | 'claude-code';
  error: string;
}

export interface CatalogSnapshot {
  entries: CatalogEntry[];
  skipped: SkippedFile[];
  folders: { personal: string; claudeUser: string; project?: string };
}

export interface SpecialistCatalogOpts {
  home?: NativeHome; // absent → no personal source (host tests)
  claudeUserDir?: string | null; // default ~/.claude/agents; null → off
}

// A loaded-but-not-yet-collision/cap-resolved entry — everything a
// CatalogEntry needs except `offered`, which only resolveOffered can decide
// (it needs every source's entries at once to know what's already taken and
// how many have been offered so far).
export type RawEntry = Omit<CatalogEntry, 'offered'>;

interface SourceState {
  entries: RawEntry[];
  skipped: SkippedFile[];
  // undefined = never read. It compares unequal to any computed fingerprint
  // (always a string), so a source that has never been read always looks
  // "changed" on the next check — this is what makes a brand-new cwd load
  // on its very first ensureFresh() call, with no separate first-load path.
  fingerprint: string | undefined;
}

function emptySourceState(): SourceState {
  return { entries: [], skipped: [], fingerprint: undefined };
}

// Plain-English "who already has this id" phrase for the collision error,
// keyed by the source that WON the id first.
const WHERE_TAKEN: Record<SpecialistSource, string> = {
  builtin: 'a built-in specialist',
  personal: 'a file in your specialists folder',
  'claude-code': 'another Claude Code agent file',
};

/**
 * Pure collision + cap resolution — no disk I/O, so it's unit-testable on
 * its own (see the `resolveOffered (pure)` tests). Takes each source's
 * already-loaded entries in load order (built-ins -> personal -> CC user ->
 * CC project) and returns the final CatalogEntry list with `offered` set,
 * plus any collision SkippedFiles (parse-failure SkippedFiles are the
 * caller's concern — this function never sees files that failed to parse,
 * only the ones that loaded successfully).
 *
 * Ids are unique; the FIRST loaded wins. Later files with a taken id are
 * skipped — never shadowing. WHY (spec §3): "later shadows earlier" would
 * let a cloned repo's .claude/agents/worker.md silently replace the
 * built-in Worker; personal beats Claude Code because a user's own files
 * should never lose to a repo they merely cloned.
 */
export function resolveOffered(
  builtins: SpecialistDefinition[],
  personal: RawEntry[],
  claudeUser: RawEntry[],
  project: RawEntry[],
): { entries: CatalogEntry[]; skipped: SkippedFile[] } {
  const entries: CatalogEntry[] = [];
  const skipped: SkippedFile[] = [];
  const takenBy = new Map<string, SpecialistSource>();

  for (const def of builtins) {
    takenBy.set(def.id, 'builtin');
    entries.push({ definition: def, source: 'builtin', warnings: [], offered: true });
  }

  const addGroup = (raw: RawEntry[], skippedSource: 'personal' | 'claude-code') => {
    for (const r of raw) {
      const id = r.definition.id;
      const heldBy = takenBy.get(id);
      if (heldBy !== undefined) {
        skipped.push({
          path: r.path ?? '',
          source: skippedSource,
          error: `"${id}" is already the name of ${WHERE_TAKEN[heldBy]} — rename this file's name/id`,
        });
        continue;
      }
      takenBy.set(id, r.source);
      entries.push({ ...r, offered: false }); // cap decided in the pass below, once every source is in
    }
  };
  addGroup(personal, 'personal');
  addGroup(claudeUser, 'claude-code');
  addGroup(project, 'claude-code');

  // Offered cap: the first MAX_OFFERED_SPECIALISTS non-built-in entries in
  // load order (already reflected in `entries`' push order above) are
  // offered; the rest are listed (never silently cut) with a warning.
  let offeredCount = 0;
  for (const e of entries) {
    if (e.source === 'builtin') continue; // built-ins are always offered, don't count toward the cap
    if (offeredCount < MAX_OFFERED_SPECIALISTS) {
      e.offered = true;
      offeredCount++;
    } else {
      e.warnings = [
        ...e.warnings,
        `not offered to the assistant — more than ${MAX_OFFERED_SPECIALISTS} specialists are defined for this folder; remove or move some`,
      ];
    }
  }

  return { entries, skipped };
}

// `name:mtimeMs:size` for every .md file in `dir`, joined — see the WHY
// block at the top of this file for why this is per-file, not a directory
// stat. A missing (or unreadable) folder fingerprints as the fixed string
// '', so re-checking an absent folder costs one syscall and never looks
// "changed" from itself.
function fingerprintDir(dir: string): string {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return '';
  }
  const mdFiles = names.filter((n) => n.endsWith('.md')).sort();
  const parts: string[] = [];
  for (const name of mdFiles) {
    try {
      const st = fs.statSync(path.join(dir, name));
      parts.push(`${name}:${st.mtimeMs}:${st.size}`);
    } catch {
      // Deleted between readdir and stat — folding in a marker still changes
      // the fingerprint versus the prior read, which is all that matters
      // here (the actual re-read below will just skip the now-gone file).
      parts.push(`${name}:gone`);
    }
  }
  return parts.join('|');
}

// Reads every .md file in `dir` and parses it with `loader`. Every fs read
// is wrapped so a real I/O error (permissions, deleted mid-scan) becomes a
// SkippedFile carrying the ACTUAL error message — never a guessed cause. A
// missing folder is normal (no personal folder yet, no .claude/agents yet)
// and yields zero entries, not an error.
function loadFolder(
  dir: string,
  source: 'personal' | 'claude-code',
  loader: (filePath: string, raw: string) => DefinitionLoad,
): { entries: RawEntry[]; skipped: SkippedFile[] } {
  const entries: RawEntry[] = [];
  const skipped: SkippedFile[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { entries, skipped };
  }
  const files = names.filter((n) => n.endsWith('.md')).sort();
  for (const name of files) {
    const filePath = path.join(dir, name);
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (e: any) {
      skipped.push({ path: filePath, source, error: e?.message ?? String(e) });
      continue;
    }
    const result = loader(filePath, raw);
    if (!result.ok) {
      skipped.push({ path: filePath, source, error: result.error });
      continue;
    }
    entries.push({
      definition: result.value.definition,
      source,
      path: filePath,
      warnings: result.value.warnings,
      fullDescription: result.value.fullDescription,
    });
  }
  return { entries, skipped };
}

export class SpecialistCatalog {
  private readonly home?: NativeHome;
  private readonly personalDir: string;
  private readonly claudeUserDir: string | null;

  // Personal and Claude-Code-user-level are ONE folder each, shared across
  // every cwd — hence "globals". The project-level CC folder lives inside
  // each cwd, so it's keyed per cwd.
  private globals: { personal: SourceState; claudeUser: SourceState } = {
    personal: emptySourceState(),
    claudeUser: emptySourceState(),
  };
  private projects = new Map<string, SourceState>();

  constructor(opts?: SpecialistCatalogOpts) {
    this.home = opts?.home;
    // Even without a home (host tests), personalDir is still a real path —
    // it's shown in Settings via snapshot().folders regardless of whether
    // this catalog instance actually reads it.
    this.personalDir = path.join(this.home?.root ?? path.join(os.homedir(), '.youcoded'), 'specialists');
    this.claudeUserDir =
      opts?.claudeUserDir === null ? null : (opts?.claudeUserDir ?? path.join(os.homedir(), '.claude', 'agents'));
  }

  private refreshPersonal(): boolean {
    if (!this.home) return false; // no personal source configured (host tests)
    const fp = fingerprintDir(this.personalDir);
    if (fp === this.globals.personal.fingerprint) return false;
    const { entries, skipped } = loadFolder(this.personalDir, 'personal', loadPersonalDefinition);
    this.globals.personal = { entries, skipped, fingerprint: fp };
    return true;
  }

  private refreshClaudeUser(): boolean {
    if (this.claudeUserDir === null) return false;
    const dir = this.claudeUserDir;
    const fp = fingerprintDir(dir);
    if (fp === this.globals.claudeUser.fingerprint) return false;
    const { entries, skipped } = loadFolder(dir, 'claude-code', loadClaudeCodeDefinition);
    this.globals.claudeUser = { entries, skipped, fingerprint: fp };
    return true;
  }

  private refreshProject(cwd: string): boolean {
    const dir = path.join(cwd, '.claude', 'agents');
    const fp = fingerprintDir(dir); // read-only — NEVER mkdir's inside a user's repo
    const existing = this.projects.get(cwd);
    if (existing && existing.fingerprint === fp) return false;
    const { entries, skipped } = loadFolder(dir, 'claude-code', loadClaudeCodeDefinition);
    this.projects.set(cwd, { entries, skipped, fingerprint: fp });
    return true;
  }

  /**
   * Fingerprints the three folders and (re)reads any that changed OR were
   * never read; returns true if the resolved roster changed as a result.
   * THE call for conversation create/resume AND before every root turn — a
   * never-seen cwd fingerprints as changed on its very first call, so there
   * is no separate "first load" path to keep in sync with this one.
   */
  async ensureFresh(cwd: string): Promise<boolean> {
    // Every source must be checked regardless of the others' results — `||`
    // between the calls directly would short-circuit and skip later checks.
    const personalChanged = this.refreshPersonal();
    const claudeUserChanged = this.refreshClaudeUser();
    const projectChanged = this.refreshProject(cwd);
    return personalChanged || claudeUserChanged || projectChanged;
  }

  /** Unconditional re-read of all three sources (Settings Refresh / specialists:list). */
  async reload(cwd: string): Promise<void> {
    this.globals.personal = emptySourceState();
    this.globals.claudeUser = emptySourceState();
    this.projects.delete(cwd);
    await this.ensureFresh(cwd); // one read path — reload is just "forget, then ensureFresh"
  }

  private computeResolved(cwd?: string): { entries: CatalogEntry[]; skipped: SkippedFile[] } {
    const project = cwd !== undefined ? this.projects.get(cwd) : undefined;
    const { entries, skipped: collisionSkipped } = resolveOffered(
      listSpecialists(),
      this.globals.personal.entries,
      this.globals.claudeUser.entries,
      project?.entries ?? [],
    );
    return {
      entries,
      skipped: [
        ...this.globals.personal.skipped,
        ...this.globals.claudeUser.skipped,
        ...(project?.skipped ?? []),
        ...collisionSkipped,
      ],
    };
  }

  /**
   * SYNC — reads the in-memory arrays at call time via closures, never a
   * snapshot copied when roster() itself was called. Cheap to recompute on
   * every list()/resolve() call (a few dozen objects, plain array/Map work,
   * zero disk I/O), so there's no separate cache to keep in sync with
   * ensureFresh()/reload(). Must not be called before ensureFresh(cwd) has
   * resolved at least once for this cwd.
   */
  roster(cwd: string): SpecialistRoster {
    return {
      list: () => this.computeResolved(cwd).entries.filter((e) => e.offered).map((e) => e.definition),
      resolve: (id: string) => {
        const found = this.computeResolved(cwd).entries.find((e) => e.offered && e.definition.id === id);
        return found?.definition;
      },
    };
  }

  /** For specialists:list — every entry (offered or not) and every skipped file, plus the three folder paths. */
  snapshot(cwd?: string): CatalogSnapshot {
    const { entries, skipped } = this.computeResolved(cwd);
    return {
      entries,
      skipped,
      folders: {
        personal: this.personalDir,
        claudeUser: this.claudeUserDir ?? '',
        project: cwd !== undefined ? path.join(cwd, '.claude', 'agents') : undefined,
      },
    };
  }

  /** Writes the starter file into the personal folder (creating it) the first time only, then re-reads the personal source. */
  async ensurePersonalFolder(): Promise<void> {
    if (!this.home) return; // no personal source configured (host tests) — nothing to create
    await this.home.ensureTextFile(path.join('specialists', STARTER_FILE_NAME), STARTER_FILE_CONTENTS);
    // Force a re-read regardless of what the fingerprint check would say —
    // whether ensureTextFile just created the file or left an existing one
    // alone, the caller expects snapshot()/roster() to reflect the personal
    // folder's current contents right after this call returns.
    this.globals.personal = emptySourceState();
    this.refreshPersonal();
  }
}
