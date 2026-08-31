package com.youcoded.app.marketplace

import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

/**
 * Kotlin mirror of the TS MarketplaceApiClient in desktop/src/renderer/state/marketplace-api-client.ts.
 * Calls the YouCoded Cloudflare Worker backend.
 *
 * WHY OkHttp: already a project dependency (for the WebSocket bridge server), so no new deps needed.
 * WHY suspend: all callers live in SessionService's serviceScope (Dispatchers.IO), consistent with
 * how other blocking I/O in that service is dispatched.
 */

private const val TAG = "MarketplaceApiClient"
private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()

/** Mirrors the TS ApiResult<T> discriminated union — returned as JSON to the React renderer. */
sealed class ApiResult<out T> {
    data class Ok<T>(val value: T) : ApiResult<T>()
    data class Err(val status: Int, val message: String) : ApiResult<Nothing>()

    /** Serialize to a JSONObject matching the TS shape: { ok, value } or { ok, status, message } */
    fun toJson(serializeValue: (T) -> Any? = { v -> v }): JSONObject = when (this) {
        is Ok -> JSONObject().apply {
            put("ok", true)
            val v = serializeValue(value)
            when (v) {
                null               -> put("value", JSONObject.NULL)
                // Fix: JSONObject.NULL is a sentinel OBJECT, not Kotlin null — without
                // this branch the void-endpoint callers (`{ _ -> JSONObject.NULL }`)
                // fell through to else and shipped the literal string "null".
                JSONObject.NULL    -> put("value", JSONObject.NULL)
                is JSONObject      -> put("value", v)
                // Social list endpoints (friends/blocks) return a bare JSON array —
                // without this branch it would fall to toString() and ship a stringified
                // array, breaking the { ok, value } wire shape the renderer reads.
                is JSONArray       -> put("value", v)
                is Boolean         -> put("value", v)
                is Int             -> put("value", v)
                is String          -> put("value", v)
                else               -> put("value", v.toString())
            }
        }
        is Err -> JSONObject().apply {
            put("ok", false)
            put("status", status)
            put("message", message)
        }
    }
}

