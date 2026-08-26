import type { ArtifactRecord, CentralIndexProject } from '../../../../shared/artifacts/types';

// Project View and the artifact panel read these. Shapes verified against
// source 2026-07-29:
//   listProjectsIndex -> { ok, projects: CentralIndexProject[] }  (projects-index.ts:102)
//   listSession       -> { ok, artifacts: ArtifactRecord[] }      (SessionDrawer.tsx:295)
//   listAllFiles      -> { ok, files: ArtifactRecord[], truncated } (ProjectView.tsx:557)
//   get               -> { ok, content, binary?, truncated?, sizeBytes? }
//   checkExistence    -> { ok, missingIds: string[] }             (SessionDrawer.tsx:146)
//
// The extra fields on a project (fileCount, conversationCount) are only present
// when the caller passes { withCounts: true } — the mock mirrors that so the
// no-counts fast path is exercised too, rather than always over-serving.

const T = '2026-07-28T16:20:00.000Z';

function version(sessionId: string, type: 'create' | 'edit' | 'read', ts: string) {
  return { id: `v-${ts}`, ts, sessionId, type, author: 'agent' as const };
}

/** Tracked + discovered artifacts, keyed by project path. */
const BY_PROJECT: Record<string, ArtifactRecord[]> = {
  '/home/destin/youcoded-dev/youcoded': [
    {
      id: 'a-scroll-notes',
      path: 'docs/scroll-stick-notes.md',
      kind: 'internal',
      absolutePath: null,
      lastModified: T,
      status: 'active',
      versions: [
        version('wb-1', 'create', '2026-07-28T15:00:00.000Z'),
        version('wb-1', 'edit', T),
      ],
      comments: [],
      tags: [],
    },
    {
      // Over-cap TEXT, under FULL_READ_MAX_BYTES -> partial banner + "Load the
      // whole file". mock-shim's OVERSIZE_FIXTURES supplies the pretend size.
      id: 'a-big-log',
      path: 'logs/server.log',
      kind: 'internal',
      absolutePath: null,
      lastModified: T,
      status: 'active',
      versions: [version('wb-1', 'create', T)],
      comments: [],
      tags: [],
    },
    {
      // Over-cap TEXT, ABOVE the ceiling -> partial banner with no load action.
      id: 'a-huge-dump',
      path: 'logs/memory-dump.txt',
      kind: 'internal',
      absolutePath: null,
      lastModified: T,
      status: 'active',
      versions: [version('wb-1', 'create', T)],
      comments: [],
      tags: [],
    },
    {
      // A format YouCoded has no viewer for -> the handoff state.
      id: 'a-clip-mp4',
      path: 'media/demo-clip.mp4',
      kind: 'internal',
      absolutePath: null,
      lastModified: T,
      status: 'active',
      versions: [version('wb-1', 'create', T)],
      comments: [],
      tags: [],
    },
    {
      id: 'a-chatview',
      path: 'desktop/src/renderer/components/ChatView.tsx',
      kind: 'internal',
      absolutePath: null,
      lastModified: '2026-07-28T16:05:00.000Z',
      status: 'active',
      versions: [version('wb-1', 'edit', '2026-07-28T16:05:00.000Z')],
      comments: [],
      tags: [],
    },
    {
      // A `read` version: opened but never modified. Renders differently from an
      // edit, and nothing else in the fixture set covers that branch.
      id: 'a-pitfalls',
      path: 'docs/PITFALLS.md',
      kind: 'internal',
      absolutePath: null,
      lastModified: '2026-07-27T09:00:00.000Z',
      status: 'active',
      versions: [version('wb-1', 'read', '2026-07-27T09:00:00.000Z')],
      comments: [],
      tags: [],
    },
    {
      // status:'deleted' — the orphan/deleted treatment is otherwise invisible.
      id: 'a-old-plan',
      path: 'docs/old-approach.md',
      kind: 'internal',
      absolutePath: null,
      lastModified: '2026-07-20T11:00:00.000Z',
      status: 'deleted',
      versions: [version('wb-1', 'create', '2026-07-20T11:00:00.000Z')],
      comments: [],
      tags: [],
    },
    {
      // kind:'external' — lives outside the project root, so it carries an
      // absolutePath and renders with the external badge.
      id: 'a-external-notes',
      path: 'scratch.md',
      kind: 'external',
      absolutePath: '/home/destin/scratch.md',
      lastModified: '2026-07-26T08:30:00.000Z',
      status: 'active',
      versions: [version('wb-1', 'edit', '2026-07-26T08:30:00.000Z')],
      comments: [],
      tags: [],
    },
  ],
  '/home/destin/youcoded-dev/wecoded-themes': [
    {
      id: 'a-contrast-report',
      path: 'reports/contrast-audit.md',
      kind: 'internal',
      absolutePath: null,
      lastModified: '2026-07-28T14:00:00.000Z',
      status: 'active',
      versions: [version('wb-2', 'create', '2026-07-28T14:00:00.000Z')],
      comments: [],
      tags: [],
    },
    {
      id: 'a-halftone-manifest',
      path: 'themes/halftone-dimension/manifest.json',
      kind: 'internal',
      absolutePath: null,
      lastModified: '2026-07-28T13:10:00.000Z',
      status: 'active',
      versions: [version('wb-2', 'edit', '2026-07-28T13:10:00.000Z')],
      comments: [],
      tags: [],
    },
  ],
};

