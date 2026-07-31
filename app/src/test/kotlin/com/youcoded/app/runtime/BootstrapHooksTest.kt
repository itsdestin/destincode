package com.youcoded.app.runtime

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

/** Guards the 2026-07-30 spec §Constraints inversion: an install that already
 *  has the hook must still receive a changed timeout on the next launch. */
class BootstrapHooksTest {

    private fun existingHooks(timeout: Int): JSONObject {
        val h = JSONObject().put("type", "command")
            .put("command", "node /old/path/hook-relay-blocking.js").put("timeout", timeout)
        val entry = JSONObject().put("matcher", ".*")
            .put("hooks", JSONArray().put(h))
        return JSONObject().put("PermissionRequest", JSONArray().put(entry))
    }

    @Test
    fun `overwrites timeout and command on an existing entry`() {
        val hooksObj = existingHooks(300)
        Bootstrap.ensurePermissionRequestHook(hooksObj, "node /new/path/hook-relay-blocking.js", 10800)
        val h = hooksObj.getJSONArray("PermissionRequest")
            .getJSONObject(0).getJSONArray("hooks").getJSONObject(0)
        assertEquals(10800, h.getInt("timeout"))
        assertEquals("node /new/path/hook-relay-blocking.js", h.getString("command"))
    }

    @Test
    fun `appends a new entry when none exists`() {
        val hooksObj = JSONObject()
        Bootstrap.ensurePermissionRequestHook(hooksObj, "node /p/hook-relay-blocking.js", 10800)
        val arr = hooksObj.getJSONArray("PermissionRequest")
        assertEquals(1, arr.length())
        val h = arr.getJSONObject(0).getJSONArray("hooks").getJSONObject(0)
        assertEquals(10800, h.getInt("timeout"))
        assertEquals("command", h.getString("type"))
    }

    @Test
    fun `does not duplicate on repeat runs`() {
        val hooksObj = existingHooks(300)
        Bootstrap.ensurePermissionRequestHook(hooksObj, "node /p/hook-relay-blocking.js", 10800)
        Bootstrap.ensurePermissionRequestHook(hooksObj, "node /p/hook-relay-blocking.js", 10800)
        assertEquals(1, hooksObj.getJSONArray("PermissionRequest").length())
    }
}
