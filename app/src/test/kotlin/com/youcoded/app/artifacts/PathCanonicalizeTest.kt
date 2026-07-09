package com.youcoded.app.artifacts

import org.json.JSONObject
import org.junit.Test
import kotlin.test.assertEquals

class PathCanonicalizeTest {

    @Test
    fun runsAllSharedFixtures() {
        val text = javaClass.classLoader!!
            .getResourceAsStream("artifacts/canonicalize-cases.json")!!
            .bufferedReader().readText()
        val obj = JSONObject(text)
        val cases = obj.getJSONArray("cases")
        for (i in 0 until cases.length()) {
            val o = cases.getJSONObject(i)
            val input = o.getString("input")
            val root = if (o.isNull("projectRoot")) null else o.getString("projectRoot")
            val expected = o.getString("expected")
            assertEquals(expected, canonicalize(input, root), "input=$input")
        }
    }

    @Test
    fun nfcNormalization() {
        // NFC composed form (single codepoint é — U+00E9)
        val nfc = "café.md"
        // NFD decomposed form (e + U+0301 combining acute accent)
        val nfd = "café.md"
        assertEquals(canonicalize(nfc, null), canonicalize(nfd, null))
    }
}
