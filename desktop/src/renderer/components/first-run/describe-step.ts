import type { FirstRunState, PrerequisiteState } from '../../../shared/first-run-types';

// Per-prerequisite copy. Keys match PrerequisiteState.name.
const PREREQ_COPY: Record<string, string> = {
  node: 'Installing Node.js — this runs the AI engine under the hood.',
  git: 'Installing Git — used to keep YouCoded and your skills up to date.',
  claude: 'Installing Claude Code — the AI that powers YouCoded.',
};

function activePrerequisite(prereqs: PrerequisiteState[]): PrerequisiteState | undefined {
  return prereqs.find(
    (p) => p.status === 'installing' || p.status === 'checking',
  );
}

/**
 * Single-sentence explainer for the first-run screen. Tells the user
 * what's happening right now and why, scoped to the current state.
 */
export function describeStep(state: FirstRunState): string {
  if (state.lastError) {
    return 'Something went wrong. You can retry the last step or skip for now.';
  }

  switch (state.currentStep) {
    case 'DETECT_PREREQUISITES':
      return "Checking what's already installed on this machine.";

    case 'INSTALL_PREREQUISITES': {
      const active = activePrerequisite(state.prerequisites);
      if (active && PREREQ_COPY[active.name]) {
        return PREREQ_COPY[active.name];
      }
      return 'Getting the next piece ready…';
    }

    case 'AUTHENTICATE':
      // Sign in with ChatGPT (design 2026-09-04): either plan finishes setup.
      return 'Sign in with your Claude, ChatGPT or OpenRouter account to finish setup.';

    case 'ENABLE_DEVELOPER_MODE':
      return "One Windows setting to enable, then we're done.";

    case 'LAUNCH_WIZARD':
    case 'COMPLETE':
      return 'All set. Opening YouCoded…';

    default: {
      // Exhaustiveness check — if a new FirstRunStep is added the compiler
      // flags this. The binding is the check itself; the underscore prefix
      // doesn't suppress noUnusedLocals, so we use @ts-ignore for this line.
      // @ts-ignore — TS6133: the binding IS the exhaustiveness check
      const _exhaustive: never = state.currentStep;
      return '';
    }
  }
}
