// Typed fetch wrapper for the YouCoded marketplace Cloudflare Worker backend.
// Lives in renderer/ because the same React bundle runs on both desktop and Android —
// fetch calls go directly to the Worker (CORS allowlist covers both platforms).
// No IPC needed for read endpoints; write endpoints gate on token which callers supply via getToken().

export const MARKETPLACE_API_HOST = "https://wecoded-marketplace-api.destinj101.workers.dev";

export class MarketplaceApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export interface AuthStartResponse {
  device_code: string;
  user_code: string;
  auth_url: string;
  expires_in: number;
}

// `user` on completion: the Worker returns the profile alongside the token so
// clients can store both atomically (games player tag needs `login`).
// Optional because a Worker deployed before 2026-07 omits it.
export interface AuthMeResponse {
  id: string;
  login: string;              // GitHub login (player-tag continuity)
  display_name: string;       // account-native display name (Worker accounts Phase 1)
  avatar_url: string | null;
  handle: string | null;      // unique @handle, null until the user claims one
}

export type AuthPollResponse =
  | { status: "pending" }
  | { status: "complete"; token: string; user?: AuthMeResponse };

export interface StatsResponse {
  generated_at: number;
  plugins: Record<string, { installs: number; review_count: number; rating: number }>;
  themes: Record<string, { likes: number }>;
}

// Shape of a single rating entry from GET /ratings/:plugin_id
export interface RatingEntry {
  /** Composite key: "<user_id>:<plugin_id>" */
  id: string;
  /** GitHub user id string, e.g. "github:123456" */
  user_id: string;
  user_login: string;
  user_avatar_url: string;
  stars: number;
  review_text: string | null;
  /** Unix timestamp in seconds */
  created_at: number;
}

export interface ListRatingsResponse {
  ratings: RatingEntry[];
}

export interface PostRatingInput {
  plugin_id: string;
  stars: 1 | 2 | 3 | 4 | 5;
  review_text?: string;
}

export interface MarketplaceApiClient {
  getStats(): Promise<StatsResponse>;
  authStart(): Promise<AuthStartResponse>;
  authPoll(deviceCode: string): Promise<AuthPollResponse>;
  /** Resolve the current session token to the signed-in user's profile. */
  authMe(): Promise<AuthMeResponse>;
  /** Update the account display name. Returns the stored value. */
  updateProfile(displayName: string): Promise<{ display_name: string }>;
  /** Claim/change the unique @handle. Returns the normalized handle. Throws MarketplaceApiError (400 invalid / 409 taken). */
  setHandle(handle: string): Promise<{ handle: string }>;
  /** Permanently delete the account (hard delete + cascade on the Worker). */
  deleteAccount(): Promise<void>;
  /** Invalidate the current session token server-side. */
  logout(): Promise<void>;
  postInstall(pluginId: string): Promise<void>;
  postRating(input: PostRatingInput): Promise<{ hidden: boolean }>;
  deleteRating(pluginId: string): Promise<void>;
  toggleThemeLike(themeId: string): Promise<{ liked: boolean }>;
  postReport(input: { rating_user_id: string; rating_plugin_id: string; reason?: string }): Promise<void>;
  /** Fetch all visible ratings for a plugin. Unauthenticated; newest-first, LIMIT 50.
   *  Pass an AbortSignal to cancel in-flight requests on unmount or refresh. */
  listRatings(pluginId: string, signal?: AbortSignal): Promise<ListRatingsResponse>;
}

export function createMarketplaceApiClient(opts: {
  host: string;
  getToken: () => string | null;
}): MarketplaceApiClient {
  const { host, getToken } = opts;

  // signal is threaded through only for endpoints that need cancellation (e.g. listRatings).
  // Other methods can opt-in later without changing callers.
  async function request<T>(path: string, init: RequestInit & { auth?: boolean; signal?: AbortSignal } = {}): Promise<T> {
    const headers: Record<string, string> = { "Content-Type": "application/json", ...(init.headers as Record<string, string>) };
    if (init.auth) {
      const token = getToken();
      if (!token) throw new MarketplaceApiError(401, "not signed in");
      headers.Authorization = `Bearer ${token}`;
    }
    // Remove the custom 'auth' flag before passing to fetch (not a standard RequestInit field)
    const { auth: _auth, ...fetchInit } = init;
    const res = await fetch(`${host}${path}`, { ...fetchInit, headers });
    // 202 Accepted is used for poll-pending responses — treat as success with { status: "pending" }
    const body = res.status === 202 ? { status: "pending" as const } : await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 202) {
      throw new MarketplaceApiError(res.status, (body as { message?: string })?.message ?? res.statusText);
    }
    return body as T;
  }

  return {
    getStats: () => request<StatsResponse>("/stats", { method: "GET" }),
    authStart: () => request<AuthStartResponse>("/auth/github/start", { method: "POST" }),
    authPoll: (device_code) =>
      request<AuthPollResponse>("/auth/github/poll", {
        method: "POST",
        body: JSON.stringify({ device_code }),
      }),
    authMe: () => request<AuthMeResponse>("/auth/me", { method: "GET", auth: true }),
    updateProfile: (display_name) =>
      request<{ display_name: string }>("/auth/profile", {
        method: "PATCH",
        body: JSON.stringify({ display_name }),
        auth: true,
      }),
    setHandle: (handle) =>
      request<{ handle: string }>("/auth/handle", {
        method: "PUT",
        body: JSON.stringify({ handle }),
        auth: true,
      }),
    // Void endpoints: 204 No Content. request() tolerates empty bodies (res.json().catch → {}),
    // so the same pattern as postInstall/deleteRating works — discard the return.
    deleteAccount: async () => {
      await request("/auth/account", { method: "DELETE", auth: true });
    },
    logout: async () => {
      await request("/auth/logout", { method: "POST", auth: true });
    },
    postInstall: async (plugin_id) => {
      await request("/installs", { method: "POST", body: JSON.stringify({ plugin_id }), auth: true });
    },
    postRating: (input) =>
      request<{ hidden: boolean }>("/ratings", {
        method: "POST",
        body: JSON.stringify(input),
        auth: true,
      }),
    deleteRating: async (plugin_id) => {
      await request(`/ratings/${encodeURIComponent(plugin_id)}`, { method: "DELETE", auth: true });
    },
    toggleThemeLike: (theme_id) =>
      request<{ liked: boolean }>(`/themes/${encodeURIComponent(theme_id)}/like`, {
        method: "POST",
        auth: true,
      }),
    postReport: async (input) => {
      await request("/reports", { method: "POST", body: JSON.stringify(input), auth: true });
    },
    // Unauthenticated — public read endpoint, no Authorization header needed.
    // signal allows callers to cancel mid-flight on unmount or refreshKey change.
    listRatings: (plugin_id, signal?) =>
      request<ListRatingsResponse>(`/ratings/${encodeURIComponent(plugin_id)}`, { method: "GET", signal }),
  };
}
