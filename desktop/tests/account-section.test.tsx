// @vitest-environment jsdom
// account-section.test.tsx
// Render tests for the Settings → Account section (AccountSection.tsx).
// Follows the same provider/mock conventions as marketplace-auth-context.test.tsx:
// AccountSection reads state via useMarketplaceAuth(), so we wrap it in a real
// MarketplaceAuthProvider and drive state through a mocked window.claude.account.

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup, fireEvent } from "@testing-library/react";
import { MarketplaceAuthProvider } from "../src/renderer/state/marketplace-auth-context";
import AccountSection from "../src/renderer/components/AccountSection";

// Flush the provider's mount refresh() — it awaits signedIn() then user()
// (two sequential microtask hops), so we drain the microtask queue a few times.
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

// Signed-out account mock: signedIn() → false, user() → null.
function signedOutMock() {
  return {
    account: {
      start: vi.fn(),
      poll: vi.fn(),
      signedIn: vi.fn().mockResolvedValue(false),
      user: vi.fn().mockResolvedValue(null),
      signOut: vi.fn().mockResolvedValue(undefined),
      updateProfile: vi.fn().mockResolvedValue({ ok: true }),
      setHandle: vi.fn().mockResolvedValue({ ok: true }),
      deleteAccount: vi.fn().mockResolvedValue({ ok: true }),
    },
  };
}

// Signed-in account mock with a full profile (display_name + handle set).
function signedInMock() {
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
        handle: "octo",
      }),
      signOut: vi.fn().mockResolvedValue(undefined),
      updateProfile: vi.fn().mockResolvedValue({ ok: true }),
      setHandle: vi.fn().mockResolvedValue({ ok: true }),
      deleteAccount: vi.fn().mockResolvedValue({ ok: true }),
    },
  };
}

function renderSection() {
  return render(
    <MarketplaceAuthProvider pollIntervalMs={10}>
      <AccountSection />
    </MarketplaceAuthProvider>,
  );
}

describe("AccountSection", () => {
  beforeEach(() => {
    (globalThis as any).window = (globalThis as any).window ?? {};
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("signed out: shows a Sign in with GitHub row", async () => {
    (globalThis as any).window.claude = signedOutMock();
    const { getByText, getByRole } = renderSection();
    await flush();

    // Open the Account popup from the settings row.
    fireEvent.click(getByRole("button", { name: /Account/i }));

    // Signed-out popup surfaces the GitHub sign-in button.
    expect(getByText("Sign in with GitHub")).toBeTruthy();
  });

  it("signed in: shows avatar, display name, handle, connected-provider row, sign out", async () => {
    (globalThis as any).window.claude = signedInMock();
    const { getByText, getByLabelText, getByRole, container } = renderSection();
    await flush();

    fireEvent.click(getByRole("button", { name: /Account/i }));

    // Avatar image rendered from user.avatar_url
    const avatar = container.querySelector('img[src="http://avatar"]');
    expect(avatar).toBeTruthy();

    // Display name input seeded from display_name
    const nameInput = getByLabelText("Display name") as HTMLInputElement;
    expect(nameInput.value).toBe("Octo Cat");

    // Handle input seeded from handle
    const handleInput = getByLabelText("Handle") as HTMLInputElement;
    expect(handleInput.value).toBe("octo");

    // Connected-provider row shows the GitHub login
    expect(getByText(/Connected: GitHub \(@octocat\)/)).toBeTruthy();

    // Sign out control present
    expect(getByRole("button", { name: "Sign out" })).toBeTruthy();
  });

  it("delete requires typing the confirmation word before the button enables", async () => {
    (globalThis as any).window.claude = signedInMock();
    const { getByRole, getByLabelText } = renderSection();
    await flush();

    fireEvent.click(getByRole("button", { name: /Account/i }));

    // Expand the danger zone.
    fireEvent.click(getByRole("button", { name: "Delete account" }));

    const confirmBtn = getByRole("button", {
      name: "Delete my account",
    }) as HTMLButtonElement;
    // Disabled until the confirmation word matches.
    expect(confirmBtn.disabled).toBe(true);

    const confirmInput = getByLabelText("Type delete to confirm") as HTMLInputElement;
    fireEvent.change(confirmInput, { target: { value: "delete" } });

    expect(confirmBtn.disabled).toBe(false);
  });
});