/** Files discovered on disk that Claude never tracked. `discovered: true` means
 *  consumers skip orphan/existence checks and resolve content BY PATH — id is
 *  the canonical relative path, not a ULID (shared/artifacts/types.ts). */
function discovered(path: string, lastModified: string): ArtifactRecord {
  return {
    id: path,
    path,
    kind: 'internal',
    absolutePath: null,
    lastModified,
    status: 'active',
    versions: [],
    comments: [],
    tags: [],
    discovered: true,
  };
}

const DISCOVERED: Record<string, ArtifactRecord[]> = {
  '/home/destin/youcoded-dev/youcoded': [
    discovered('README.md', '2026-07-10T10:00:00.000Z'),
    discovered('docs/build-and-release.md', '2026-07-22T10:00:00.000Z'),
    discovered('docs/android-runtime.md', '2026-07-19T10:00:00.000Z'),
    discovered('desktop/docs/theme-spec.md', '2026-07-05T10:00:00.000Z'),
  ],
  '/home/destin/youcoded-dev/wecoded-themes': [
    discovered('README.md', '2026-07-12T10:00:00.000Z'),
    discovered('CONTRIBUTING.md', '2026-06-30T10:00:00.000Z'),
  ],
  '/home/destin/youcoded-dev/wecoded-marketplace': [
    discovered('README.md', '2026-07-15T10:00:00.000Z'),
  ],
};

export function projects(): CentralIndexProject[] {
  return [
    {
      id: '/home/destin/youcoded-dev/youcoded',
      name: 'youcoded',
      path: '/home/destin/youcoded-dev/youcoded',
      lastIndexed: T,
      lastSession: 'wb-1',
      contentTypes: ['artifacts', 'conversations'],
      stats: { artifactCount: 5 },
    },
    {
      id: '/home/destin/youcoded-dev/wecoded-themes',
      name: 'wecoded-themes',
      path: '/home/destin/youcoded-dev/wecoded-themes',
      lastIndexed: '2026-07-28T14:00:00.000Z',
      lastSession: 'wb-2',
      contentTypes: ['artifacts', 'conversations'],
      stats: { artifactCount: 2 },
    },
    {
      // Never indexed, no artifacts — the empty-project state inside an
      // otherwise-populated view, which is where layout usually breaks.
      id: '/home/destin/youcoded-dev/wecoded-marketplace',
      name: 'wecoded-marketplace',
      path: '/home/destin/youcoded-dev/wecoded-marketplace',
      lastIndexed: '',
      lastSession: null,
      contentTypes: [],
      stats: { artifactCount: 0 },
    },
  ];
}

/** Counts are computed live by the real handler, so mirror that rather than
 *  hardcoding a number that can disagree with the arrays above. */
export function projectsWithCounts(): CentralIndexProject[] {
  return projects().map((p) => ({
    ...p,
    stats: { ...p.stats, artifactCount: (BY_PROJECT[p.path] ?? []).length },
    fileCount: (DISCOVERED[p.path] ?? []).length + (BY_PROJECT[p.path] ?? []).length,
    conversationCount: p.path.endsWith('youcoded') ? 5 : 1,
  }));
}

export function sessionArtifacts(sessionId: string): ArtifactRecord[] {
  // Session ids come from fixtures/sessions.ts; wb-1 works in youcoded, wb-2 in
  // wecoded-themes, matching each session's cwd.
  if (sessionId === 'wb-2') return BY_PROJECT['/home/destin/youcoded-dev/wecoded-themes'];
  return BY_PROJECT['/home/destin/youcoded-dev/youcoded'];
}

