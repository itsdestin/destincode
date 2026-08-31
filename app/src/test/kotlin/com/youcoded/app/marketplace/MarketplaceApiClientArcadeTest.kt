package com.youcoded.app.marketplace

import android.content.SharedPreferences
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.After
import org.junit.Before
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The three games-arcade methods on MarketplaceApiClient, driven against a
 * MockWebServer (same approach as AnalyticsServiceTest — no Robolectric, no
 * real network).
 *
 * WHAT THIS PINS: the exact HTTP call each method makes (method + path + body)
 * and the ApiResult it maps the reply to. Those are the halves that have to
 * agree with the Worker (wecoded-marketplace worker/src/games/routes.ts) and
 * with the desktop client (desktop/src/renderer/state/marketplace-api-client.ts)
 * — if either drifts, the Android games panel silently shows "no board" while
 * the desktop one works, which is the failure mode hardest to notice.
 */
class MarketplaceApiClientArcadeTest {

    /** In-memory SharedPreferences fake — same trick as MarketplaceAuthStoreTest,
     *  so the store can hold a token without any Android framework. */
    private class FakePrefs : SharedPreferences {
        private val map = mutableMapOf<String, Any?>()
        private val editor = object : SharedPreferences.Editor {
            override fun putString(key: String, value: String?) = apply { map[key] = value }
            override fun putInt(key: String, value: Int) = apply { map[key] = value }
            override fun putLong(key: String, value: Long) = apply { map[key] = value }
            override fun putFloat(key: String, value: Float) = apply { map[key] = value }
            override fun putBoolean(key: String, value: Boolean) = apply { map[key] = value }
            override fun putStringSet(key: String, values: MutableSet<String>?) = apply { map[key] = values }
            override fun remove(key: String) = apply { map.remove(key) }
            override fun clear() = apply { map.clear() }
            override fun commit(): Boolean = true
            override fun apply() { /* in-memory, no async needed */ }
        }
        override fun contains(key: String) = map.containsKey(key)
        override fun getAll(): MutableMap<String, *> = map
        override fun getString(key: String, defValue: String?) = (map[key] as? String) ?: defValue
        override fun getInt(key: String, defValue: Int) = (map[key] as? Int) ?: defValue
        override fun getLong(key: String, defValue: Long) = (map[key] as? Long) ?: defValue
        override fun getFloat(key: String, defValue: Float) = (map[key] as? Float) ?: defValue
        override fun getBoolean(key: String, defValue: Boolean) = (map[key] as? Boolean) ?: defValue
        override fun getStringSet(key: String, defValues: MutableSet<String>?) = (map[key] as? MutableSet<String>) ?: defValues
        override fun registerOnSharedPreferenceChangeListener(l: SharedPreferences.OnSharedPreferenceChangeListener?) {}
        override fun unregisterOnSharedPreferenceChangeListener(l: SharedPreferences.OnSharedPreferenceChangeListener?) {}
        override fun edit(): SharedPreferences.Editor = editor
    }

    private lateinit var server: MockWebServer
    private lateinit var store: MarketplaceAuthStore

    @Before
    fun setUp() {
        server = MockWebServer().apply { start() }
        store = MarketplaceAuthStore(FakePrefs())
    }

    @After
    fun tearDown() = server.shutdown()

    private fun signedInClient(): MarketplaceApiClient {
        store.setToken("gh_tok_test")
        return MarketplaceApiClient(store, host = server.url("/").toString().trimEnd('/'))
    }

    @Test
    fun `gameScores GETs games scores with the bearer token and returns the keyed object`() = runTest {
        server.enqueue(
            MockResponse().setResponseCode(200)
                .setBody("""{"flappy":{"best":31,"best_at":1756600000,"runs":12}}""")
        )
        val result = signedInClient().gameScores()

        val req = server.takeRequest()
        assertEquals("GET", req.method)
        assertEquals("/games/scores", req.path)
        assertEquals("Bearer gh_tok_test", req.getHeader("Authorization"))

        assertTrue(result is ApiResult.Ok)
        val flappy = (result as ApiResult.Ok).value.getJSONObject("flappy")
        assertEquals(31, flappy.getInt("best"))
        assertEquals(12, flappy.getInt("runs"))
    }

