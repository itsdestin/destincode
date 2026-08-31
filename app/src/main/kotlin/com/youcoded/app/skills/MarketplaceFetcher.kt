package com.youcoded.app.skills

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

// Marketplace overhaul: the Cloudflare Worker that serves the catalog. This is the
// Kotlin copy of MARKETPLACE_API_HOST in
// desktop/src/renderer/state/marketplace-api-client.ts. Two hand-maintained copies of
// one URL in two languages is exactly the drift the IPC parity tests exist to catch,
// so desktop/tests/ipc-channels.test.ts asserts the two strings are byte-identical.
internal const val MARKETPLACE_API_HOST = "https://wecoded-marketplace-api.destinj101.workers.dev"

/**
 * The whole of one HTTP GET that this file needs. `status` is inspected before `body`
 * because a 304 has no body, and `etag` is kept so the next request can send it back.
 */
data class HttpText(val status: Int, val body: String, val etag: String?)

/**
 * The real network read. Sends `If-None-Match: <etag>` when [etag] is non-null so the
 * Worker can answer `304 Not Modified` with an empty body instead of re-sending several
 * megabytes of catalog over the user's mobile data.
 *
 * `internal` rather than `private` because it is referenced from MarketplaceFetcher's
 * default constructor argument, which is compiled into a synthetic method on the class.
 */
internal fun httpGet(url: String, etag: String?): HttpText {
    val conn = URL(url).openConnection() as HttpURLConnection
    try {
        conn.requestMethod = "GET"
        conn.connectTimeout = 15_000
        conn.readTimeout = 30_000
        if (etag != null) conn.setRequestProperty("If-None-Match", etag)
        val status = conn.responseCode
        // A 304 carries no body at all; the caller reuses the cached one. Any 4xx/5xx
        // makes `inputStream` throw, which the callers already treat as "fetch failed".
        val body =
            if (status == HttpURLConnection.HTTP_NOT_MODIFIED) ""
            else conn.inputStream.bufferedReader().use { it.readText() }
        return HttpText(status, body, conn.getHeaderField("ETag"))
    } finally {
        conn.disconnect()
    }
}

