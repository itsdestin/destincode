package com.youcoded.app.parser

import org.junit.Assert.assertFalse
import org.junit.Test

/**
 * hasPendingPermission is the Android side of the stray-Enter fix (youcoded
 * PR #110): while a PermissionRequest socket is held open, the session's PTY
 * shows a live Ink select menu, so automated writers (the /reload-plugins
 * write, PtyBridge's deferred Enter) must not type into it.
 *
 * The held-socket path needs a real LocalSocket (Android runtime), so the
 * positive case is covered by the release-test APK flow rather than JVM unit
 * tests; this pins the empty-state contract and that the API exists.
 */
class EventBridgePendingPermissionTest {
    @Test
    fun `no pending permission on a fresh bridge`() {
        val bridge = EventBridge("test-socket-name")
        assertFalse(bridge.hasPendingPermission())
    }
}