class MarketplaceApiClient(
    private val store: MarketplaceAuthStore,
    private val host: String = "https://wecoded-marketplace-api.destinj101.workers.dev",
) {
    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    // ── Internal helpers ─────────────────────────────────────────────────────

    private suspend fun request(
        path: String,
        method: String = "GET",
        body: JSONObject? = null,
        auth: Boolean = false,
        // WHY: lets a single call (sign-out) impose a bounded call timeout without
        // touching the shared client's defaults. Defaults to the shared `http`.
        client: OkHttpClient = http,
    ): Pair<Int, JSONObject> = withContext(Dispatchers.IO) {
        val reqBody = body?.toString()?.toRequestBody(JSON_MEDIA_TYPE)
        val builder = Request.Builder()
            .url("$host$path")
            .method(method, reqBody ?: if (method == "GET") null else "{}".toRequestBody(JSON_MEDIA_TYPE))
            .addHeader("Content-Type", "application/json")

        if (auth) {
            val token = store.getToken()
            // WHY: we don't log the token value — only whether it's present
            if (token == null) {
                return@withContext Pair(401, JSONObject().put("message", "not signed in"))
            }
            builder.addHeader("Authorization", "Bearer $token")
        }

        try {
            val resp = client.newCall(builder.build()).execute()
            val code = resp.code
            val raw = resp.body?.string() ?: "{}"
            // 202 Accepted = poll-pending — return synthetic pending body
            val json = if (code == 202) {
                JSONObject().put("status", "pending")
            } else {
                try { JSONObject(raw) } catch (_: Exception) { JSONObject() }
            }
            Pair(code, json)
        } catch (e: Exception) {
            Log.w(TAG, "HTTP $method $path failed: ${e.message}")
            Pair(0, JSONObject().put("message", e.message ?: "network error"))
        }
    }

    private fun errFromResponse(code: Int, body: JSONObject): ApiResult.Err =
        ApiResult.Err(code, body.optString("message", "HTTP $code"))

    /**
     * Raw-body variant for endpoints that return a JSON ARRAY (GET /social/friends,
     * GET /social/blocks). request() parses only a JSONObject, so a bare array would
     * be coerced to an empty object — these methods need the raw string to parse with
     * JSONArray. Mirrors request()'s auth + I/O error handling.
     */
    private suspend fun requestRaw(
        path: String,
        method: String = "GET",
        auth: Boolean = false,
    ): Pair<Int, String> = withContext(Dispatchers.IO) {
        val builder = Request.Builder()
            .url("$host$path")
            .method(method, if (method == "GET") null else "{}".toRequestBody(JSON_MEDIA_TYPE))
            .addHeader("Content-Type", "application/json")
        if (auth) {
            val token = store.getToken()
                ?: return@withContext Pair(401, "{\"message\":\"not signed in\"}")
            builder.addHeader("Authorization", "Bearer $token")
        }
        try {
            val resp = http.newCall(builder.build()).execute()
            Pair(resp.code, resp.body?.string() ?: "")
        } catch (e: Exception) {
            Log.w(TAG, "HTTP $method $path failed: ${e.message}")
            Pair(0, e.message ?: "network error")
        }
    }

    /** Extract an error message from a raw body: JSON {message} / {error}, else the raw text. */
    private fun extractMessage(raw: String, code: Int): String = try {
        val obj = JSONObject(raw)
        obj.optString("message").ifEmpty { obj.optString("error").ifEmpty { raw.trim().ifEmpty { "HTTP $code" } } }
    } catch (_: Exception) {
        raw.trim().ifEmpty { "HTTP $code" }
    }

    // ── Public API (mirrors TS client method by method) ──────────────────────

    /** POST /auth/github/start — initiates device-code OAuth flow */
    suspend fun authStart(): ApiResult<JSONObject> {
        val (code, body) = request("/auth/github/start", method = "POST")
        return if (code == 200) ApiResult.Ok(body) else errFromResponse(code, body)
    }

    /**
     * POST /auth/github/poll — polls for token.
     * Returns either { status: "pending" } (202) or { status: "complete", token: "..." } (200).
     * WHY: on complete, the caller in SessionService saves the token to the store.
     */
    suspend fun authPoll(deviceCode: String): ApiResult<JSONObject> {
        val (code, body) = request(
            "/auth/github/poll",
            method = "POST",
            body = JSONObject().put("device_code", deviceCode),
        )
        return if (code == 200 || code == 202) ApiResult.Ok(body) else errFromResponse(code, body)
    }

    /** POST /installs — records an install. Requires token. */
    suspend fun postInstall(pluginId: String): ApiResult<Unit> {
        val (code, body) = request(
            "/installs",
            method = "POST",
            body = JSONObject().put("plugin_id", pluginId),
            auth = true,
        )
        return if (code in 200..299) ApiResult.Ok(Unit) else errFromResponse(code, body)
    }

    /** POST /ratings — submit or update a rating. Requires token. */
    suspend fun postRating(
        pluginId: String,
        stars: Int,
        reviewText: String?,
    ): ApiResult<JSONObject> {
        val payload = JSONObject().apply {
            put("plugin_id", pluginId)
            put("stars", stars)
            if (!reviewText.isNullOrEmpty()) put("review_text", reviewText)
        }
        val (code, body) = request("/ratings", method = "POST", body = payload, auth = true)
        return if (code in 200..299) ApiResult.Ok(body) else errFromResponse(code, body)
    }

    /** DELETE /ratings/:pluginId — remove the caller's rating. Requires token. */
    suspend fun deleteRating(pluginId: String): ApiResult<Unit> {
        val encoded = URLEncoder.encode(pluginId, "UTF-8")
        val (code, body) = request("/ratings/$encoded", method = "DELETE", auth = true)
        return if (code in 200..299) ApiResult.Ok(Unit) else errFromResponse(code, body)
    }

    /** POST /themes/:themeId/like — toggle like. Requires token. */
    suspend fun toggleThemeLike(themeId: String): ApiResult<JSONObject> {
        val encoded = URLEncoder.encode(themeId, "UTF-8")
        val (code, body) = request("/themes/$encoded/like", method = "POST", auth = true)
        return if (code in 200..299) ApiResult.Ok(body) else errFromResponse(code, body)
    }

    // ── Marketplace feedback (overhaul §1.7) — thumbs + comments ──

    /** POST /thumbs — "up" / "down" / null (clear). Requires token; 403 without a
     *  prior install. The response carries the plugin's NEW totals so the React
     *  UI can move the number without re-fetching /stats. */
    suspend fun setThumb(pluginId: String, value: String?): ApiResult<JSONObject> {
        val payload = JSONObject().apply {
            put("plugin_id", pluginId)
            put("value", value ?: JSONObject.NULL)
        }
        val (code, body) = request("/thumbs", method = "POST", body = payload, auth = true)
        return if (code in 200..299) ApiResult.Ok(body) else errFromResponse(code, body)
    }

    /** GET /thumbs/{id} — the caller's own vote, or null. URL-encoded like
     *  toggleThemeLike: a bundle member's id is `<bundle>/<name>`, and an
     *  unencoded slash would address a different path. */
    suspend fun getThumb(pluginId: String): ApiResult<JSONObject> {
        val encoded = URLEncoder.encode(pluginId, "UTF-8")
        val (code, body) = request("/thumbs/$encoded", method = "GET", auth = true)
        return if (code in 200..299) ApiResult.Ok(body) else errFromResponse(code, body)
    }

    /** POST /comments — requires token, no install needed (asking a question
     *  BEFORE installing is the point). */
    suspend fun postComment(pluginId: String, text: String): ApiResult<JSONObject> {
        val payload = JSONObject().apply {
            put("plugin_id", pluginId)
            put("text", text)
        }
        val (code, body) = request("/comments", method = "POST", body = payload, auth = true)
        return if (code in 200..299) ApiResult.Ok(body) else errFromResponse(code, body)
    }

    // ── Account endpoints (Worker accounts Phase 1) — all auth'd, small JSON bodies ──
    // These mirror the desktop MarketplaceApiClient account methods. The wire shape
    // returned to React (via ApiResult.toJson) is identical to marketplace:rate etc.

    /** GET /auth/me — full account profile. Used by the account:user lazy heal. */
    suspend fun authMe(): ApiResult<JSONObject> {
        val (code, body) = request("/auth/me", method = "GET", auth = true)
        return if (code in 200..299) ApiResult.Ok(body) else errFromResponse(code, body)
    }

    /** PATCH /auth/profile — update display name. Returns { display_name }. */
    suspend fun updateProfile(displayName: String): ApiResult<JSONObject> {
        val (code, body) = request(
            "/auth/profile",
            method = "PATCH",
            body = JSONObject().put("display_name", displayName),
            auth = true,
        )
        return if (code in 200..299) ApiResult.Ok(body) else errFromResponse(code, body)
    }

    /** PUT /auth/handle — claim/change unique @handle. Returns { handle }. */
    suspend fun setHandle(handle: String): ApiResult<JSONObject> {
        val (code, body) = request(
            "/auth/handle",
            method = "PUT",
            body = JSONObject().put("handle", handle),
            auth = true,
        )
        return if (code in 200..299) ApiResult.Ok(body) else errFromResponse(code, body)
    }

    /** DELETE /auth/account — permanent hard-delete (Worker cascades all rows). */
    suspend fun deleteAccount(): ApiResult<JSONObject> {
        // 204/empty body comes back as JSONObject() from request() → Ok (2xx). Caller clears local session.
        val (code, body) = request("/auth/account", method = "DELETE", auth = true)
        return if (code in 200..299) ApiResult.Ok(body) else errFromResponse(code, body)
    }

    /** POST /auth/logout — server-side session revocation (best-effort on sign-out). */
    suspend fun logout(): ApiResult<JSONObject> {
        // Sign-out is best-effort server-side revocation: a hung network must not
        // hold the UI. Desktop uses a 5s AbortSignal; this is the Kotlin mirror.
        val logoutClient = http.newBuilder().callTimeout(5, TimeUnit.SECONDS).build()
        val (code, body) = request("/auth/logout", method = "POST", auth = true, client = logoutClient)
        return if (code in 200..299) ApiResult.Ok(body) else errFromResponse(code, body)
    }

    /** POST /reports — report a rating. Requires token. */
    suspend fun postReport(
        ratingUserId: String,
        ratingPluginId: String,
        reason: String?,
    ): ApiResult<Unit> {
        val payload = JSONObject().apply {
            put("rating_user_id", ratingUserId)
            put("rating_plugin_id", ratingPluginId)
            if (!reason.isNullOrEmpty()) put("reason", reason)
        }
        val (code, body) = request("/reports", method = "POST", body = payload, auth = true)
        return if (code in 200..299) ApiResult.Ok(Unit) else errFromResponse(code, body)
    }

    // ── Account data export (accounts Phase 2) ───────────────────────────────
    /** GET /auth/export — the full account data dump (one big JSON object). */
    suspend fun exportData(): ApiResult<JSONObject> {
        val (code, body) = request("/auth/export", method = "GET", auth = true)
        return if (code in 200..299) ApiResult.Ok(body) else errFromResponse(code, body)
    }

    // ── Social graph (accounts Phase 2) — all auth'd, mirror the desktop client.
    //    Object-returning endpoints reuse request(); the two LIST endpoints return
    //    a bare JSON array, so they use requestRaw() + JSONArray. Path params are
    //    URL-encoded (same convention as deleteRating above). ──

    /** GET /social/users/:handle — one card. 404 = unknown OR blocked (no oracle); 429 = cap. */
    suspend fun lookupHandle(handle: String): ApiResult<JSONObject> {
        val (code, body) = request("/social/users/${URLEncoder.encode(handle, "UTF-8")}", auth = true)
        return if (code in 200..299) ApiResult.Ok(body) else errFromResponse(code, body)
    }

    /** POST /social/requests — body { handle }. Returns { status: "pending"|"friends" }. 404/400/429. */
    suspend fun sendRequest(handle: String): ApiResult<JSONObject> {
        val (code, body) = request(
            "/social/requests",
            method = "POST",
            body = JSONObject().put("handle", handle),
            auth = true,
        )
        return if (code in 200..299) ApiResult.Ok(body) else errFromResponse(code, body)
    }

    /** GET /social/requests — { incoming: [...], outgoing: [...] }. */
    suspend fun listRequests(): ApiResult<JSONObject> {
        val (code, body) = request("/social/requests", auth = true)
        return if (code in 200..299) ApiResult.Ok(body) else errFromResponse(code, body)
    }

    /** POST /social/requests/:id/accept. */
    suspend fun acceptRequest(id: String): ApiResult<Unit> {
        val (code, body) = request("/social/requests/${URLEncoder.encode(id, "UTF-8")}/accept", method = "POST", auth = true)
        return if (code in 200..299) ApiResult.Ok(Unit) else errFromResponse(code, body)
    }

    /** POST /social/requests/:id/decline. */
    suspend fun declineRequest(id: String): ApiResult<Unit> {
        val (code, body) = request("/social/requests/${URLEncoder.encode(id, "UTF-8")}/decline", method = "POST", auth = true)
        return if (code in 200..299) ApiResult.Ok(Unit) else errFromResponse(code, body)
    }

    /** DELETE /social/requests/:id — cancel an outgoing request. */
    suspend fun cancelRequest(id: String): ApiResult<Unit> {
        val (code, body) = request("/social/requests/${URLEncoder.encode(id, "UTF-8")}", method = "DELETE", auth = true)
        return if (code in 200..299) ApiResult.Ok(Unit) else errFromResponse(code, body)
    }

    /** GET /social/friends — bare array of FriendRow. */
    suspend fun listFriends(): ApiResult<JSONArray> {
        val (code, raw) = requestRaw("/social/friends", auth = true)
        return if (code in 200..299) {
            // Fix: a 2xx with an unparseable body is a FAULT, not an empty list —
            // an empty-array fallback would render "no friends" and mask the bug.
            try { ApiResult.Ok(JSONArray(raw)) } catch (_: Exception) { ApiResult.Err(code, "malformed response") }
        } else ApiResult.Err(code, extractMessage(raw, code))
    }

    /** DELETE /social/friends/:userId. */
    suspend fun unfriend(userId: String): ApiResult<Unit> {
        val (code, body) = request("/social/friends/${URLEncoder.encode(userId, "UTF-8")}", method = "DELETE", auth = true)
        return if (code in 200..299) ApiResult.Ok(Unit) else errFromResponse(code, body)
    }

    /** POST /social/blocks — body { user_id }. Severs friendship + clears requests both ways. */
    suspend fun block(userId: String): ApiResult<Unit> {
        val (code, body) = request(
            "/social/blocks",
            method = "POST",
            body = JSONObject().put("user_id", userId),
            auth = true,
        )
        return if (code in 200..299) ApiResult.Ok(Unit) else errFromResponse(code, body)
    }

    /** DELETE /social/blocks/:userId. */
    suspend fun unblock(userId: String): ApiResult<Unit> {
        val (code, body) = request("/social/blocks/${URLEncoder.encode(userId, "UTF-8")}", method = "DELETE", auth = true)
        return if (code in 200..299) ApiResult.Ok(Unit) else errFromResponse(code, body)
    }

    /** GET /social/blocks — bare array of BlockRow (owner-only view). */
    suspend fun listBlocks(): ApiResult<JSONArray> {
        val (code, raw) = requestRaw("/social/blocks", auth = true)
        return if (code in 200..299) {
            // Fix: 2xx + unparseable body = fault, not an empty block list (see listFriends).
            try { ApiResult.Ok(JSONArray(raw)) } catch (_: Exception) { ApiResult.Err(code, "malformed response") }
        } else ApiResult.Err(code, extractMessage(raw, code))
    }

    // ── Games arcade (spec §6.1) ─ mirrors the three desktop client methods in
    //    marketplace-api-client.ts (gameScores / gameBoard / submitGameScore).
    //    All three are auth'd and return a JSON OBJECT, so plain request() serves
    //    them ─ no requestRaw()/JSONArray branch is needed here.
    //
    //    Scores cross this boundary as RAW NUMBERS. How a game WORDS a score
    //    ("31 pipes", "12,480") lives in that game's entry in the renderer's
    //    game-registry.ts, so adding a game never touches this file. ──

    /** GET /games/scores ─ my own best in every solo game I have played, keyed by
     *  game id: { "flappy": { best, best_at, runs } }. `{}` when nothing has been
     *  played, which is a legitimate empty result and not an error. */
    suspend fun gameScores(): ApiResult<JSONObject> {
        val (code, body) = request("/games/scores", method = "GET", auth = true)
        return if (code in 200..299) ApiResult.Ok(body) else errFromResponse(code, body)
    }

    /** GET /games/scores/:game ─ one game's friends leaderboard,
     *  { game, you, entries }. URL-encoded like the other path params above. */
    suspend fun gameBoard(game: String): ApiResult<JSONObject> {
        val (code, body) = request("/games/scores/${URLEncoder.encode(game, "UTF-8")}", method = "GET", auth = true)
        return if (code in 200..299) ApiResult.Ok(body) else errFromResponse(code, body)
    }

    /** POST /games/scores ─ publish a finished run. Returns
     *  { ok, best, best_at, runs, is_best }; `is_best` is the one fact the
     *  end-of-run screen cannot work out for itself. */
    suspend fun submitGameScore(game: String, score: Int): ApiResult<JSONObject> {
        val payload = JSONObject().apply {
            put("game", game)
            put("score", score)
        }
        val (code, body) = request("/games/scores", method = "POST", body = payload, auth = true)
        return if (code in 200..299) ApiResult.Ok(body) else errFromResponse(code, body)
    }
}
