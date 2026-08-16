import { useCallback, useEffect, useState } from 'react';
import type { SpecialistDefinitionView, DelegatedModelsView } from '../../shared/types';
import ModelPicker, { type ModelChoice } from './model/ModelPicker';
import { Button, EmptyState } from './ui';
import type { ExplainerSection } from './SettingsExplainer';
import { refreshSpecialistRoster, useSpecialistRoster } from '../hooks/useSpecialists';

// Specialists 1c — Settings → Specialists. Two things, in the order a person
// needs them: (1) the two model tiers the assistant can hire onto (Destin's
// 2026-08-12 ruling: user-designated, never auto-priced; unset falls back to
// the conversation's model, honestly), and (2) the roster — every specialist
// the assistant can hire right now, where it came from, what it may do, and
// any narrowing the loader applied to a file (spec §2: a stripped tool is a
// VISIBLE warning, never a silent edit). No editor: that is later marketplace
// work; the folder is opened for you instead.

const SECTION_LABEL = 'text-3xs font-medium text-fg-muted tracking-wider uppercase mb-2';

const SOURCE_LABEL: Record<SpecialistDefinitionView['source'], string> = {
  builtin: 'Built in',
  personal: 'Your specialists',
  project: 'This project',
  'claude-code': 'This project (Claude Code format)',
};

const SOURCE_ORDER: SpecialistDefinitionView['source'][] = ['builtin', 'personal', 'project', 'claude-code'];

export const SPECIALISTS_EXPLAINER_INTRO =
  'Specialists are helpers your assistant can hire for a piece of work — a search, a review, an edit — while it keeps talking to you. Each one runs on its own with only the tools its job needs.';

export const SPECIALISTS_EXPLAINER_SECTIONS: ExplainerSection[] = [
  {
    heading: 'The two model tiers',
    paragraphs: [
      'When your assistant hires a helper it can ask for the budget model (cheap, fast, good for searching and reading) or the frontier model (the strongest you have, for judgment calls). You choose which real model each name means here. If a tier is not set, the helper simply uses the conversation’s own model — and the assistant is told so.',
      'Nothing is picked for you by price. These two names are the only automatic choices your assistant can make; it may name a specific model only when you ask it to.',
    ],
  },
  {
    heading: 'Where specialists come from',
    bullets: [
      { term: 'Built in', text: 'Explorer, Researcher, Reviewer and Worker ship with the app.' },
      { term: 'Your specialists', text: 'Files in your specialists folder. Add one there and it appears here the moment it is saved.' },
      { term: 'This project', text: 'Files in the project’s own specialists folder, and any Claude Code agent files it has. Those use Claude Code’s tool names, which are translated; anything that does not translate is removed and listed as a warning.' },
    ],
  },
  {
    heading: 'Read-only vs can edit',
    paragraphs: [
      'A read-only helper can look at files and search the web but cannot change anything or run commands. A helper that can edit is limited to the folder it was hired for. Either way, deleting things, secrets, and anything outside the folder still ask you every time. Approving a hire is what grants these — the card in the chat says exactly what before you say yes.',
    ],
  },
];

