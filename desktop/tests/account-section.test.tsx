// @vitest-environment jsdom
// account-section.test.tsx
// Render tests for the Settings → Account section (AccountSection.tsx).
// Follows the same provider/mock conventions as marketplace-auth-context.test.tsx:
// AccountSection reads state via useMarketplaceAuth(), so we wrap it in a real
// MarketplaceAuthProvider and drive state through a mocked window.claude.account.
//
// The signed-in popup is a view/edit split (2026-07-08 UX rework): read-only
// summary by default, "Edit account" toggles the editors + danger zone in.

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

// Signed-in account mock. handle is parameterized so tests can cover both the
// "has a handle already" (change → confirm) and "first handle" (no confirm) paths.
function signedInMock(handle: string | null = "octo") {
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

function renderSection() {
  return render(
    <MarketplaceAuthProvider pollIntervalMs={10}>
      <AccountSection />
    </MarketplaceAuthProvider>,
  );
}

// Open the settings row popup, then (optionally) enter edit mode.
async function openPopup(utils: ReturnType<typeof renderSection>, edit = false) {
  fireEvent.click(utils.getByRole("button", { name: /Account/i }));
  if (edit) {
    fireEvent.click(utils.getByRole("button", { name: "Edit account" }));
  }
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
    const utils = renderSection();
    await flush();

    // Open the Account popup from the settings row.
    fireEvent.click(utils.getByRole("button", { name: /Account/i }));

    // Signed-out popup surfaces the GitHub sign-in button.
    expect(utils.getByText("Sign in with GitHub")).toBeTruthy();
  });

  it("signed in: view mode is read-only — avatar, name, handle, provider row, sign out, Edit account", async () => {
    (globalThis as any).window.claude = signedInMock();
    const utils = renderSection();
    await flush();
    await openPopup(utils);

    // Avatar image rendered from user.avatar_url
    expect(utils.container.querySelector('img[src="http://avatar"]')).toBeTruthy();

    // Read-only identity: display name + @handle as text, not inputs
    expect(utils.getByText("Octo Cat")).toBeTruthy();
    expect(utils.getByText("@octo")).toBeTruthy();

    // Connected-provider row shows the GitHub login
    expect(utils.getByText(/Connected: GitHub \(@octocat\)/)).toBeTruthy();

    // Sign out + the single edit affordance are present
    expect(utils.getByRole("button", { name: "Sign out" })).toBeTruthy();
    expect(utils.getByRole("button", { name: "Edit account" })).toBeTruthy();

    // View mode has NO inputs and NO danger zone
    expect(utils.queryByLabelText("Display name")).toBeNull();
    expect(utils.queryByLabelText("Handle")).toBeNull();
    expect(utils.queryByRole("button", { name: "Delete account" })).toBeNull();
  });

  it("Edit account reveals the editors + danger zone; Done returns to view mode", async () => {
    (globalThis as any).window.claude = signedInMock();
    const utils = renderSection();
    await flush();
    await openPopup(utils, true);

    // Editors seeded from the profile
    expect((utils.getByLabelText("Display name") as HTMLInputElement).value).toBe("Octo Cat");
    expect((utils.getByLabelText("Handle") as HTMLInputElement).value).toBe("octo");

    // Danger zone lives in edit mode
    expect(utils.getByRole("button", { name: "Delete account" })).toBeTruthy();

    // Done returns to the read-only view
    fireEvent.click(utils.getByRole("button", { name: "Done" }));
    expect(utils.queryByLabelText("Display name")).toBeNull();
    expect(utils.getByRole("button", { name: "Edit account" })).toBeTruthy();
  });

  it("changing an existing handle requires the inline confirm step before setHandle is called", async () => {
    const mock = signedInMock("octo");
    (globalThis as any).window.claude = mock;
    const utils = renderSection();
    await flush();
    await openPopup(utils, true);

    fireEvent.change(utils.getByLabelText("Handle"), { target: { value: "newname" } });
    fireEvent.click(utils.getByRole("button", { name: "Save handle" }));

    // Save did NOT commit — it opened the consequences warning instead.
    expect(mock.account.setHandle).not.toHaveBeenCalled();
    expect(utils.getByText(/frees @octo for anyone else to claim after 30 days/)).toBeTruthy();

    // Explicit confirm commits the change.
    fireEvent.click(utils.getByRole("button", { name: "Confirm change" }));
    await flush();
    expect(mock.account.setHandle).toHaveBeenCalledWith("newname");
  });

  it("cancelling the handle confirm step does not call setHandle", async () => {
    const mock = signedInMock("octo");
    (globalThis as any).window.claude = mock;
    const utils = renderSection();
    await flush();
    await openPopup(utils, true);

    fireEvent.change(utils.getByLabelText("Handle"), { target: { value: "newname" } });
    fireEvent.click(utils.getByRole("button", { name: "Save handle" }));
    fireEvent.click(utils.getByRole("button", { name: "Cancel handle change" }));
    await flush();

    expect(mock.account.setHandle).not.toHaveBeenCalled();
    // Warning gone; Save affordance back.
    expect(utils.queryByText(/frees @octo/)).toBeNull();
    expect(utils.getByRole("button", { name: "Save handle" })).toBeTruthy();
  });

  it("first-time handle set commits directly with no confirm step", async () => {
    const mock = signedInMock(null); // no existing handle → nothing to lose
    (globalThis as any).window.claude = mock;
    const utils = renderSection();
    await flush();
    await openPopup(utils, true);

    fireEvent.change(utils.getByLabelText("Handle"), { target: { value: "fresh" } });
    fireEvent.click(utils.getByRole("button", { name: "Save handle" }));
    await flush();

    expect(mock.account.setHandle).toHaveBeenCalledWith("fresh");
  });

  it("delete requires typing the confirmation word before the button enables", async () => {
    (globalThis as any).window.claude = signedInMock();
    const utils = renderSection();
    await flush();
    await openPopup(utils, true);

    // Expand the danger zone (step 1 of 2).
    fireEvent.click(utils.getByRole("button", { name: "Delete account" }));

    const confirmBtn = utils.getByRole("button", {
      name: "Delete my account",
    }) as HTMLButtonElement;
    // Disabled until the confirmation word matches (step 2 of 2).
    expect(confirmBtn.disabled).toBe(true);

    const confirmInput = utils.getByLabelText("Type delete to confirm") as HTMLInputElement;
    fireEvent.change(confirmInput, { target: { value: "delete" } });

    expect(confirmBtn.disabled).toBe(false);
  });
});
