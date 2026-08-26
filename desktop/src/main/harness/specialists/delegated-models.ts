// Delegated model tiers (Task 14, app-owner ruling 2026-08-12) — two
// user-designated tiers, 'budget' and 'frontier', each pointing at a concrete
// model the user picks in a later Settings menu (that UI is plan 1c; this
// file ships the storage and the pure resolution logic it depends on).
// DELIBERATE NON-GOAL: no automatic price-based selection anywhere in this
// file — a tier is only ever what the user put there, and an unrecognized
// specific model id is refused rather than substituted (see
// resolveDelegatedBinding's own comment for why the two failure modes differ).
import type { CatalogModel, ModelBinding } from '../../../shared/provider-types';
import type { NativeHome } from '../../native-home';
import type { DelegatedModelsView } from '../../../shared/types';

export type DelegatedTier = 'budget' | 'frontier';

const FILE = 'delegated-models.json';
type DelegatedModelsFile = { v: 1; budget?: ModelBinding; frontier?: ModelBinding };
const EMPTY: DelegatedModelsFile = { v: 1 };

/** Storage for the two designated tiers, one flat file at
 *  ~/.youcoded/delegated-models.json — { v: 1, budget?: ModelBinding,
 *  frontier?: ModelBinding }. Mirrors PermissionStore's shape: NativeHome
 *  owns the file lock, this class owns the read/mutate calls, and reads are
 *  synchronous (NativeHome.readJson) because the Task tool's resolution path
 *  needs the answer before it can even validate the rest of the call. */
export class DelegatedModels {
  constructor(private home: NativeHome) {}

  /** The tier's designated binding, or null when the user has not set one —
   *  callers (resolveDelegatedBinding) treat null as "fall back to the
   *  parent's model", never as an error. */
  get(tier: DelegatedTier): ModelBinding | null {
    const data = (this.home.readJson(FILE) as DelegatedModelsFile | null) ?? EMPTY;
    return data[tier] ?? null;
  }

  /** Set (or clear, with null) one tier's designated binding. The Settings UI
   *  (1c) is the only production caller — this class has no opinion on WHERE
   *  the binding came from, only on persisting it. Read-modify-write under
   *  NativeHome's file lock so a concurrent write to the other tier can't
   *  clobber this one. */
  async set(tier: DelegatedTier, binding: ModelBinding | null): Promise<void> {
    await this.home.mutateJson(FILE, (cur) => {
      const data = (cur as DelegatedModelsFile | null) ?? EMPTY;
      if (binding === null) {
        // Destructure-omit rather than `delete data[tier]` — never mutate the
        // value mutateJson handed us (same discipline as permission-store.ts's
        // removeProject: an in-place delete would also corrupt a retry's view
        // of the file).
        const { [tier]: _dropped, ...rest } = data;
        return { ...rest, v: 1 };
      }
      return { ...data, v: 1, [tier]: binding };
    });
  }
}

/** Task 8 — Settings' two tier rows read this. Resolves each set tier's
 *  binding to a display LABEL from the live catalog (never a bare id); a row
 *  whose catalog entry can no longer be found (model removed/renamed since
 *  it was designated) still shows something readable, falling back to the
 *  raw modelId rather than an empty label. An unset tier stays null — the
 *  renderer already reads that as "falls back to the conversation's model". */
export function delegatedModelsView(designated: DelegatedModels, catalog: CatalogModel[] | null): DelegatedModelsView {
  const rowFor = (tier: DelegatedTier): DelegatedModelsView['budget'] => {
    const binding = designated.get(tier);
    if (!binding) return null;
    const label = catalog?.find((m) => m.id === binding.modelId && m.providerId === binding.providerId)?.label ?? binding.modelId;
    return { providerId: binding.providerId, modelId: binding.modelId, label };
  };
  return { budget: rowFor('budget'), frontier: rowFor('frontier') };
}

/** Priority ordering for what a Task call runs on: the Task-call arg (a user
 *  directive, expressed in the tool call itself) wins over the specialist
 *  definition's own modelPreference (an author-time default), which wins
 *  over 'parent' (the ultimate fallback — run on this conversation's own
 *  model). A raw string that isn't literally "budget"/"frontier"/"parent" is
 *  treated as a user-directed specific model id, never guessed at or
 *  normalized — resolveDelegatedBinding is what validates it against the
 *  live catalog. */