    @Test
    fun `gameScores maps an empty object to Ok, not an error`() = runTest {
        // Nothing played yet is a legitimate empty answer from the Worker. If this
        // came back as an error the arcade would show a fault where it should show
        // "you haven't played anything yet".
        server.enqueue(MockResponse().setResponseCode(200).setBody("{}"))
        val result = signedInClient().gameScores()
        assertTrue(result is ApiResult.Ok)
        assertEquals(0, (result as ApiResult.Ok).value.length())
    }

    @Test
    fun `gameScores without a token is a 401 and makes no network call`() = runTest {
        // Signed out we must not spend a request to be told what we already know —
        // and the 401 is what makes the renderer fall back to on-device bests.
        val client = MarketplaceApiClient(store, host = server.url("/").toString().trimEnd('/'))
        val result = client.gameScores()
        assertTrue(result is ApiResult.Err)
        assertEquals(401, (result as ApiResult.Err).status)
        assertEquals(0, server.requestCount)
    }

    @Test
    fun `gameBoard GETs the per-game path and returns game, you and entries`() = runTest {
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """{"game":"flappy","you":{"id":"u1","best_score":31,"rank":1,"is_you":true},
                    "entries":[{"id":"u1","best_score":31,"rank":1,"is_you":true},
                               {"id":"u2","best_score":18,"rank":2,"is_you":false}]}"""
            )
        )
        val result = signedInClient().gameBoard("flappy")

        val req = server.takeRequest()
        assertEquals("GET", req.method)
        assertEquals("/games/scores/flappy", req.path)

        assertTrue(result is ApiResult.Ok)
        val board = (result as ApiResult.Ok).value
        assertEquals("flappy", board.getString("game"))
        assertEquals(2, board.getJSONArray("entries").length())
        assertEquals(31, board.getJSONObject("you").getInt("best_score"))
    }

    @Test
    fun `gameBoard surfaces the Worker's own message on a rejection`() = runTest {
        // The Worker names the games it accepts. Passing that through verbatim beats
        // any cause this layer could guess at.
        server.enqueue(
            MockResponse().setResponseCode(400)
                .setBody("""{"message":"game must be one of: flappy"}""")
        )
        val result = signedInClient().gameBoard("nope")
        assertTrue(result is ApiResult.Err)
        assertEquals(400, (result as ApiResult.Err).status)
        assertEquals("game must be one of: flappy", result.message)
    }

    @Test
    fun `submitGameScore POSTs game and score and returns the run summary`() = runTest {
        server.enqueue(
            MockResponse().setResponseCode(200)
                .setBody("""{"ok":true,"best":31,"best_at":1756600000,"runs":13,"is_best":true}""")
        )
        val result = signedInClient().submitGameScore("flappy", 31)

        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/games/scores", req.path)
        val sent = JSONObject(req.body.readUtf8())
        assertEquals("flappy", sent.getString("game"))
        // The score crosses the wire as a raw NUMBER, never a formatted string —
        // the words a game uses for a score live in the renderer's game registry.
        assertEquals(31, sent.getInt("score"))

        assertTrue(result is ApiResult.Ok)
        val body = (result as ApiResult.Ok).value
        assertEquals(13, body.getInt("runs"))
        assertTrue(body.getBoolean("is_best"))
    }

    @Test
    fun `submitGameScore reports a rate limit as itself`() = runTest {
        server.enqueue(
            MockResponse().setResponseCode(429)
                .setBody("""{"message":"too many score submissions per hour"}""")
        )
        val result = signedInClient().submitGameScore("flappy", 5)
        assertTrue(result is ApiResult.Err)
        assertEquals(429, (result as ApiResult.Err).status)
        assertEquals("too many score submissions per hour", result.message)
    }
}
