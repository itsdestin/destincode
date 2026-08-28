// Binds the two pure readers to THIS device's folders.
//
// One place on purpose: the Electron IPC handler and the remote WebSocket case
// both call these, and if each did its own path assembly they would drift —
// which on this feature means a conversation that previews over the desktop and
// refuses over the phone, with nothing to say why.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { chatsearchDir } from './index-store';
import { readMetaFile, resolveShortIds } from './meta-reader';
import { readTranscriptSlice, type ParsedCacheEntry } from './transcript-reader';
import { buildLocalProjectResolver } from '../conversations/service';
import { getManagedRoots } from '../sync-spaces/service';
import { ccProjectSlug, nativeStoreSlug } from '../slug-encoding';
import { NativeHome } from '../native-home';
import type {
  ChatsearchProvider, ChatsearchReadRequest, ChatsearchReadResponse, ResolvedConversation,
} from '../../shared/chatsearch-refs';

const CLAUDE_PROJECTS = () => path.join(os.homedir(), '.claude', 'projects');
const NATIVE_SESSIONS = () => path.join(new NativeHome().root, 'sessions');

// Lives for the process, not the request: "Load older" is a second call for the
// same file, and re-parsing a large transcript per page is the cost this exists
// to avoid. Bounded inside readTranscriptSlice.
const parseCache = new Map<string, ParsedCacheEntry>();

function localTranscriptPath(provider: ChatsearchProvider, localPath: string, id: string): string {
  return provider === 'native'
    ? path.join(NATIVE_SESSIONS(), nativeStoreSlug(localPath), `${id}.jsonl`)
    : path.join(CLAUDE_PROJECTS(), ccProjectSlug(localPath), `${id}.jsonl`);
}

export function resolveConversations(shortIds: unknown): { ok: true; results: ResolvedConversation[] } | { ok: false; error: string } {
  // A card resolves the ids from one search. A hundred is far past anything the
  // CLI prints, so a larger list is a caller bug, not a big search.
  if (!Array.isArray(shortIds) || shortIds.length > 100) return { ok: false, error: 'Expected up to 100 ids' };
  const resolveLocal = buildLocalProjectResolver();
  return {
    ok: true,
    results: resolveShortIds(shortIds.map(String), {
      dir: chatsearchDir(os.homedir()),
      resolveLocal,
      transcriptExistsLocally: (p, local, id) => fs.existsSync(localTranscriptPath(p, local, id)),
      slugFor: (p, local) => (p === 'native' ? nativeStoreSlug(local) : ccProjectSlug(local)),
    }),
  };
}

export async function readConversation(req: ChatsearchReadRequest): Promise<ChatsearchReadResponse> {
  if (!req || (req.provider !== 'claude' && req.provider !== 'native') || typeof req.id !== 'string') {
    return { ok: false, error: 'Bad request' };
  }
  const dir = chatsearchDir(os.homedir());
  const resolveLocal = buildLocalProjectResolver();
  // The space root is user-configurable, so resolve it NOW rather than at
  // module load — a root captured at startup would be the wrong one for anyone
  // who set up sync after launching.
  const personalRoot = getManagedRoots()?.personalRoot;
  const roots = [
    CLAUDE_PROJECTS(),
    NATIVE_SESSIONS(),
    ...(personalRoot ? [path.join(personalRoot, 'Conversations')] : []),
  ];
  const entryOf = (p: ChatsearchProvider, id: string) => readMetaFile(dir, p)?.conversations[id];
  return readTranscriptSlice(
    {
      provider: req.provider,
      id: req.id,
      tail: Number(req.tail) || 40,
      ...(req.before !== undefined ? { before: Number(req.before) } : {}),
    },
    {
      entryFor: (p, id) => {
        const e = entryOf(p, id);
        return e ? { transcriptPath: e.transcriptPath, tombstone: !!e.tombstone } : null;
      },
      localPathFor: (p, id) => {
        const e = entryOf(p, id);
        const local = e ? resolveLocal({ projectName: e.projectName, originalPath: e.originalPath }) : null;
        return local ? localTranscriptPath(p, local, id) : null;
      },
      roots,
      cache: parseCache,
    },
  );
}
