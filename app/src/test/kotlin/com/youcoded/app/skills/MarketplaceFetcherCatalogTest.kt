package com.youcoded.app.skills

import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

/**
 * Marketplace overhaul, Task 19: MarketplaceFetcher.fetchIndex() reads the Worker's
 * catalog first (conditional GET, 304 reuses the cached body), falls back to raw
 * index.json, then to anything stale on disk. The network is stubbed through the
 * fetcher's injectable `readUrl`, so nothing here touches a socket.
 *
 * `android.util.Log` is reached on the fallback paths — it works here only because
 * app/build.gradle.kts sets `testOptions { unitTests.isReturnDefaultValues = true }`.
 */
class MarketplaceFetcherCatalogTest {
    private val temps = mutableListOf<File>()

    private fun home(): File =
        Files.createTempDirectory("yc-catalog").toFile().also { temps += it }

    @After
    fun tearDown() {
        temps.forEach { it.deleteRecursively() }
    }

    private val catalogBody = """{"generated_at":1,"entries":[{"id":"superpowers","type":"plugin","displayName":"Superpowers",
        "description":"x","category":"development","catalog":{"itemType":"plugin","origin":{"tier":"verified"},
        "scan":{"status":"checked"},"capabilities":[],"sourceCommit":"e91a6c0"}}]}"""

    private val indexBody = """[{"id":"superpowers","type":"plugin","displayName":"Superpowers","description":"x","category":"development"}]"""

    /** Ages the on-disk envelope past its TTL. Matches `writeCache`'s
     *  `{ fetchedAt, data, etag? }` shape — the `etag` survives, which is the point. */
    private fun expireCache(file: File) {
        val json = JSONObject(file.readText())
        json.put("fetchedAt", 0L)
        file.writeText(json.toString())
    }

    @Test
    fun `prefers the Worker catalog and keeps the catalog block`() {
        val hits = mutableListOf<String>()
        val f = MarketplaceFetcher(
            home(),
            readUrl = { url, _ ->
                hits += url
                if (url.endsWith("/catalog")) HttpText(200, catalogBody, "\"cat-7\"")
                else error("unexpected $url")
            },
        )
        val arr = f.fetchIndex()
        assertEquals(1, hits.size)
        assertTrue(hits[0].endsWith("/catalog"))
        assertEquals("e91a6c0", arr.getJSONObject(0).getJSONObject("catalog").getString("sourceCommit"))
    }

    @Test
    fun `falls back to index json when the Worker fails`() {
        val hits = mutableListOf<String>()
        val f = MarketplaceFetcher(
            home(),
            readUrl = { url, _ ->
                hits += url
                if (url.endsWith("/catalog")) error("503") else HttpText(200, indexBody, null)
            },
        )
        val arr = f.fetchIndex()
        assertEquals(2, hits.size)
        assertTrue(hits[1].endsWith("/index.json"))
        assertEquals("superpowers", arr.getJSONObject(0).getString("id"))
        assertTrue(arr.getJSONObject(0).optJSONObject("catalog") == null)
    }

    @Test
    fun `serves the catalog from cache within the TTL`() {
        var n = 0
        val f = MarketplaceFetcher(
            home(),
            readUrl = { _, _ ->
                n++
                HttpText(200, catalogBody, null)
            },
        )
        f.fetchIndex()
        f.fetchIndex()
        assertEquals(1, n)
    }

    @Test
    fun `sends the stored ETag and keeps the body on a 304`() {
        val h = home()
        val seen = mutableListOf<String?>()
        var first = true
        val f = MarketplaceFetcher(
            h,
            readUrl = { _, tag ->
                seen += tag
                if (first) {
                    first = false
                    HttpText(200, catalogBody, "\"cat-7\"")
                } else {
                    HttpText(304, "", null)
                }
            },
        )
        f.fetchIndex()
        expireCache(File(h, ".claude/youcoded-marketplace-cache/catalog.json"))
        val arr = f.fetchIndex()
        assertEquals(listOf(null, "\"cat-7\""), seen)
        assertEquals("superpowers", arr.getJSONObject(0).getString("id"))
    }
}