export default function SpecialistsSection() {
  const roster = useSpecialistRoster();
  const [tiers, setTiers] = useState<DelegatedModelsView | null>(null);
  const [tierError, setTierError] = useState<string | null>(null);

  const loadTiers = useCallback(async () => {
    try {
      const t = await (window as any).claude?.specialists?.getDelegatedModels?.();
      if (t && typeof t === 'object') setTiers(t as DelegatedModelsView);
      else setTiers({ budget: null, frontier: null });
    } catch { setTiers({ budget: null, frontier: null }); }
  }, []);
  useEffect(() => { void loadTiers(); }, [loadTiers]);

  const setTier = async (tier: 'budget' | 'frontier', choice: ModelChoice | null) => {
    if (choice && choice.runtime !== 'native') return; // specialists run natively
    const binding = choice ? { providerId: choice.providerId, modelId: choice.modelId, label: choice.modelId } : null;
    const prev = tiers;
    // Optimistic; revert if the write is refused.
    setTiers(t => t ? { ...t, [tier]: binding } : t);
    setTierError(null);
    try {
      const res = await (window as any).claude?.specialists?.setDelegatedModel?.(tier, binding);
      if (res && res.ok === false) { setTiers(prev); setTierError(`Couldn’t save the ${tier} model. ${res.error ?? ''}`.trim()); return; }
      await loadTiers();
    } catch (e) { setTiers(prev); setTierError((e as Error).message); }
  };

  const bySource = new Map<SpecialistDefinitionView['source'], SpecialistDefinitionView[]>();
  for (const d of roster ?? []) {
    const arr = bySource.get(d.source) ?? [];
    arr.push(d);
    bySource.set(d.source, arr);
  }
  const warningCount = (roster ?? []).reduce((n, d) => n + d.warnings.length, 0);

  return (
    <section className="space-y-5">
      {/* ── 1. Models for specialists ─────────────────────────────────────── */}
      <div>
        <h3 className={SECTION_LABEL}>Models specialists run on</h3>
        <div className="rounded-lg bg-inset/50">
          <div className="px-3 py-2.5">
            <p className="text-2xs text-fg-dim leading-relaxed">
              Your assistant can hire a helper onto the <span className="text-fg-2">budget</span> model or the{' '}
              <span className="text-fg-2">frontier</span> model. You decide what those names mean. A tier that is not set uses the conversation’s own model.
            </p>
          </div>
          <div className="border-t border-edge-dim divide-y divide-edge-dim">
            <TierRow
              tier="budget"
              title="Budget"
              hint="Cheap and quick — searching, reading, summarizing."
              value={tiers?.budget ?? null}
              loaded={tiers !== null}
              onPick={(c) => setTier('budget', c)}
              onClear={() => setTier('budget', null)}
            />
            <TierRow
              tier="frontier"
              title="Frontier"
              hint="The strongest you have — reviews and judgment calls."
              value={tiers?.frontier ?? null}
              loaded={tiers !== null}
              onPick={(c) => setTier('frontier', c)}
              onClear={() => setTier('frontier', null)}
            />
          </div>
          {tierError && (
            <div className="border-t border-edge-dim px-3 py-2 text-2xs text-danger">{tierError}</div>
          )}
        </div>
      </div>

      {/* ── 2. The roster ─────────────────────────────────────────────────── */}
      <div>
        <h3 className={SECTION_LABEL}>Available specialists{roster ? ` · ${roster.length}` : ''}{warningCount ? ` · ${warningCount} warning${warningCount === 1 ? '' : 's'}` : ''}</h3>
        <div className="rounded-lg bg-inset/50">
          <div className="px-3 py-2.5">
            <p className="text-2xs text-fg-dim leading-relaxed">
              Everything your assistant can hire right now. To add one, drop a file in your specialists folder — it shows up here as soon as it is saved. A project can carry its own; Claude Code agent files are translated and any tool that does not translate is removed and listed below.
            </p>
          </div>
          {roster === null ? (
            <div className="border-t border-edge-dim px-3 py-3 text-2xs text-fg-muted">Loading…</div>
          ) : roster.length === 0 ? (
            <div className="border-t border-edge-dim p-2.5">
              <EmptyState message="No specialists found — even the built-ins are missing, which is a bug worth reporting." variant="inline" />
            </div>
          ) : (
            SOURCE_ORDER.filter(src => bySource.has(src)).map(src => (
              <div key={src} className="border-t border-edge-dim">
                <div className="px-3 pt-2 pb-1 text-3xs font-medium text-fg-muted uppercase tracking-wider">{SOURCE_LABEL[src]}</div>
                <ul className="pb-1">
                  {bySource.get(src)!.map(d => <RosterRow key={`${d.source}-${d.id}`} d={d} />)}
                </ul>
              </div>
            ))
          )}
          <div className="border-t border-edge-dim px-2 py-1.5 flex items-center justify-between gap-2">
            <span className="text-3xs text-fg-muted px-1">Files are re-read automatically; Refresh if one seems missing.</span>
            <div className="flex items-center gap-1 shrink-0">
              <Button size="sm" variant="ghost" onClick={() => void refreshSpecialistRoster()}>Refresh</Button>
              <Button size="sm" variant="ghost" onClick={() => (window as any).claude?.specialists?.openFolder?.()}>Open folder</Button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function TierRow({ tier, title, hint, value, loaded, onPick, onClear }: {
  tier: 'budget' | 'frontier';
  title: string;
  hint: string;
  value: DelegatedModelsView['budget'];
  loaded: boolean;
  onPick: (c: ModelChoice) => void;
  onClear: () => void;
}) {
  const choice: ModelChoice | null = value ? { runtime: 'native', providerId: value.providerId, modelId: value.modelId } : null;
  // Stacked, not side-by-side: the panel dialog is ~420px wide and the picker
  // trigger is wide, so a row layout squeezed the hint into a one-word column.
  return (
    <div className="px-3 py-2.5 space-y-1.5" data-testid={`tier-row-${tier}`}>
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="text-xs font-medium text-fg-2">{title}</span>
        <span className="text-2xs text-fg-muted">{hint}</span>
      </div>
      <div className="flex items-center gap-1.5">
        <div className="min-w-0 flex-1"><ModelPicker value={choice} onSelect={onPick} includeClaude={false} /></div>
        {value && <Button size="sm" variant="ghost" onClick={onClear} title={`Unset the ${tier} model`}>Clear</Button>}
      </div>
      <div className="text-2xs">
        {!loaded ? <span className="text-fg-muted">Loading…</span>
          : value ? <span className="text-fg-dim">Set to <span className="text-fg-2">{value.label}</span></span>
          : <span className="text-amber-500">Not set — helpers use the conversation’s model</span>}
      </div>
    </div>
  );
}

function RosterRow({ d }: { d: SpecialistDefinitionView }) {
  const [open, setOpen] = useState(false);
  const canShell = d.allowedTools.includes('Bash');
  return (
    <li className="px-3 py-1.5" data-testid={`specialist-row-${d.id}`}>
      <button type="button" onClick={() => setOpen(v => !v)} className="w-full text-left" aria-expanded={open}>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-medium text-fg-2">{d.displayName}</span>
          <span className={`text-4xs uppercase tracking-wide px-1 rounded border ${d.charter === 'read-write' ? 'border-amber-500/40 text-amber-500' : 'border-edge text-fg-muted'}`}>
            {d.charter === 'read-write' ? (canShell ? 'can edit & run commands' : 'can edit files') : 'read-only'}
          </span>
          {d.modelPreference && d.modelPreference !== 'parent' && (
            <span className="text-4xs uppercase tracking-wide px-1 rounded border border-edge text-fg-muted">prefers {d.modelPreference}</span>
          )}
          {d.warnings.length > 0 && (
            <span className="text-4xs uppercase tracking-wide px-1 rounded border border-amber-500/40 text-amber-500">{d.warnings.length} warning{d.warnings.length === 1 ? '' : 's'}</span>
          )}
        </div>
        <div className="text-2xs text-fg-dim leading-relaxed">{d.description}</div>
      </button>
      {open && (
        <div className="mt-1 pl-2 border-l-2 border-edge-dim space-y-1 text-2xs">
          <div className="text-fg-muted">Tools: <span className="text-fg-dim">{d.allowedTools.join(', ')}</span></div>
          {d.path && <div className="text-fg-muted">File: <span className="font-mono text-fg-dim break-all">{d.path}</span></div>}
          {d.shadows && <div className="text-fg-muted">Overrides the {SOURCE_LABEL[d.shadows.source].toLowerCase()} specialist with the same name.</div>}
          {d.warnings.map((w, i) => <div key={i} className="text-amber-500">⚠ {w}</div>)}
        </div>
      )}
      {!open && d.warnings.length > 0 && (
        <div className="text-2xs text-amber-500 mt-0.5">⚠ {d.warnings[0]}</div>
      )}
    </li>
  );
}
