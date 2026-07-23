package com.youcoded.app.artifacts

import org.json.JSONObject
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Runs the SAME fixture as the desktop editable-path-policy.test.ts so the two
 * implementations of the D5 write boundary cannot drift — Android implements
 * artifacts:save for real, so a verdict mismatch here is a security bug, not a
 * cosmetic one.
 */
class EditablePathPolicyTest {

    private fun tierOf(s: String) = when (s) {
        "free" -> EditablePathPolicy.EditTier.FREE
        "needs-confirm" -> EditablePathPolicy.EditTier.NEEDS_CONFIRM
        "denied" -> EditablePathPolicy.EditTier.DENIED
        else -> error("unknown tier in fixture: $s")
    }

    @Test
    fun runsAllSharedFixtures() {
        val text = javaClass.classLoader!!
            .getResourceAsStream("artifacts/editable-path-policy-cases.json")!!
            .bufferedReader().readText()
        val cases = JSONObject(text).getJSONArray("cases")
        for (i in 0 until cases.length()) {
            val o = cases.getJSONObject(i)
            val path = o.getString("path")
            assertEquals(tierOf(o.getString("tier")), EditablePathPolicy.editTier(path), "tier for $path")
            assertEquals(o.getBoolean("protectedRead"), EditablePathPolicy.protectedReadPath(path), "protectedRead for $path")
        }
    }

    @Test
    fun readBinaryDenyIncludesDotenv() {
        // isSensitivePath is the read-binary deny-list: sensitive set PLUS dotenv
        // (unlike protectedReadPath, which exempts dotenv for the edit flow).
        assertTrue(EditablePathPolicy.isSensitivePath("/home/u/proj/.env"))
        assertTrue(EditablePathPolicy.isSensitivePath("/home/u/.ssh/id_rsa"))
        assertFalse(EditablePathPolicy.isSensitivePath("/home/u/proj/src/app.ts"))
    }

    @Test
    fun looksBinarySniffsNulInHeadOnly() {
        assertTrue(EditablePathPolicy.looksBinary(byteArrayOf(0x50, 0x4b, 0x00, 0x01)))
        assertFalse(EditablePathPolicy.looksBinary("plain text".toByteArray()))
        val big = ByteArray(10000) { 0x61 }
        big[9000] = 0 // beyond the 8KB sniff window
        assertFalse(EditablePathPolicy.looksBinary(big))
    }
}