export function allFiles(projectId: string): ArtifactRecord[] {
  return [...(BY_PROJECT[projectId] ?? []), ...(DISCOVERED[projectId] ?? [])];
}

/** Content served by artifacts.get(). Keyed by artifact id. Long enough to
 *  scroll and to exercise markdown rendering, since a two-line file makes every
 *  reader look fine. */
export const CONTENT: Record<string, string> = {
  // Over-cap fixtures: mock-shim slices these and reports a much larger
  // sizeBytes, so the partial-view states are reachable without an 8 MB file.
  'a-big-log': `2026-08-25T14:00:00Z  INFO  request 1000 handled in 0ms\n2026-08-25T14:01:01Z  INFO  request 1001 handled in 3ms\n2026-08-25T14:02:02Z  INFO  request 1002 handled in 6ms\n2026-08-25T14:03:03Z  INFO  request 1003 handled in 9ms\n2026-08-25T14:04:04Z  INFO  request 1004 handled in 12ms\n2026-08-25T14:05:05Z  INFO  request 1005 handled in 15ms\n2026-08-25T14:06:06Z  INFO  request 1006 handled in 18ms\n2026-08-25T14:07:07Z  INFO  request 1007 handled in 21ms\n2026-08-25T14:08:08Z  INFO  request 1008 handled in 24ms\n2026-08-25T14:09:09Z  INFO  request 1009 handled in 27ms\n2026-08-25T14:10:00Z  INFO  request 1010 handled in 30ms\n2026-08-25T14:11:01Z  INFO  request 1011 handled in 33ms\n2026-08-25T14:12:02Z  INFO  request 1012 handled in 36ms\n2026-08-25T14:13:03Z  INFO  request 1013 handled in 39ms\n2026-08-25T14:14:04Z  INFO  request 1014 handled in 42ms\n2026-08-25T14:15:05Z  INFO  request 1015 handled in 45ms\n2026-08-25T14:16:06Z  INFO  request 1016 handled in 48ms\n2026-08-25T14:17:07Z  INFO  request 1017 handled in 51ms\n2026-08-25T14:18:08Z  INFO  request 1018 handled in 54ms\n2026-08-25T14:19:09Z  INFO  request 1019 handled in 57ms\n2026-08-25T14:20:00Z  INFO  request 1020 handled in 60ms\n2026-08-25T14:21:01Z  INFO  request 1021 handled in 63ms\n2026-08-25T14:22:02Z  INFO  request 1022 handled in 66ms\n2026-08-25T14:23:03Z  INFO  request 1023 handled in 69ms\n2026-08-25T14:24:04Z  INFO  request 1024 handled in 72ms\n2026-08-25T14:25:05Z  INFO  request 1025 handled in 75ms\n2026-08-25T14:26:06Z  INFO  request 1026 handled in 78ms\n2026-08-25T14:27:07Z  INFO  request 1027 handled in 81ms\n2026-08-25T14:28:08Z  INFO  request 1028 handled in 84ms\n2026-08-25T14:29:09Z  INFO  request 1029 handled in 87ms\n2026-08-25T14:30:00Z  INFO  request 1030 handled in 90ms\n2026-08-25T14:31:01Z  INFO  request 1031 handled in 93ms\n2026-08-25T14:32:02Z  INFO  request 1032 handled in 96ms\n2026-08-25T14:33:03Z  INFO  request 1033 handled in 99ms\n2026-08-25T14:34:04Z  INFO  request 1034 handled in 102ms\n2026-08-25T14:35:05Z  INFO  request 1035 handled in 105ms\n2026-08-25T14:36:06Z  INFO  request 1036 handled in 108ms\n2026-08-25T14:37:07Z  INFO  request 1037 handled in 111ms\n2026-08-25T14:38:08Z  INFO  request 1038 handled in 114ms\n2026-08-25T14:39:09Z  INFO  request 1039 handled in 117ms`,
  'a-huge-dump': `2026-08-25T14:00:00Z  INFO  request 1000 handled in 0ms\n2026-08-25T14:01:01Z  INFO  request 1001 handled in 3ms\n2026-08-25T14:02:02Z  INFO  request 1002 handled in 6ms\n2026-08-25T14:03:03Z  INFO  request 1003 handled in 9ms\n2026-08-25T14:04:04Z  INFO  request 1004 handled in 12ms\n2026-08-25T14:05:05Z  INFO  request 1005 handled in 15ms\n2026-08-25T14:06:06Z  INFO  request 1006 handled in 18ms\n2026-08-25T14:07:07Z  INFO  request 1007 handled in 21ms\n2026-08-25T14:08:08Z  INFO  request 1008 handled in 24ms\n2026-08-25T14:09:09Z  INFO  request 1009 handled in 27ms\n2026-08-25T14:10:00Z  INFO  request 1010 handled in 30ms\n2026-08-25T14:11:01Z  INFO  request 1011 handled in 33ms\n2026-08-25T14:12:02Z  INFO  request 1012 handled in 36ms\n2026-08-25T14:13:03Z  INFO  request 1013 handled in 39ms\n2026-08-25T14:14:04Z  INFO  request 1014 handled in 42ms\n2026-08-25T14:15:05Z  INFO  request 1015 handled in 45ms\n2026-08-25T14:16:06Z  INFO  request 1016 handled in 48ms\n2026-08-25T14:17:07Z  INFO  request 1017 handled in 51ms\n2026-08-25T14:18:08Z  INFO  request 1018 handled in 54ms\n2026-08-25T14:19:09Z  INFO  request 1019 handled in 57ms\n2026-08-25T14:20:00Z  INFO  request 1020 handled in 60ms\n2026-08-25T14:21:01Z  INFO  request 1021 handled in 63ms\n2026-08-25T14:22:02Z  INFO  request 1022 handled in 66ms\n2026-08-25T14:23:03Z  INFO  request 1023 handled in 69ms\n2026-08-25T14:24:04Z  INFO  request 1024 handled in 72ms\n2026-08-25T14:25:05Z  INFO  request 1025 handled in 75ms\n2026-08-25T14:26:06Z  INFO  request 1026 handled in 78ms\n2026-08-25T14:27:07Z  INFO  request 1027 handled in 81ms\n2026-08-25T14:28:08Z  INFO  request 1028 handled in 84ms\n2026-08-25T14:29:09Z  INFO  request 1029 handled in 87ms\n2026-08-25T14:30:00Z  INFO  request 1030 handled in 90ms\n2026-08-25T14:31:01Z  INFO  request 1031 handled in 93ms\n2026-08-25T14:32:02Z  INFO  request 1032 handled in 96ms\n2026-08-25T14:33:03Z  INFO  request 1033 handled in 99ms\n2026-08-25T14:34:04Z  INFO  request 1034 handled in 102ms\n2026-08-25T14:35:05Z  INFO  request 1035 handled in 105ms\n2026-08-25T14:36:06Z  INFO  request 1036 handled in 108ms\n2026-08-25T14:37:07Z  INFO  request 1037 handled in 111ms\n2026-08-25T14:38:08Z  INFO  request 1038 handled in 114ms\n2026-08-25T14:39:09Z  INFO  request 1039 handled in 117ms`,
  'a-scroll-notes': `# Scroll stick — working notes

The chat view re-arms its stick-to-bottom check on **every** scroll event, so
scrolling up fights the auto-scroll.

## What we know

- \`ChatView.tsx\` calls the re-arm check inline in \`onScroll\`.
- The check reads \`scrollHeight\`, which forces layout on every wheel tick.
- At 200+ timeline entries the jank is visible; below ~40 it is not, which is
  why this only reproduces on long conversations.

## Options considered

| Option | Verdict |
|---|---|
| Throttle the handler | Chosen — smallest change, no behaviour shift |
| IntersectionObserver sentinel | Better long-term, bigger diff |
| Disable auto-scroll entirely | Rejected, regresses the common case |

## Next

Move the check off the hot path and re-measure with the stress fixture.
`,
  'a-contrast-report': `# Contrast audit — crème

Ran \`scripts/audit-theme-contrast.mjs\` against every token pair.

    creme: fg-dim   3.10:1  PASS
    creme: fg-muted 4.62:1  PASS
    creme: link     3.59:1  PASS
    creme: on-accent 7.11:1 PASS

All pairs clear the 3:1 floor for large text. \`fg-dim\` is closest to the line
and should not be darkened further without re-running this.
`,
  'a-pitfalls': `# Pitfalls

Read-only in this session — no edits were made.

- IPC parity: preload, remote-shim and SessionService must agree.
- Chat reducer: \`USER_PROMPT\` is optimistic; the transcript clears \`pending\`.
`,
  'README.md': `# YouCoded

Cross-platform AI assistant app. Desktop (Electron) and Android (Kotlin) share
one React renderer.

## Getting started

    bash setup.sh
    cd youcoded/desktop && npm ci && npm test
`,
  'a-chatview': `import React, { useRef, useCallback } from 'react';

// Chat timeline. Owns its own scroll container so the terminal pane can own
// its scroll independently.
export function ChatView({ sessionId }) {
  const ref = useRef(null);
  const stick = useRef(true);

  // Re-arm stick-to-bottom only when the user lands at the bottom. Throttled:
  // reading scrollHeight forces layout, and this used to run on every event.
  const onScroll = useCallback(throttle(() => {
    const el = ref.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
  }, 100), []);

  return <div ref={ref} onScroll={onScroll} className="flex-1 overflow-y-auto" />;
}
`,
  'a-old-plan': `# Old approach (superseded)

Kept for reference. We first tried disabling auto-scroll entirely, which fixed
the jank and broke the common case: new messages no longer came into view.

Superseded by the throttled re-arm in scroll-stick-notes.md.
`,
  'a-external-notes': `# Scratch

Lives outside the project root, so it is tracked as an *external* artifact and
carries an absolute path.

- check whether the re-arm threshold should be 32px or 48px
- ask Destin which feels right on the touchpad
`,
  'a-halftone-manifest': `{
  "name": "Halftone Dimension",
  "slug": "halftone-dimension",
  "source": "community",
  "colors": { "accent": "#FF2E88", "canvas": "#0B0B14" },
  "radii": { "lg": "18px" }
}
`,
  'docs/build-and-release.md': `# Build and release

Desktop and Android build from one tag.

    cd youcoded/desktop && npm ci && npm test && npm run build

Release builds run in CI; do not cut one by hand.
`,
  'docs/android-runtime.md': `# Android runtime

The WebView loads the same React bundle as desktop. The vendored terminal
module owns the PTY and pushes raw bytes over a WebSocket event.
`,
  'desktop/docs/theme-spec.md': `# Theme spec

Themes are semantic CSS custom properties toggled by a data-theme attribute on
the html element. Status colors stay hardcoded; only surface, text and border
tokens are themed.
`,
  'CONTRIBUTING.md': `# Contributing

Themes are submitted as a manifest plus assets. Run the contrast audit before
opening a PR — the gate rejects anything under 3:1.
`,
};

