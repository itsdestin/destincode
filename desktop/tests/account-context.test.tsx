// @vitest-environment jsdom
// account-context.test.tsx
// Tests for the AccountProvider React context.
// Runs in jsdom so React DOM + document are available.
// Uses vi.useFakeTimers() so the poll setTimeout doesn't slow tests down.
// Uses a small pollIntervalMs (10ms) + real Promise.resolve() flushing via
// vi.runAllTimersAsync() to advance through the polling loop without sleeping.

import React, { useState } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup } from "@testing-library/react";
import {
  AccountProvider,
  useAccount,
} from "../src/renderer/state/account-context";

// Simple probe component that renders current auth state
function Probe() {
  const { signedIn, startSignIn, user } = useAccount();
  return (
    <div>
      <span data-testid="state">{signedIn ? "in" : "out"}</span>
      <span data-testid="user">{user?.login ?? ""}</span>
      <button data-testid="go" onClick={() => void startSignIn()}>
        go
      </button>
    </div>
  );
}

// Helper — build a fresh mock and assign to globalThis.window.claude
function makeMock() {
  return {
    account: {
      // start() returns ApiResult<AuthStartResponse>
      start: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          device_code: "d",
          user_code: "U",
          auth_url: "http://a",
          expires_in: 900,
        },
      }),
      // poll() returns ApiResult<AuthPollResponse>
      // First call → pending; second call → complete
      poll: vi
        .fn()
        .mockResolvedValueOnce({ ok: true, value: { status: "pending" } })
        .mockResolvedValueOnce({
          ok: true,
          value: { status: "complete", token: "TOK" },
        }),
      // Plain returns (NOT wrapped in ApiResult):
      signedIn: vi
        .fn()
        .mockResolvedValueOnce(false) // initial refresh on mount
        .mockResolvedValue(true),     // after sign-in completes
      user: vi
        .fn()
        .mockResolvedValueOnce(null)  // initial refresh on mount
        .mockResolvedValue({ id: "github:1", login: "u", avatar_url: "http://a" }),
      signOut: vi.fn().mockResolvedValue(undefined),
      // Account-mutation methods (accounts Phase 1). ApiResult-shaped returns.
      updateProfile: vi.fn().mockResolvedValue({ ok: true }),
      setHandle: vi.fn().mockResolvedValue({ ok: true }),
      deleteAccount: vi.fn().mockResolvedValue({ ok: true }),
    },
  };
}

// Probe that exposes the three account-mutation actions plus current state, so
// tests can drive updateProfile / setHandle / deleteAccount and observe the
// resulting state + surfaced error message.
function ActionsProbe() {
  const { signedIn, user, updateProfile, setHandle, deleteAccount } =
    useAccount();
  const [err, setErr] = useState("");
  return (
    <div>
      <span data-testid="state">{signedIn ? "in" : "out"}</span>
      <span data-testid="user">{user?.login ?? ""}</span>
      <span data-testid="handle">{user?.handle ?? ""}</span>
      <span data-testid="err">{err}</span>
      <button data-testid="upd" onClick={() => void updateProfile("X").catch((e) => setErr(e.message))}>
        upd
      </button>
      <button data-testid="seth" onClick={() => void setHandle("newhandle").catch((e) => setErr(e.message))}>
        seth
      </button>
      <button data-testid="del" onClick={() => void deleteAccount().catch((e) => setErr(e.message))}>
        del
      </button>
    </div>
  );
}

