// Shared store/provider setup for hook tests that need a REAL ChatProvider
// store, pre-seeded with sessions, and dispatchable from OUTSIDE the render
// tree. Existing hook tests (useActiveSessionModel.test.tsx,
// useSessionAttention.test.tsx) only ever reach `dispatch` through a rendered
// hook, so they inline a `<ChatProvider>{children}</ChatProvider>` wrapper.
// Task 6's hook test needs the store object BEFORE renderHook is called (to
// pre-seed sessions via makeStoreWrapper(['s1'])), so this factors out a
// wrapper that also hands back a dispatchable handle.
//
// `store` is a thin delegating handle, not a second store implementation: it
// forwards every call to whichever REAL ChatStore (chat-context.ts's own
// createChatStore, via useChatStore()) the wrapper mounts. Its methods are
// only ever invoked from inside `act()`, after renderHook has already
// rendered — by then the handle is bound — so returning it before mount is
// safe even though the real store doesn't exist yet at that point.
import React, { useRef } from 'react';
import { ChatProvider, useChatStore, type ChatStore } from '../../src/renderer/state/chat-context';
import type { ChatAction, ChatState, SessionChatState } from '../../src/renderer/state/chat-types';

function createStoreHandle(): ChatStore {
  let real: ChatStore | null = null;
  const requireReal = (): ChatStore => {
    if (!real) throw new Error('chat-store-harness: store used before the wrapper mounted');
    return real;
  };
  return {
    getState: (): ChatState => requireReal().getState(),
    getSession: (id: string): SessionChatState => requireReal().getSession(id),
    subscribeSession: (id: string, cb: () => void) => requireReal().subscribeSession(id, cb),
    subscribeAll: (cb: () => void) => requireReal().subscribeAll(cb),
    dispatch: (action: ChatAction) => requireReal().dispatch(action),
    // Internal bind point — not part of the ChatStore interface real callers
    // see, only used by Capture below.
    __bind: (r: ChatStore) => { real = r; },
  } as ChatStore & { __bind: (r: ChatStore) => void };
}

function Capture({ handle, sessionIds, children }: {
  handle: ChatStore & { __bind: (r: ChatStore) => void };
  sessionIds: string[];
  children: React.ReactNode;
}) {
  const store = useChatStore();
  const bound = useRef(false);
  if (!bound.current) {
    bound.current = true;
    handle.__bind(store);
    for (const id of sessionIds) store.dispatch({ type: 'SESSION_INIT', sessionId: id });
  }
  return React.createElement(React.Fragment, null, children);
}

export function makeStoreWrapper(sessionIds: string[] = []): {
  wrapper: (props: { children: React.ReactNode }) => React.ReactElement;
  store: ChatStore;
} {
  const handle = createStoreHandle() as ChatStore & { __bind: (r: ChatStore) => void };
  function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(
      ChatProvider,
      null,
      React.createElement(Capture, { handle, sessionIds }, children),
    );
  }
  return { wrapper: Wrapper, store: handle };
}

export function dispatchTo(store: ChatStore, action: ChatAction) {
  store.dispatch(action);
}