/** Project View's Context tab. Shape from shared/project-context-types.ts.
 *  Only the youcoded project carries context files — a project with none is
 *  the state that shows the tab's empty copy, and that is worth being able to
 *  see next to a populated one. */
export function contextGroups(projectPath: string) {
  if (!projectPath.endsWith('/youcoded')) return [];
  return [
    {
      scope: 'project' as const,
      files: [
        {
          id: `project:${projectPath}/CLAUDE.md`,
          scope: 'project' as const,
          kind: 'claude-md' as const,
          label: 'CLAUDE.md',
          absolutePath: `${projectPath}/CLAUDE.md`,
          timing: 'always' as const,
          editable: true,
          blastRadius: 'project' as const,
          description: 'Repo guidance — desktop + Android layout, IPC parity rules.',
          size: '4.1 KB',
        },
        {
          id: `project:${projectPath}/.claude/rules/react-renderer.md`,
          scope: 'project' as const,
          kind: 'rule' as const,
          label: 'react-renderer',
          absolutePath: `${projectPath}/.claude/rules/react-renderer.md`,
          timing: 'conditional' as const,
          glob: 'desktop/src/renderer/**',
          editable: true,
          blastRadius: 'project' as const,
          description: 'Primitives, overlays, and the UI iteration tooling.',
          size: '6.8 KB',
        },
      ],
    },
    {
      scope: 'global' as const,
      files: [
        {
          id: 'global:/home/destin/.claude/CLAUDE.md',
          scope: 'global' as const,
          kind: 'claude-md' as const,
          label: 'CLAUDE.md',
          absolutePath: '/home/destin/.claude/CLAUDE.md',
          timing: 'always-everywhere' as const,
          editable: true,
          blastRadius: 'global' as const,
          description: 'Personal instructions applied in every project.',
          size: '0.4 KB',
        },
      ],
    },
  ];
}
