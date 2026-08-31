// desktop/tests/arcade-authority.test.ts
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { stripComments, readStripped, RENDERER } from './helpers/guard-scope';
import { GAMES, gameById } from '../src/renderer/components/game/game-registry';

// Source-text guards for the games arcade (spec §3, §5.5, §7). These read the
// tree at runtime, so `vitest related` can never reach them — hence the
// `*-authority` name, which verify.sh always runs.

const GAME_DIR = join(RENDERER, 'components', 'game');

function gameFiles(): string[] {
  const files = readdirSync(GAME_DIR)
    .filter((f) => f.endsWith('.tsx') || f.endsWith('.ts'))
    .filter((f) => !f.endsWith('.test.tsx') && !f.endsWith('.test.ts'))
    .map((f) => join(GAME_DIR, f));
  // A guard that silently scans nothing is worse than no guard — it reads green
  // while proving nothing (see guard-scope.ts's own history).
  expect(files.length).toBeGreaterThanOrEqual(8);
  return files;
}

describe('the game slot (§3)', () => {
  it('every registered game satisfies the definition', () => {
    expect(GAMES.length).toBe(4);
    for (const g of GAMES) {
      expect(g.id, 'id').toMatch(/^[a-z0-9-]+$/);
      expect(g.name.length, `${g.id} name`).toBeGreaterThan(0);
      expect(g.blurb.length, `${g.id} blurb`).toBeGreaterThan(0);
      expect(typeof g.Tile, `${g.id} Tile`).toBe('function');
      expect(g.defaultPaneWidth, `${g.id} width`).toBeGreaterThanOrEqual(320);

      // The kind decides which half of the definition is required. Getting this
      // wrong is how a solo game ends up asking for a PartyKit party.
      if (g.kind === 'solo') {
        expect(g.scoring, `${g.id} needs scoring`).toBeTruthy();
        expect(g.party, `${g.id} must not name a party`).toBeUndefined();
      } else {
        expect(g.party, `${g.id} needs a party`).toBeTruthy();
        expect(g.scoring, `${g.id} must not carry scoring`).toBeUndefined();
      }
    }
  });

  it('ids are unique and resolvable', () => {
    expect(new Set(GAMES.map((g) => g.id)).size).toBe(GAMES.length);
    for (const g of GAMES) expect(gameById(g.id)).toBe(g);
    expect(gameById('nope')).toBeUndefined();
  });

  it("keeps Connect 4's wire id and party name distinct", () => {
    // The shipped wire value is 'connect-four' (usePartyGame.ts) while the
    // PartyKit party is spelled 'connectfour' (partykit.json). Collapsing these
    // into one field silently breaks every existing client.
    const c4 = gameById('connect-four')!;
    expect(c4.party).toBe('connectfour');
    expect(c4.party).not.toBe(c4.id);
  });

  it('leads with the games playable when nobody is online', () => {
    // §4.1: the picker must not open on two tiles that both say "no friends
    // online". Solo games therefore come first in registration order.
    expect(GAMES[0]!.kind).toBe('solo');
    expect(GAMES[1]!.kind).toBe('solo');
  });
});

describe('the state split (§3.1)', () => {
  // `state.play` is the open game's OWN state, opaque to the shell. Exactly one
  // file may narrow it: the game whose state it is. If a shell file starts
  // reaching in, the split has quietly collapsed back into the one shared pot
  // it took the largest piece of work in the project to get out of.
  const MAY_READ_PLAY = new Set(['ConnectFourBoard.tsx']);

  it('only a game\'s own board narrows state.play', () => {
    const offenders = gameFiles()
      .filter((f) => /\bstate\.play\b/.test(readStripped(f)))
      .map((f) => f.split('/').pop()!)
      .filter((n) => !MAY_READ_PLAY.has(n));
    expect(offenders).toEqual([]);
  });

  it('Connect 4\'s vocabulary is gone from the shared state', () => {
    // `myColor`, `turn`, `winner`, `winLine` and `board` all lived on the shell
    // state and made chess and 2048 read Connect 4's language to render at all.
    const shared = readStripped(join(RENDERER, 'state', 'game-types.ts'))
      + readStripped(join(RENDERER, 'state', 'game-reducer.ts'));
    for (const gone of ['myColor', 'PlayerColor', 'winLine:', 'lastMove:']) {
      expect(shared, `${gone} is back on the shared state`).not.toContain(gone);
    }
    // And the replacements are actually there, so this cannot pass by the
    // whole file having been deleted.
    for (const want of ['seat', 'turnSeat', 'outcome', 'play']) {
      expect(shared).toContain(want);
    }
  });

  it('the challenge carries which game, end to end', () => {
    // The wire always sent `gameType`; the reducer dropped it, so Accept could
    // only ever open Connect 4. All four links must stay connected.
    expect(readStripped(join(RENDERER, 'hooks', 'usePresence.ts'))).toContain('gameType');
    expect(readStripped(join(RENDERER, 'state', 'game-reducer.ts'))).toContain('challengeGame');
    expect(readStripped(join(RENDERER, 'components', 'game', 'GameLobby.tsx'))).toContain('challengeGame');
    // And nobody hardcodes the game on the way out any more.
    expect(readStripped(join(RENDERER, 'hooks', 'usePartyGame.ts')))
      .not.toContain("lobbyChallenge(target, 'connect-four'");
  });
});

