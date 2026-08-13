package com.youcoded.app.artifacts

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Mirrors desktop/tests/artifacts/write-authorization.test.ts. A relative
 * absolutePath in a sidecar record resolves against the app process cwd ("/"
 * on Android), producing a false "no longer on disk" for a file that exists.
 */
class ArtifactPathGuardTest {
    @Test
    fun posixAbsoluteIsAccepted() {
        assertTrue(isAbsoluteRecorded("/data/user/0/com.youcoded.app/files/notes.md"))
    }

    @Test
    fun relativePathIsRejected() {
        assertFalse(isAbsoluteRecorded("flappy-bird/play.html"))
        assertFalse(isAbsoluteRecorded("ROADMAP.md"))
    }

    // A synced Windows record is not addressable on Android. Refusing it yields
    // the same orphan the existing File("C:/...").exists() == false produced.
    @Test
    fun windowsDrivePathIsRejectedOnAndroid() {
        assertFalse(isAbsoluteRecorded("C:/Users/desti/notes.md"))
    }

    @Test
    fun emptyPathIsRejected() {
        assertFalse(isAbsoluteRecorded(""))
    }
}
