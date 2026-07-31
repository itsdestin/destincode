import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import type { ArtifactState } from './artifact-tracker';
import type { ArtifactAction } from './artifact-actions';

interface ArtifactContextValue {
  state: ArtifactState;
  dispatch: React.Dispatch<ArtifactAction>;
}

export const ArtifactContext = createContext<ArtifactContextValue | null>(null);

export function useArtifact(): ArtifactContextValue {
  const ctx = useContext(ArtifactContext);
  if (!ctx) throw new Error('useArtifact must be used inside ArtifactContext.Provider');
  return ctx;
}

// Non-throwing variant for components that can render in React roots WITHOUT
// the provider — the buddy window (BubbleFeed), the workbench tool gallery, and
// unit tests all mount AssistantTurnBubble / ToolCard without ArtifactProvider.
// Returns null there so file chips / tool previews degrade gracefully instead
// of crashing the whole window.
export function useArtifactOptional(): ArtifactContextValue | null {
  return useContext(ArtifactContext);
}

export function ArtifactProvider({
  value,
  children,
}: {
  value: ArtifactContextValue;
  children: ReactNode;
}) {
  return <ArtifactContext.Provider value={value}>{children}</ArtifactContext.Provider>;
}
