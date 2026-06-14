// ArtifactThumbnail — mini pre-render for an artifact card in Project View.
// Strategy by file type:
//   - Images (png/jpg/gif/webp/svg/bmp/ico/avif) → <img src="file://…">
//     (Electron loads local files directly; no IPC needed.)
//   - Markdown / plain text → fetch content via artifacts.get, render first
//     ~8 lines as tiny monospace text.
//   - HTML / htm → sandboxed <iframe srcDoc> with pointer-events: none so the
//     parent card stays clickable. The empty sandbox attribute blocks scripts.
//   - Everything else → fall back to the original ext-letter glyph.
// Content-fetching is gated by an IntersectionObserver so a project with
// hundreds of artifacts doesn't issue hundreds of IPC reads on mount.
// Images render eagerly (Chromium handles lazy decoding via loading="lazy").
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ArtifactRecord } from '../../shared/artifacts/types';

interface Props {
  artifact: ArtifactRecord;
  projectPath: string;
  className?: string;
  // Background utility for the thumbnail container. Defaults to bg-inset (the
  // Project View grid look). The tool-call preview card passes bg-canvas so the
  // thumbnail reads as recessed inside the raised bg-inset card.
  bgClass?: string;
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']);
const TEXT_EXTS = new Set(['md', 'markdown', 'txt', 'rtf']);
const HTML_EXTS = new Set(['html', 'htm']);

type Kind = 'image' | 'text' | 'html' | 'fallback';

function getExt(p: string): string {
  const filename = p.split(/[\\/]/).pop() ?? '';
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : '';
}

// Build an absolute path for an internal artifact. External artifacts already
// have absolutePath populated. Uses whichever separator the project path uses
// so we don't mix slashes on Windows.
function joinPath(projectPath: string, relPath: string): string {
  if (!projectPath) return relPath;
  const sep = projectPath.includes('\\') ? '\\' : '/';
  const cleanProject = projectPath.replace(/[\\/]+$/, '');
  const cleanRel = relPath.replace(/^[\\/]+/, '');
  return `${cleanProject}${sep}${cleanRel}`;
}

// Match ImageView's existing pattern: file://<absolutePath>. Forward-slash
// normalization avoids a mix of \ and / in the URL on Windows.
function toFileUrl(absPath: string): string {
  return `file://${absPath.replace(/\\/g, '/')}`;
}

export function ArtifactThumbnail({ artifact, projectPath, className = '', bgClass = 'bg-inset' }: Props) {
  const ext = getExt(artifact.path);
  const kind: Kind = useMemo(() => {
    if (IMAGE_EXTS.has(ext)) return 'image';
    if (TEXT_EXTS.has(ext)) return 'text';
    if (HTML_EXTS.has(ext)) return 'html';
    return 'fallback';
  }, [ext]);

  const containerRef = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const [imgFailed, setImgFailed] = useState(false);
  // Measured container size, used to scale the HTML iframe preview down so the
  // whole page (rendered at a desktop logical width) fits the small card.
  const [boxSize, setBoxSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  const absolutePath = artifact.kind === 'internal'
    ? joinPath(projectPath, artifact.path)
    : artifact.absolutePath;

  // IntersectionObserver gate: only fetch content once the card scrolls into
  // view (or close to it). Images skip this — Chromium's loading="lazy" plus
  // file:// reads are already cheap and don't go through IPC.
  useEffect(() => {
    if (kind === 'image' || kind === 'fallback') return;
    const node = containerRef.current;
    if (!node) return;
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          obs.disconnect();
        }
      },
      { rootMargin: '100px' }, // pre-fetch 100px before visible — feels instant on scroll
    );
    obs.observe(node);
    return () => obs.disconnect();
  }, [kind]);

  // Fetch content once visible. Refetch when the artifact's lastModified
  // changes so an edit in another window updates the thumbnail.
  useEffect(() => {
    if (!inView || (kind !== 'text' && kind !== 'html')) return;
    let cancelled = false;
    (window.claude as any).artifacts.get(projectPath, artifact.id)
      .then((res: any) => {
        if (cancelled) return;
        if (res && res.ok) setContent(res.content ?? '');
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [inView, kind, projectPath, artifact.id, artifact.lastModified]);

  // Measure the thumbnail box so the HTML iframe can be rendered at a desktop
  // logical width and scaled to fit (a true zoomed-out webpage thumbnail rather
  // than a cropped top-left fragment). Only needed for the html branch.
  useEffect(() => {
    if (kind !== 'html') return;
    const node = containerRef.current;
    if (!node) return;
    const measure = () => setBoxSize({ w: node.clientWidth, h: node.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(node);
    return () => ro.disconnect();
  }, [kind]);

  // Render the HTML page at this logical width, then scale down to the card.
  const HTML_DESIGN_WIDTH = 1100;
  const htmlScale = boxSize.w > 0 ? boxSize.w / HTML_DESIGN_WIDTH : 0.16;

  const showFallbackGlyph =
    kind === 'fallback' ||
    (kind === 'image' && (imgFailed || !absolutePath)) ||
    ((kind === 'text' || kind === 'html') && content === null);

  return (
    <div
      ref={containerRef}
      className={`relative flex items-center justify-center ${bgClass} overflow-hidden ${className}`}
    >
      {showFallbackGlyph && (
        <span className="text-2xl font-mono text-fg-muted">{ext ? ext.toUpperCase() : '—'}</span>
      )}

      {kind === 'image' && absolutePath && !imgFailed && (
        <img
          src={toFileUrl(absolutePath)}
          alt=""
          loading="lazy"
          decoding="async"
          className="w-full h-full object-cover"
          onError={() => setImgFailed(true)}
        />
      )}

      {kind === 'text' && content !== null && (
        // First ~8 lines, monospace, very small — readable enough to identify
        // a plan / walkthrough / note at a glance. whitespace-pre-wrap so long
        // lines wrap inside the card instead of overflowing horizontally.
        <pre className="absolute inset-0 m-0 p-2 text-[8px] leading-tight font-mono text-fg-2 overflow-hidden whitespace-pre-wrap break-words">
          {content.split('\n').slice(0, 8).join('\n')}
        </pre>
      )}

      {kind === 'html' && content !== null && (
        // Render the page at a desktop logical width (HTML_DESIGN_WIDTH) and
        // scale it down to the card so the WHOLE page is visible as a zoomed-out
        // thumbnail, instead of a 1:1 cropped top-left fragment. Empty sandbox =
        // scripts disabled; pointer-events none keeps the parent <button> clickable.
        <iframe
          srcDoc={content}
          sandbox=""
          loading="lazy"
          title=""
          className="absolute top-0 left-0 border-0 pointer-events-none bg-white origin-top-left"
          style={{
            width: HTML_DESIGN_WIDTH,
            // Height in logical px that, once scaled, fills the box exactly.
            height: boxSize.h > 0 ? boxSize.h / htmlScale : HTML_DESIGN_WIDTH,
            transform: `scale(${htmlScale})`,
          }}
        />
      )}
    </div>
  );
}
