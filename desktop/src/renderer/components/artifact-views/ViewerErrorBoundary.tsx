import React from 'react';
import { Button } from '../ui';

// Error boundary around the artifact viewer render. Two failure modes land
// here that <Suspense> can NOT catch:
//   1. React.lazy chunk-load failures (offline Android WebView, a stale tab
//      after a redeploy) — lazy() THROWS the rejection; Suspense only handles
//      the pending promise.
//   2. A viewer component throwing during render on pathological input.
// Without this boundary either one propagates to the app root and blanks the
// whole panel. Keyed by artifact in ActiveArtifactView so switching files
// retries cleanly.
interface Props {
  path: string;
  children: React.ReactNode;
}

export class ViewerErrorBoundary extends React.Component<Props, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error('[ViewerErrorBoundary] viewer crashed', this.props.path, error);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex flex-col items-center justify-center h-full p-8 text-fg-muted text-sm text-center">
          <p className="mb-2">Couldn’t display this file.</p>
          <p className="mb-4 font-mono text-xs break-all">{this.props.path}</p>
          <Button variant="secondary" onClick={() => this.setState({ error: null })}>
            Try again
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}
