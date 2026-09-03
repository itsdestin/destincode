import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMarketplaceApiClient, MARKETPLACE_API_HOST } from "../src/renderer/state/marketplace-api-client";

describe("MarketplaceApiClient", () => {
  const HOST = "https://api.test";
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  it("fetches /stats without auth", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ plugins: {}, themes: {} })));
    const client = createMarketplaceApiClient({ host: HOST, getToken: () => null });
    const stats = await client.getStats();
    expect(fetchMock).toHaveBeenCalledWith(`${HOST}/stats`, expect.objectContaining({ method: "GET" }));
    expect(stats).toEqual({ plugins: {}, themes: {} });
  });

  it("attaches Bearer token to authenticated endpoints", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));
    const client = createMarketplaceApiClient({ host: HOST, getToken: () => "TOKEN" });
    await client.postInstall("foo:bar");
    expect(fetchMock).toHaveBeenCalledWith(
      `${HOST}/installs`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer TOKEN" }),
      })
    );
  });

  it("throws typed error on 401", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ message: "invalid token" }), { status: 401 }));
    const client = createMarketplaceApiClient({ host: HOST, getToken: () => "BAD" });
    await expect(client.postInstall("foo")).rejects.toMatchObject({ status: 401 });
  });

  it("throws typed error on 403 install-gate", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ message: "must install plugin before rating" }), { status: 403 }));
    const client = createMarketplaceApiClient({ host: HOST, getToken: () => "T" });
    await expect(client.postRating({ plugin_id: "x", stars: 5 })).rejects.toMatchObject({ status: 403 });
  });

  it("starts device-code flow unauthenticated", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      device_code: "d", user_code: "U", auth_url: "http://example", expires_in: 900,
    })));
    const client = createMarketplaceApiClient({ host: HOST, getToken: () => null });
    const out = await client.authStart();
    expect(out.device_code).toBe("d");
  });

  it("polls without auth", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status: "pending" }), { status: 202 }));
    const client = createMarketplaceApiClient({ host: HOST, getToken: () => null });
    const out = await client.authPoll("d");
    expect(out.status).toBe("pending");
  });

  it("listRatings fetches GET /ratings/:plugin_id without auth", async () => {
    const mockRating = {
      id: "github:42:my-plugin",
      user_id: "github:42",
      user_login: "alice",
      user_avatar_url: "https://avatars.githubusercontent.com/u/42",
      stars: 5,
      review_text: "Great plugin!",
      created_at: 1712880000,
    };
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ratings: [mockRating] })));
    const client = createMarketplaceApiClient({ host: HOST, getToken: () => null });
    const out = await client.listRatings("my-plugin");

    // Verify URL uses the encoded plugin id
    expect(fetchMock).toHaveBeenCalledWith(
      `${HOST}/ratings/my-plugin`,
      expect.objectContaining({ method: "GET" })
    );
    // Verify no Authorization header is set (unauthenticated endpoint)
    const callArgs = fetchMock.mock.calls[0][1] as RequestInit;
    expect((callArgs.headers as Record<string, string>)?.Authorization).toBeUndefined();
    // Verify response shape
    expect(out.ratings).toHaveLength(1);
    expect(out.ratings[0]).toMatchObject({ user_login: "alice", stars: 5, review_text: "Great plugin!" });
  });

  it("listRatings forwards the AbortSignal to fetch", async () => {
    // Verify that when a signal is passed, it reaches fetch — this is the load-bearing
    // fix for the fake-abort bug where controller.abort() was called but signal was never wired.
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ratings: [] })));
    const client = createMarketplaceApiClient({ host: HOST, getToken: () => null });
    const controller = new AbortController();
    await client.listRatings("my-plugin", controller.signal);

    const callArgs = fetchMock.mock.calls[0][1] as RequestInit;
    expect(callArgs.signal).toBe(controller.signal);
  });

  // Accounts Phase 1: profile/handle/account/logout endpoints on the Worker.
  // Each verifies the HTTP method, path, JSON body (where applicable), and Bearer auth.
  // Nested so it shares the outer describe's fetchMock/beforeEach setup.
  describe("account endpoints", () => {
    it("updateProfile PATCHes /auth/profile with auth", async () => {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ display_name: "New Name" })));
      const client = createMarketplaceApiClient({ host: HOST, getToken: () => "TOKEN" });
      const out = await client.updateProfile("New Name");

      expect(out).toEqual({ display_name: "New Name" });
      expect(fetchMock).toHaveBeenCalledWith(
        `${HOST}/auth/profile`,
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ display_name: "New Name" }),
          headers: expect.objectContaining({ Authorization: "Bearer TOKEN" }),
        })
      );
    });

    it("setHandle PUTs /auth/handle with auth", async () => {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ handle: "destin" })));
      const client = createMarketplaceApiClient({ host: HOST, getToken: () => "TOKEN" });
      const out = await client.setHandle("Destin");

      expect(out).toEqual({ handle: "destin" });
      expect(fetchMock).toHaveBeenCalledWith(
        `${HOST}/auth/handle`,
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ handle: "Destin" }),
          headers: expect.objectContaining({ Authorization: "Bearer TOKEN" }),
        })
      );
    });

    it("deleteAccount DELETEs /auth/account with auth", async () => {
      // 204 No Content — empty body; the void method must not throw on an empty response.
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
      const client = createMarketplaceApiClient({ host: HOST, getToken: () => "TOKEN" });
      await expect(client.deleteAccount()).resolves.toBeUndefined();

      expect(fetchMock).toHaveBeenCalledWith(
        `${HOST}/auth/account`,
        expect.objectContaining({
          method: "DELETE",
          headers: expect.objectContaining({ Authorization: "Bearer TOKEN" }),
        })
      );
    });

    it("logout POSTs /auth/logout with auth", async () => {
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
      const client = createMarketplaceApiClient({ host: HOST, getToken: () => "TOKEN" });
      await expect(client.logout()).resolves.toBeUndefined();

      expect(fetchMock).toHaveBeenCalledWith(
        `${HOST}/auth/logout`,
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ Authorization: "Bearer TOKEN" }),
        })
      );
    });

    it("surfaces the JSON `{ error }` shape (Worker app.onError 500)", async () => {
      // Worker JSON 500s use { ok: false, error } (app.onError), not { message }.
      // Regression guard so those don't reach the UI with a blank message.
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: false, error: "AE SQL failed" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        })
      );
      const client = createMarketplaceApiClient({ host: HOST, getToken: () => "TOKEN" });
      await expect(client.updateProfile("x")).rejects.toMatchObject({
        status: 500,
        message: "AE SQL failed",
      });
    });

    it("surfaces text/plain error bodies (Hono HTTPException shape)", async () => {
      // The Worker's 400/409s are plain-text bodies, not JSON {message}.
      // Regression guard for the blank-error-message bug: res.statusText is empty
      // over HTTP/2 on Cloudflare, so the client must read the raw text body.
      fetchMock.mockResolvedValueOnce(
        new Response("that handle is taken", { status: 409, headers: { "content-type": "text/plain" } })
      );
      const client = createMarketplaceApiClient({ host: HOST, getToken: () => "TOKEN" });
      await expect(client.setHandle("taken")).rejects.toMatchObject({
        status: 409,
        message: "that handle is taken",
      });
    });
  });
});

// The Worker moved from its workers.dev address to a custom domain on 2026-09-03 so
// Cloudflare's cache and rate limiter apply. Every desktop caller (renderer client,
// analytics, presence + sync-hub sockets) hard-codes the host, and ipc-channels.test.ts
// only checks that Kotlin matches THIS constant — so this is the one place the actual
// value is pinned. A drift back to the old host would silently still work (it keeps
// answering) while bypassing the cache, which is why it gets a test and not a comment.
describe("marketplace Worker host", () => {
  it("MARKETPLACE_API_HOST points at the custom domain, not the workers.dev address", () => {
    expect(MARKETPLACE_API_HOST).toBe("https://api.youcoded.ai");
  });
});