describe("AccountProvider", () => {
  beforeEach(() => {
    // Fake timers so setTimeout in the poll loop resolves instantly
    vi.useFakeTimers();
    // Assign a fresh mock before each test
    (globalThis as any).window = (globalThis as any).window ?? {};
    (globalThis as any).window.claude = makeMock();
  });

  afterEach(() => {
    // Clean up the rendered tree between tests (prevents element duplication)
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("starts as signed-out", async () => {
    const { getByTestId } = render(
      <AccountProvider pollIntervalMs={10}>
        <Probe />
      </AccountProvider>
    );

    // Let the initial refresh() promises resolve (signedIn + user calls)
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    // After initial refresh, signedIn() returned false → state should be "out"
    expect(getByTestId("state").textContent).toBe("out");
  });

  it("transitions to signed-in after sign-in flow completes", async () => {
    const { getByTestId } = render(
      <AccountProvider pollIntervalMs={10}>
        <Probe />
      </AccountProvider>
    );

    // Wait for initial mount refresh to complete
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    // Confirm starts out
    expect(getByTestId("state").textContent).toBe("out");

    // Click the sign-in button — starts the device-code flow
    // start() resolves → poll loop begins
    await act(async () => {
      getByTestId("go").click();
      await vi.runAllTimersAsync();
    });

    // Advance through the poll loop:
    // Iteration 1: poll() → "pending" → setTimeout(r, 10ms) → tick
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    // Iteration 2: poll() → "complete" → refresh() → state updates
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    // After "complete", refresh() called signedIn() → true and user() → user obj
    expect(getByTestId("state").textContent).toBe("in");
    expect(getByTestId("user").textContent).toBe("u");
  });

  // ── Account-mutation actions (accounts Phase 1) ─────────────────────────────

  it("updateProfile throws with the server message when !res.ok", async () => {
    (globalThis as any).window.claude = {
      account: {
        signedIn: vi.fn().mockResolvedValue(true),
        user: vi.fn().mockResolvedValue({ id: "github:1", login: "u", avatar_url: "http://a" }),
        updateProfile: vi.fn().mockResolvedValue({ ok: false, message: "name too long" }),
        setHandle: vi.fn(),
        deleteAccount: vi.fn(),
      },
    };
    const { getByTestId } = render(
      <AccountProvider pollIntervalMs={10}>
        <ActionsProbe />
      </AccountProvider>
    );
    await act(async () => { await vi.runAllTimersAsync(); });

    await act(async () => {
      getByTestId("upd").click();
      await vi.runAllTimersAsync();
    });

    // The context rethrows new Error(res.message); the probe surfaces it.
    expect(getByTestId("err").textContent).toBe("name too long");
  });

  it("setHandle success refreshes user so the new handle renders", async () => {
    (globalThis as any).window.claude = {
      account: {
        signedIn: vi.fn().mockResolvedValue(true),
        // Mount → handle null; after setHandle refresh → handle "newhandle".
        user: vi
          .fn()
          .mockResolvedValueOnce({ id: "github:1", login: "u", avatar_url: "http://a", handle: null })
          .mockResolvedValue({ id: "github:1", login: "u", avatar_url: "http://a", handle: "newhandle" }),
        updateProfile: vi.fn(),
        setHandle: vi.fn().mockResolvedValue({ ok: true }),
        deleteAccount: vi.fn(),
      },
    };
    const { getByTestId } = render(
      <AccountProvider pollIntervalMs={10}>
        <ActionsProbe />
      </AccountProvider>
    );
    await act(async () => { await vi.runAllTimersAsync(); });
    expect(getByTestId("handle").textContent).toBe("");

    await act(async () => {
      getByTestId("seth").click();
      await vi.runAllTimersAsync();
    });

    // refresh() re-read user() → new handle now rendered.
    expect(getByTestId("handle").textContent).toBe("newhandle");
  });

  it("deleteAccount success clears signedIn + user", async () => {
    (globalThis as any).window.claude = {
      account: {
        signedIn: vi.fn().mockResolvedValue(true),
        user: vi.fn().mockResolvedValue({ id: "github:1", login: "u", avatar_url: "http://a" }),
        updateProfile: vi.fn(),
        setHandle: vi.fn(),
        deleteAccount: vi.fn().mockResolvedValue({ ok: true }),
      },
    };
    const { getByTestId } = render(
      <AccountProvider pollIntervalMs={10}>
        <ActionsProbe />
      </AccountProvider>
    );
    await act(async () => { await vi.runAllTimersAsync(); });
    expect(getByTestId("state").textContent).toBe("in");

    await act(async () => {
      getByTestId("del").click();
      await vi.runAllTimersAsync();
    });

    expect(getByTestId("state").textContent).toBe("out");
    expect(getByTestId("user").textContent).toBe("");
  });

  it("setHandle 401 clears the session — context flips signed-out AND surfaces the error", async () => {
    // Regression: a pre-migration (or 90-day-idle-expired) token leaves the client
    // locally "signed in" but every auth'd call 401s. The main process now clears
    // the session on a 401, so signedIn()/user() read false/null on the refresh the
    // context runs BEFORE re-throwing. Assert the UI both flips signed-out and still
    // shows the error message.
    (globalThis as any).window.claude = {
      account: {
        // Mount → signed in; post-401 refresh → signed out (main cleared it).
        signedIn: vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false),
        user: vi
          .fn()
          .mockResolvedValueOnce({ id: "github:1", login: "u", avatar_url: "http://a" })
          .mockResolvedValue(null),
        updateProfile: vi.fn(),
        setHandle: vi.fn().mockResolvedValue({ ok: false, status: 401, message: "invalid token" }),
        deleteAccount: vi.fn(),
      },
    };
    const { getByTestId } = render(
      <AccountProvider pollIntervalMs={10}>
        <ActionsProbe />
      </AccountProvider>
    );
    await act(async () => { await vi.runAllTimersAsync(); });
    expect(getByTestId("state").textContent).toBe("in");

    await act(async () => {
      getByTestId("seth").click();
      await vi.runAllTimersAsync();
    });

    // The error still surfaces to the caller (the popup shows it)...
    expect(getByTestId("err").textContent).toBe("invalid token");
    // ...and the app has flipped to signed-out so sign-in prompts return.
    expect(getByTestId("state").textContent).toBe("out");
    expect(getByTestId("user").textContent).toBe("");
  });

  it("deleteAccount failure throws and leaves state unchanged", async () => {
    (globalThis as any).window.claude = {
      account: {
        signedIn: vi.fn().mockResolvedValue(true),
        user: vi.fn().mockResolvedValue({ id: "github:1", login: "u", avatar_url: "http://a" }),
        updateProfile: vi.fn(),
        setHandle: vi.fn(),
        deleteAccount: vi.fn().mockResolvedValue({ ok: false, message: "server error" }),
      },
    };
    const { getByTestId } = render(
      <AccountProvider pollIntervalMs={10}>
        <ActionsProbe />
      </AccountProvider>
    );
    await act(async () => { await vi.runAllTimersAsync(); });

    await act(async () => {
      getByTestId("del").click();
      await vi.runAllTimersAsync();
    });

    // Error surfaced; signed-in state untouched (no optimistic clear on failure).
    expect(getByTestId("err").textContent).toBe("server error");
    expect(getByTestId("state").textContent).toBe("in");
    expect(getByTestId("user").textContent).toBe("u");
  });
});