class MarketplaceFetcher(
    private val homeDir: File,
    private val bundledIndexProvider: (() -> JSONArray)? = null,
    // Injectable so JVM unit tests can drive the fetcher with no network. Production
    // uses the real reader above. It hands back the status and ETag as well as the body
    // because the catalog is fetched with a conditional GET (see fetchIndex).
    private val readUrl: (String, String?) -> HttpText = ::httpGet,
) {

    private val cacheDir = File(homeDir, ".claude/youcoded-marketplace-cache")
    // Fix: the wecoded-marketplace repo's source of truth is `master`, not `main`.
    // `main` has no index.json, so every fetch here was 404-ing silently — desktop
    // uses `master` (desktop/src/main/skill-provider.ts REGISTRY_BASE) and we were
    // the only platform diverged.
    private val registryBase = "https://raw.githubusercontent.com/itsdestin/wecoded-marketplace/master"
    // Marketplace overhaul: the Worker's catalog carries the type / origin / scan /
    // capabilities block that raw index.json has no room for; index.json stays the fallback.
    private val catalogUrl = "$MARKETPLACE_API_HOST/catalog"
    private val statsTtl = 60 * 60 * 1000L       // 1 hour
    private val indexTtl = 24 * 60 * 60 * 1000L   // 24 hours
    private val catalogTtl = 60 * 60 * 1000L      // 1 hour — the ingest job refreshes hourly

    init {
        if (!cacheDir.exists()) cacheDir.mkdirs()
    }

    /**
     * The marketplace listing, newest source first: fresh catalog cache → the Worker's
     * catalog → raw index.json → anything stale on disk → the bundled copy. Mirrors
     * desktop's skill-provider.ts fetchIndex().
     */
    fun fetchIndex(): JSONArray {
        val catalogFile = File(cacheDir, "catalog.json")
        val indexFile = File(cacheDir, "index.json")
        fun parseArray(s: String): JSONArray? = try { JSONArray(s) } catch (_: Exception) { null }

        // 1. Fresh catalog cache — no network at all.
        readCache(catalogFile, catalogTtl)?.let { parseArray(it) }?.let { return it }

        // 2. The Worker's catalog: { generated_at, entries: [...] } — we cache only the array.
        //    We send the stored ETag: this response is several megabytes and we ask hourly,
        //    so on the ~23 hours in 24 when nothing changed the Worker answers 304 with an
        //    empty body and the phone spends a few hundred bytes instead of ~5 MB of the
        //    user's mobile data. That is why readUrl reports the status and ETag, not just
        //    the body. The ETag is an opaque string — stored, sent back, never parsed.
        try {
            val prev = readCacheEtag(catalogFile)
            val res = readUrl(catalogUrl, prev)
            if (res.status == HttpURLConnection.HTTP_NOT_MODIFIED) {
                readCache(catalogFile, Long.MAX_VALUE)?.let { parseArray(it) }?.let {
                    touchCache(catalogFile)
                    return it
                }
                // Cache unreadable despite the 304 — fall through to index.json below.
            } else {
                val entries = JSONObject(res.body).getJSONArray("entries")
                writeCache(catalogFile, entries.toString(), res.etag)
                return entries
            }
        } catch (e: Exception) {
            // Includes the 503 from the Worker's CATALOG_ENABLED kill switch, which is
            // meant to be indistinguishable from any other failure here.
            Log.w("MarketplaceFetcher", "Catalog fetch failed, trying index.json", e)
        }

        // 3. Raw index.json (the pre-overhaul path).
        readCache(indexFile, indexTtl)?.let { parseArray(it) }?.let { return it }
        try {
            val data = readUrl("$registryBase/index.json", null).body
            val arr = JSONArray(data)
            writeCache(indexFile, data)
            return arr
        } catch (e: Exception) {
            Log.w("MarketplaceFetcher", "Failed to fetch index", e)
        }

        // 4. Anything stale, newest source first, then the copy bundled in the APK.
        return readCache(catalogFile, Long.MAX_VALUE)?.let { parseArray(it) }
            ?: readCache(indexFile, Long.MAX_VALUE)?.let { parseArray(it) }
            ?: bundledIndexProvider?.invoke()
            ?: JSONArray()
    }

    fun fetchStats(): JSONObject {
        val cacheFile = File(cacheDir, "stats.json")
        readCache(cacheFile, statsTtl)?.let {
            return try { JSONObject(it) } catch (_: Exception) { JSONObject() }
        }
        return try {
            val data = URL("$registryBase/stats.json").readText()
            val obj = JSONObject(data)
            val skills = obj.optJSONObject("skills") ?: JSONObject()
            writeCache(cacheFile, skills.toString())
            skills
        } catch (e: Exception) {
            Log.w("MarketplaceFetcher", "Failed to fetch stats", e)
            readCache(cacheFile, Long.MAX_VALUE)?.let {
                try { JSONObject(it) } catch (_: Exception) { JSONObject() }
            } ?: JSONObject()
        }
    }

    // Marketplace redesign Phase 1: fetch discovery curation (hero/rails).
    // Pass-through — returns the full object so both legacy fields and the
    // new hero/rails flow to the renderer without schema assumptions.
    fun fetchFeatured(): JSONObject {
        val cacheFile = File(cacheDir, "featured.json")
        readCache(cacheFile, indexTtl)?.let {
            return try { JSONObject(it) } catch (_: Exception) { JSONObject() }
        }
        return try {
            val data = URL("$registryBase/featured.json").readText()
            val obj = JSONObject(data)
            writeCache(cacheFile, data)
            obj
        } catch (e: Exception) {
            Log.w("MarketplaceFetcher", "Failed to fetch featured", e)
            readCache(cacheFile, Long.MAX_VALUE)?.let {
                try { JSONObject(it) } catch (_: Exception) { JSONObject() }
            } ?: JSONObject()
        }
    }

    // Integrations catalog — same registry, different path. Static JSON
    // describing OAuth/API-key/plugin-wrapped integrations (Gmail, Drive,
    // Spotify, etc.). Cached 24h. Used by the "Connect your stuff" rail in
    // the marketplace. Mirrors desktop's IntegrationInstaller.listCatalog.
    fun fetchIntegrations(): JSONArray {
        val cacheFile = File(cacheDir, "integrations.json")
        readCache(cacheFile, indexTtl)?.let {
            return try { extractIntegrationsArray(JSONObject(it)) } catch (_: Exception) { JSONArray() }
        }
        return try {
            val data = URL("$registryBase/integrations/index.json").readText()
            writeCache(cacheFile, data)
            extractIntegrationsArray(JSONObject(data))
        } catch (e: Exception) {
            Log.w("MarketplaceFetcher", "Failed to fetch integrations", e)
            readCache(cacheFile, Long.MAX_VALUE)?.let {
                try { extractIntegrationsArray(JSONObject(it)) } catch (_: Exception) { JSONArray() }
            } ?: JSONArray()
        }
    }

    // Index file is `{ "integrations": [...] }` per the desktop IntegrationIndex
    // shape (see desktop/src/shared/types.ts). Tolerates a bare-array shape too.
    private fun extractIntegrationsArray(obj: JSONObject): JSONArray =
        obj.optJSONArray("integrations") ?: JSONArray()

    fun fetchCuratedDefaults(): JSONArray {
        val cacheFile = File(cacheDir, "curated-defaults.json")
        readCache(cacheFile, indexTtl)?.let {
            return try { JSONArray(it) } catch (_: Exception) { JSONArray() }
        }
        return try {
            val data = URL("$registryBase/curated-defaults.json").readText()
            val obj = JSONObject(data)
            val defaults = obj.optJSONArray("defaults") ?: JSONArray()
            writeCache(cacheFile, defaults.toString())
            defaults
        } catch (e: Exception) {
            Log.w("MarketplaceFetcher", "Failed to fetch curated defaults", e)
            readCache(cacheFile, Long.MAX_VALUE)?.let {
                try { JSONArray(it) } catch (_: Exception) { JSONArray() }
            } ?: JSONArray()
        }
    }

    private fun readCache(file: File, ttl: Long): String? {
        return try {
            val raw = file.readText()
            val obj = JSONObject(raw)
            val fetchedAt = obj.optLong("fetchedAt", 0)
            if (System.currentTimeMillis() - fetchedAt > ttl) return null
            obj.optString("data", null)
        } catch (_: Exception) {
            null
        }
    }

    /** The ETag stored beside the cached body, ignoring the TTL — a stale body still has
     *  a valid ETag to revalidate with, which is the whole point of the conditional GET. */
    private fun readCacheEtag(file: File): String? = try {
        JSONObject(file.readText()).optString("etag", "").takeIf { it.isNotEmpty() }
    } catch (_: Exception) {
        null
    }

    /** Mark a cached body fresh again without rewriting it — what a 304 means. */
    private fun touchCache(file: File) {
        try {
            val obj = JSONObject(file.readText())
            obj.put("fetchedAt", System.currentTimeMillis())
            file.writeText(obj.toString())
        } catch (_: Exception) { /* best-effort */ }
    }

    private fun writeCache(file: File, data: String, etag: String? = null) {
        try {
            file.writeText(JSONObject().apply {
                put("fetchedAt", System.currentTimeMillis())
                put("data", data)
                if (etag != null) put("etag", etag)
            }.toString())
        } catch (_: Exception) { /* best-effort */ }
    }
}
