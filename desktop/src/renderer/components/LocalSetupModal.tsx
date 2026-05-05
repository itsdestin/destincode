import { useEffect, useState } from 'react';

interface Props {
  onClose: () => void;
  endpoint?: string;   // configured Ollama endpoint
}

type Phase =
  | 'check'
  | 'install-ollama'
  | 'pull-model'
  | 'install-opencode'
  | 'write-config'
  | 'done'
  | 'error'
  | 'cancelled';

export function LocalSetupModal({ onClose, endpoint }: Props) {
  const [phase, setPhase] = useState<Phase>('check');
  const [progress, setProgress] = useState<{ pct?: number; message?: string }>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    const cancelled = () => ac.signal.aborted;
    const local = (window.claude as any).local;

    // Wrap in an async IIFE — bare `await` is not valid in a sync useEffect body.
    (async () => {
      if (!local || !local.supported) {
        setError('Local mode is only available on the desktop app.');
        setPhase('error');
        return;
      }

      try {
        // Phase 1: Ollama install (skipped if Ollama is already reachable)
        const ollamaUp = await local.isOllamaInstalled(endpoint);
        if (cancelled()) { setPhase('cancelled'); return; }
        if (!ollamaUp) {
          setPhase('install-ollama');
          setProgress({});
          // Subscribe to progress; unsubscribe in finally so it always runs
          // even if the install throws. off() is called whether or not the
          // onInstallOllamaProgress stub returns a cleanup function.
          const off = local.onInstallOllamaProgress((ev: any) => {
            if (!cancelled()) setProgress(ev);
          });
          let resOllama;
          try {
            resOllama = await local.installOllama();
          } finally {
            off?.();
          }
          if (cancelled()) { setPhase('cancelled'); return; }
          if (!resOllama?.ok) { setError(resOllama?.error || 'Ollama install failed'); setPhase('error'); return; }
        }

        // Phase 2: Model pull — default to qwen3:8b if no models are installed
        const ml = await local.listOllamaModels(endpoint);
        if (cancelled()) { setPhase('cancelled'); return; }
        if (!ml?.reachable || (ml?.models ?? []).length === 0) {
          setPhase('pull-model');
          setProgress({});
          const off = local.onPullModelProgress((ev: any) => {
            if (!cancelled()) setProgress(ev);
          });
          let resModel;
          try {
            resModel = await local.pullModel('qwen3:8b', endpoint);
          } finally {
            off?.();
          }
          if (cancelled()) { setPhase('cancelled'); return; }
          if (!resModel?.ok) { setError(resModel?.error || 'Model pull failed'); setPhase('error'); return; }
        }

        // Phase 3: OpenCode binary install (skipped if already installed)
        const ocUp = await local.isOpenCodeInstalled();
        if (cancelled()) { setPhase('cancelled'); return; }
        if (!ocUp) {
          setPhase('install-opencode');
          setProgress({});
          const off = local.onInstallOpenCodeProgress((ev: any) => {
            if (!cancelled()) setProgress(ev);
          });
          let resOC;
          try {
            resOC = await local.installOpenCode();
          } finally {
            off?.();
          }
          if (cancelled()) { setPhase('cancelled'); return; }
          if (!resOC?.ok) { setError(resOC?.error || 'OpenCode install failed'); setPhase('error'); return; }
        }

        // Phase 4: Write OpenCode config (declares Ollama provider, sets allow-all permission)
        setPhase('write-config');
        setProgress({});
        const cfgRes = await local.writeOpenCodeConfig({
          ollamaBaseUrl: endpoint || 'http://localhost:11434',
        });
        if (cancelled()) { setPhase('cancelled'); return; }
        if (!cfgRes?.ok) { setError(cfgRes?.error || 'Config write failed'); setPhase('error'); return; }

        setPhase('done');
      } catch (e: any) {
        if (cancelled()) { setPhase('cancelled'); return; }
        setError(String(e?.message ?? e));
        setPhase('error');
      }
    })();

    // Cleanup on unmount: abort the controller. The async IIFE checks
    // cancelled() at every await boundary so it bails cleanly without firing
    // onProgress callbacks against an unmounted component.
    return () => { ac.abort(); };
  }, [endpoint]);

  // Body copy per phase
  const renderBody = () => {
    switch (phase) {
      case 'check':
        return <div className="text-sm">Checking local-mode prerequisites…</div>;
      case 'install-ollama':
        return (
          <div className="text-sm">
            Installing Ollama…
            <div className="text-fg-muted text-xs mt-1">{progress.message ?? ''}</div>
            {progress.pct != null && (
              <div className="mt-2 h-1 w-full bg-inset rounded overflow-hidden">
                <div className="h-1 bg-accent" style={{ width: `${progress.pct}%` }} />
              </div>
            )}
          </div>
        );
      case 'pull-model':
        return (
          <div className="text-sm">
            Downloading Qwen 3 8B (~5 GB)…
            <div className="text-fg-muted text-xs mt-1">{progress.message ?? ''}</div>
            {progress.pct != null && (
              <div className="mt-2 h-1 w-full bg-inset rounded overflow-hidden">
                <div className="h-1 bg-accent" style={{ width: `${progress.pct}%` }} />
              </div>
            )}
          </div>
        );
      case 'install-opencode':
        return (
          <div className="text-sm">
            Installing OpenCode…
            <div className="text-fg-muted text-xs mt-1">{progress.message ?? ''}</div>
            {progress.pct != null && (
              <div className="mt-2 h-1 w-full bg-inset rounded overflow-hidden">
                <div className="h-1 bg-accent" style={{ width: `${progress.pct}%` }} />
              </div>
            )}
          </div>
        );
      case 'write-config':
        return <div className="text-sm">Writing OpenCode config…</div>;
      case 'done':
        return (
          <div className="text-sm">
            Local mode is ready. Create a Local session from the new-session form to get started.
          </div>
        );
      case 'cancelled':
        return <div className="text-sm text-fg-muted">Setup cancelled.</div>;
      case 'error':
        return (
          <div className="text-sm text-red-500">
            Setup error: {error}
          </div>
        );
    }
  };

  const closeLabel = (phase === 'done' || phase === 'error' || phase === 'cancelled') ? 'Close' : 'Cancel';

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-panel border border-edge rounded-lg p-6 w-[28rem] max-w-[90vw]">
        <h2 className="text-lg font-semibold mb-3">Local Mode Setup</h2>
        {renderBody()}
        <button
          onClick={onClose}
          className="mt-4 px-3 py-1 bg-accent hover:bg-accent text-on-accent rounded text-sm"
        >
          {closeLabel}
        </button>
      </div>
    </div>
  );
}
