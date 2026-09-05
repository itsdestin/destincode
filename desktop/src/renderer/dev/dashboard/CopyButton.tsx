import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, type ButtonVariant } from '../../components/ui';

/** Copy some text and say so. Local to the dashboard, but shared by its two
 *  callers — the workspace banner and the cleanup bar — because a copy that
 *  silently succeeds is indistinguishable from a copy that silently failed. */
export function CopyButton({ text, label, copiedLabel = 'Copied', variant = 'secondary', onError }: {
  text: () => string;
  label: string;
  copiedLabel?: string;
  variant?: ButtonVariant;
  onError?: (message: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text());
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2500);
    } catch (e) {
      // Say the real reason. The clipboard API refuses outside a secure context
      // and on a page without focus, and those need different answers.
      onError?.(`Could not copy: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [text, onError]);

  return (
    <Button variant={variant} size="sm" onClick={() => void copy()}>
      {copied ? copiedLabel : label}
    </Button>
  );
}