export function resolveRequestedModel(
  argModel: string | undefined,
  specialistPreference: 'parent' | DelegatedTier | undefined,
): 'parent' | DelegatedTier | { modelId: string } {
  // Fix pass (Finding 2): this function's own return type documents 'parent'
  // as reachable from EITHER input channel — the specialistPreference branch
  // below already honored it, but an explicit `model: "parent"` ARGUMENT was
  // falling through to the specific-id branch and getting looked up as a
  // model literally named "parent" (always refused). Handling it here, next
  // to the tier check, keeps every literal the arg channel recognizes in one
  // place instead of splitting "parent" off into its own branch below.
  if (argModel === 'budget' || argModel === 'frontier' || argModel === 'parent') return argModel;
  if (argModel) return { modelId: argModel };
  if (specialistPreference === 'budget' || specialistPreference === 'frontier') return specialistPreference;
  return 'parent';
}

/** Thrown by resolveDelegatedBinding when a user-directed specific model id
 *  cannot be confirmed against the live catalog. Distinguishable from a plain
 *  Error so tools/task.ts can render its message directly as the model-facing
 *  refusal instead of a generic "Task failed: ..." wrapper. */
export class DelegatedModelRefused extends Error {}

/** Pure resolver: given what was requested (a Task-call arg, falling back to
 *  the specialist definition's own preference, falling back to 'parent'),
 *  produce the ModelBinding to actually launch the child on.
 *
 *  THE ASYMMETRY IS DELIBERATE (spec ruling): a tier that isn't configured
 *  degrades GRACEFULLY — the child still launches, on the parent's model,
 *  and the caller is told so (fellBack + reason) so it can pass that on
 *  honestly. A user-directed SPECIFIC model id that doesn't resolve against
 *  the live catalog REFUSES instead — silently substituting a different
 *  model than the one a user explicitly named is worse than not running at
 *  all, so this throws rather than returning a fallback binding for that
 *  case. Never provider-specific params cross model families here — this
 *  function only ever returns a { providerId, modelId } pair, nothing else.
 */
export function resolveDelegatedBinding(i: {
  requested: 'parent' | DelegatedTier | { modelId: string };
  parent: ModelBinding;
  designated: DelegatedModels;
  /** For specific-id validation ONLY — a tier lookup never touches this.
   *  null means "catalog not loaded", which is treated identically to "id
   *  not found": an override that cannot be confirmed is refused, never
   *  trusted on faith. */
  catalog: CatalogModel[] | null;
}): { binding: ModelBinding; fellBack: boolean; reason?: string } {
  const { requested, parent, designated, catalog } = i;

  if (requested === 'parent') {
    return { binding: parent, fellBack: false };
  }

  if (requested === 'budget' || requested === 'frontier') {
    const designatedBinding = designated.get(requested);
    if (designatedBinding) return { binding: designatedBinding, fellBack: false };
    // Final-review fix (Finding 6): this used to say "is set in Settings" —
    // true once the plan 1c Settings UI ships, false today. This release has
    // no menu that lets a user designate a budget/frontier model at all
    // (DelegatedModels.set()'s own comment: "The Settings UI (1c) is the
    // only production caller" — not yet written), so pointing the model (and,
    // via task.ts's fallbackNote, the user) at "Settings" named a control
    // nobody can find. General and non-committal instead: state the fact
    // (nothing is designated) without claiming a place to fix it that
    // doesn't exist yet.
    return { binding: parent, fellBack: true, reason: `no ${requested} model is designated` };
  }

  // requested is { modelId }: a user-directed override, validated against the
  // live catalog. A null catalog (not loaded) and a catalog that simply
  // doesn't list this id read identically here — both mean "cannot confirm
  // this model exists", and an unconfirmed override is refused, not guessed at.
  const found = catalog?.find((m) => m.id === requested.modelId);
  if (!found) {
    throw new DelegatedModelRefused(
      `Refused: "${requested.modelId}" is not an available model. Use ModelSearch to find the exact id, or use "budget"/"frontier".`,
    );
  }
  return { binding: { providerId: found.providerId, modelId: found.id }, fellBack: false };
}
