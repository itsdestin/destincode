// @vitest-environment jsdom
// handle-prompt.test.tsx
// Render tests for the post-sign-in handle prompt (HandlePrompt.tsx).
// Follows the same provider/mock conventions as account-section.test.tsx:
// HandlePrompt reads state via useAccount(), so we wrap it in a real
// AccountProvider and drive state through a mocked window.claude.account.

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup, fireEvent } from "@testing-library/react";
import { AccountProvider } from "../src/renderer/state/account-context";
import HandlePrompt from "../src/renderer/components/HandlePrompt";

const LEGACY_DISMISS_KEY = "youcoded-handle-prompt-dismissed";
// Per-account key for the "github:1" fixture account used throughout.
const DISMISS_KEY = `youcoded-handle-prompt-dismissed:github:1`;

// Install a deterministic, dependency-free Map-backed localStorage stub the
// component reads — so these tests don't couple to jsdom's Storage internals.
function installLocalStorageStub() {
  const store = new Map<string, string>();
  const stub = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size; },
  };
  Object.defineProperty(globalThis, "localStorage", { value: stub, configurable: true, writable: true });
  if ((globalThis as any).window) (globalThis as any).window.localStorage = stub;
}

// Flush the provider's mount refresh() — it awaits signedIn() then user()
// (two sequential microtask hops), so we drain the microtask queue a few times.
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

// Signed-in account mock. `handle` is parameterized so we can test the
// has-handle vs no-handle branches.
function signedInMock(handle: string | null) {
  return {
    account: {
      start: vi.fn(),
      poll: vi.fn(),
      signedIn: vi.fn().mockResolvedValue(true),
      user: vi.fn().mockResolvedValue({
        id: "github:1",
        login: "octocat",
        avatar_url: "http://avatar",
        display_name: "Octo Cat",
        handle,
      }),
      signOut: vi.fn().mockResolvedValue(undefined),
      updateProfile: vi.fn().mockResolvedValue({ ok: true }),
      setHandle: vi.fn().mockResolvedValue({ ok: true }),
      deleteAccount: vi.fn().mockResolvedValue({ ok: true }),
    },
  };
}

function renderPrompt() {
  return render(
    <AccountProvider pollIntervalMs={10}>
      <HandlePrompt />
    </AccountProvider>,
  );
}

describe("HandlePrompt", () => {
  beforeEach(() => {
    (globalThis as any).window = (globalThis as any).window ?? {};
    installLocalStorageStub();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("shows when signed in with no handle and not previously dismissed", async () => {
    (globalThis as any).window.claude = signedInMock(null);
    const { queryByText } = renderPrompt();
    await flush();

    expect(queryByText("Pick a handle")).toBeTruthy();
  });

  it("does not show when the user has a handle", async () => {
    (globalThis as any).window.claude = signedInMock("octo");
    const { queryByText } = renderPrompt();
    await flush();

    expect(queryByText("Pick a handle")).toBeNull();
  });

  it("does not show when previously dismissed", async () => {
    localStorage.setItem(DISMISS_KEY, "1");
    (globalThis as any).window.claude = signedInMock(null);
    const { queryByText } = renderPrompt();
    await flush();

    expect(queryByText("Pick a handle")).toBeNull();
  });

  it("does not show when a legacy global dismissal exists (read-only fallback)", async () => {
    // Pre-existing machine-global dismissal from before the per-account change.
    localStorage.setItem(LEGACY_DISMISS_KEY, "1");
    (globalThis as any).window.claude = signedInMock(null);
    const { queryByText } = renderPrompt();
    await flush();

    expect(queryByText("Pick a handle")).toBeNull();
  });

  it("another account's dismissal does NOT suppress this account (knowledge-debt #4)", async () => {
    // User B skipped on this machine; user "github:1" must still be prompted.
    localStorage.setItem("youcoded-handle-prompt-dismissed:github:2", "1");
    (globalThis as any).window.claude = signedInMock(null);
    const { queryByText } = renderPrompt();
    await flush();

    expect(queryByText("Pick a handle")).toBeTruthy();
  });

  it("skip sets the per-account dismissal flag (not the legacy key) and closes", async () => {
    (globalThis as any).window.claude = signedInMock(null);
    const { queryByText, getByRole } = renderPrompt();
    await flush();

    expect(queryByText("Pick a handle")).toBeTruthy();

    fireEvent.click(getByRole("button", { name: "Skip for now" }));
    await flush();

    // Dismissal flag persisted per-account so we never nag THIS account again.
    expect(localStorage.getItem(DISMISS_KEY)).toBe("1");
    // The legacy global key is never (re)written — it only ages out.
    expect(localStorage.getItem(LEGACY_DISMISS_KEY)).toBeNull();
    // Prompt closed.
    expect(queryByText("Pick a handle")).toBeNull();
  });

  it("saving a handle closes without setting the dismissal flag", async () => {
    (globalThis as any).window.claude = signedInMock(null);
    const { queryByText, getByRole, getByLabelText } = renderPrompt();
    await flush();

    expect(queryByText("Pick a handle")).toBeTruthy();

    const input = getByLabelText("Handle") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "octo" } });
    fireEvent.click(getByRole("button", { name: "Save" }));
    await flush();

    // setHandle was called with the entered value.
    expect((globalThis as any).window.claude.account.setHandle).toHaveBeenCalledWith("octo");
    // Prompt closed on success.
    expect(queryByText("Pick a handle")).toBeNull();
    // Saving a handle is a real answer — no "never nag" flag set.
    expect(localStorage.getItem(DISMISS_KEY)).toBeNull();
  });
});
