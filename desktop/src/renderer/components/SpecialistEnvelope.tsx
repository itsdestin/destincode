import { useArtifactOptional } from '../state/ArtifactContext';
import { asString } from '../utils/tool-input';
import { useDelegatedModels, useSpecialistRoster, useSpecialistRunByChild } from '../hooks/useSpecialists';
import type { SpecialistDefinitionView, ToolCallState } from '../../shared/types';

/** ToolCard's entry: resolves roster + target for the awaiting Task card. */
export function TaskConsentBlock({ tool, sessionId }: { tool: ToolCallState; sessionId?: string }) {
  const roster = useSpecialistRoster();
  const agent = asString(tool.input.agent);
  const definition = roster?.find(d => d.id === agent);
  const taskId = asString(tool.input.task_id);
  const target = useSpecialistRunByChild(sessionId, taskId || undefined);
  return (
    <div className="px-3 pt-2">
      <SpecialistEnvelope
        input={tool.input}
        definition={definition}
        targetTitle={target?.title}
        targetRunning={target ? target.status === 'running' : undefined}
        sessionId={sessionId}
      />
    </div>
  );
}

/**
 * The consent envelope (spec §5: approving the launch IS the grant). Says, in
 * plain words, exactly what saying Yes lets this helper do — charter, tools,
 * folder, model — rendered from the MAPPED definition the child will actually
 * get, never from the model's prose. A `task_id` call reads as what it is:
 * a note, a resume, or a stop, and grants nothing new.
 */
export function SpecialistEnvelope({ input, definition, targetTitle, targetRunning, sessionId }: {
  input: Record<string, unknown>;
  definition?: SpecialistDefinitionView;
  targetTitle?: string;
  targetRunning?: boolean;
  sessionId?: string;
}) {
  const artifacts = useArtifactOptional();
  const cwd = sessionId ? artifacts?.state.sessionCwd?.[sessionId] : undefined;
  const folder = cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() : undefined;
  const workDir = asString(input.work_dir);
  const where = workDir && workDir !== '.' && workDir !== './' ? workDir : (folder ? `${folder}/` : 'this folder');
  const taskId = asString(input.task_id);
  const [tiers] = useDelegatedModels();

  if (taskId) {
    const who = targetTitle ?? 'this specialist';
    const line = input.interrupt === true
      ? `Yes stops ${who}. Work done so far is kept and the assistant can resume it later.`
      : targetRunning === false
        ? `Yes sends ${who} back to work with this brief — under the same limits you already approved. Nothing new is granted.`
        : `Yes delivers this note to ${who} at its next step. Nothing new is granted.`;
    return (
      <div className="rounded-lg border border-edge bg-inset/40 px-3 py-2 text-xs text-fg-dim" data-testid="specialist-envelope">
        {line}
      </div>
    );
  }

  const agent = asString(input.agent) || 'specialist';
  const charter = definition?.charter;
  const tools = definition?.allowedTools ?? [];
  const canShell = tools.includes('Bash');
  const modelReq = asString(input.model);
  const modelLine = modelReq === 'budget' || modelReq === 'frontier'
    ? (tiers?.[modelReq]
        ? `the ${modelReq} model from Settings (${tiers[modelReq]!.label})`
        : `the ${modelReq} model — none is set in Settings, so it will use this conversation's model`)
    : modelReq
      ? `${modelReq} (the assistant named it)`
      : definition?.modelPreference && definition.modelPreference !== 'parent'
        ? (tiers?.[definition.modelPreference]
            ? `the ${definition.modelPreference} model from Settings (${tiers[definition.modelPreference]!.label}) — this specialist prefers it`
            : `this conversation's model (it prefers the ${definition.modelPreference} tier, which is not set)`)
        : "this conversation's model";

  return (
    <div className="rounded-lg border border-edge bg-inset/40 px-3 py-2 text-xs space-y-1" data-testid="specialist-envelope">
      <div className="font-medium text-fg-2">What Yes allows</div>
      <ul className="list-disc pl-4 space-y-0.5 text-fg-dim">
        <li>
          {definition?.displayName ?? agent} working in <span className="font-mono">{where}</span>
          {definition?.description ? ` — ${definition.description}` : ''}
        </li>
        <li>
          {charter === 'read-write'
            ? <>Can <span className="text-fg-2">edit files</span>{canShell ? <> and <span className="text-fg-2">run commands</span></> : ''} there without asking again.</>
            : charter === 'read-only'
              ? <><span className="text-fg-2">Read-only</span>: reads and searches{tools.some(t => t === 'WebFetch' || t === 'WebSearch') ? ', and browses the web' : ''}. Cannot edit files{canShell ? '' : ' or run commands'}.</>
              : <>Tools and limits for “{agent}” could not be looked up — approve only if you know this specialist.</>}
        </li>
        {tools.length > 0 && <li>Tools: {tools.join(', ')}</li>}
        <li>Runs on {modelLine}.</li>
      </ul>
      <div className="text-fg-muted">
        Deleting things, secrets, and anything outside {folder ? `${folder}/` : 'the folder'} still come to you.
      </div>
    </div>
  );
}