describe('the assistant-finishing rule (§7)', () => {
  // DECIDED BY DESTIN, 2026-08-30: when the assistant finishes, NOTHING happens
  // beyond the existing ready chime and the header status light. No game pauses,
  // no overlay, no focus change, no extra badge.
  //
  // This asserts an ABSENCE, which is unusual — but the rule is exactly the kind
  // four independently-built game modules could each quietly break, and by then
  // it is four bugs in four places instead of one.
  const FORBIDDEN = [
    ['playSound', 'a game must not make its own sound when a turn ends'],
    ['useAnyAttentionNeeded', 'a game must not react to the attention summary'],
    ['onAttentionSummary', 'a game must not subscribe to the attention summary'],
    ['isThinking', 'a game must not watch whether the assistant is working'],
    ['sessionAttention', 'a game must not read session attention'],
  ] as const;

  for (const [symbol, why] of FORBIDDEN) {
    it(`no game file references ${symbol} — ${why}`, () => {
      const offenders = gameFiles().filter((f) => readStripped(f).includes(symbol));
      expect(offenders, why).toEqual([]);
    });
  }
});

describe('theming (§5.5)', () => {
  // The app DOES sanction four Tailwind palette names — the status colours,
  // which are theme-independent by standing rule (desktop/CLAUDE.md). Rather
  // than hardcode them here (where they would drift the moment globals.css
  // changes), read them back out of the stylesheet that defines them.
  function sanctionedStatusColours(): Set<string> {
    const css = readFileSync(join(RENDERER, 'styles', 'globals.css'), 'utf8');
    const names = new Set<string>();
    for (const m of css.matchAll(/--color-([a-z]+-\d{2,3}):/g)) names.add(m[1]!);
    // If this ever reads empty the guard below would pass on anything.
    expect(names.size).toBeGreaterThanOrEqual(4);
    return names;
  }

  const PALETTE = /\b(?:bg|text|border|ring|from|to|via|fill|stroke)-((?:red|yellow|blue|green|orange|amber|purple|pink|indigo|teal|cyan|lime|violet|fuchsia|rose|sky|emerald)-\d{2,3})\b/g;

  it('no game file names an unsanctioned Tailwind palette colour', () => {
    // G-2: tokens paint everything. The retheme (§5.4) removed the hardcoded
    // red/yellow/blue discs, the blue board, the red disconnect box and the
    // amber "Reload app" link; this keeps them out.
    const allowed = sanctionedStatusColours();
    const offenders: string[] = [];
    for (const f of gameFiles()) {
      for (const m of stripComments(readStripped(f)).matchAll(PALETTE)) {
        if (!allowed.has(m[1]!)) offenders.push(`${f.split('/').pop()}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the palette pattern actually matches a known positive', () => {
    // Without this the guard above could be a regex that matches nothing and
    // reads green forever. bg-red-600 was a real disc colour until this spec.
    expect(new RegExp(PALETTE.source).test('bg-red-600')).toBe(true);
    // And the allowlist must really exempt a sanctioned one, or the guard is
    // just banning everything and passing by luck.
    expect(sanctionedStatusColours().has('green-400')).toBe(true);
  });
});
