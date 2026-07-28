// Skill loading for the native harness.
//
// WHY this exists: scanSkills() solves DISCOVERY — it finds every skill across
// three roots and parses each SKILL.md's frontmatter. But it returns
// `prompt: '/<id>'` (a slash command for the UI to send to Claude Code) and used
// to drop the directory, so nothing in the app could actually READ a skill's
// instructions. Claude Code performs that step itself; the native harness has to.
//
// One place knows the on-disk layout (<skillDir>/SKILL.md). Do not add a second.
import * as fs from 'fs';
import * as path from 'path';
import { scanSkills } from '../../skill-scanner';
import type { SkillEntry } from '../../../shared/types';

export interface LoadedSkill { id: string; displayName: string; description: string; body: string }

export interface SkillCatalog {
  /** id + description only — this is what rides in the tool schema on EVERY turn,
   *  so it must stay small. Never put bodies here. */
  list(): Array<{ id: string; description: string }>;
  load(id: string): LoadedSkill;
}

export class SkillNotFound extends Error {
  constructor(public readonly id: string, public readonly known: string[]) {
    // Naming what IS available turns a dead end into a next step — a bare
    // "not found" leaves the model guessing at ids.
    super(`No skill named '${id}'. Available skills: ${known.length ? known.join(', ') : '(none installed)'}.`);
    this.name = 'SkillNotFound';
  }
}

export class SkillUnreadable extends Error {
  constructor(public readonly id: string, public readonly cause: string) {
    // Specific and accurate per docs/error-message-standards.md — surface the
    // real reason (missing path, unreadable file), never a guess.
    super(`The skill '${id}' is installed but its instructions could not be read: ${cause}`);
    this.name = 'SkillUnreadable';
  }
}

/** Drop YAML frontmatter. The model needs the instructions; the metadata is ours. */
function stripFrontmatter(raw: string): string {
  if (!raw.startsWith('---')) return raw;
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return raw;              // unterminated block — keep the text rather than eat the file
  const afterFence = raw.indexOf('\n', end + 1);
  return afterFence === -1 ? '' : raw.slice(afterFence + 1);
}

export function createSkillCatalog(entries: SkillEntry[] = scanSkills()): SkillCatalog {
  const byId = new Map(entries.map((e) => [e.id, e]));
  return {
    list: () => entries.map((e) => ({ id: e.id, description: e.description })),
    load(id: string): LoadedSkill {
      const entry = byId.get(id);
      if (!entry) throw new SkillNotFound(id, [...byId.keys()]);
      if (!entry.skillDir) throw new SkillUnreadable(id, 'it has no installed directory on this machine');
      const file = path.join(entry.skillDir, 'SKILL.md');
      let raw: string;
      try {
        raw = fs.readFileSync(file, 'utf8');
      } catch (err: any) {
        throw new SkillUnreadable(id, `${file} could not be read (${err?.code ?? err?.message ?? 'unknown error'})`);
      }
      return { id, displayName: entry.displayName, description: entry.description, body: stripFrontmatter(raw).trim() };
    },
  };
}
