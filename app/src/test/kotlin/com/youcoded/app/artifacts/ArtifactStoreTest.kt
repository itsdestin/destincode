package com.youcoded.app.artifacts

import org.junit.Test
import java.nio.file.Files
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ArtifactStoreTest {

    // ROADMAP L696 — the Android half of the same fix. `null` used to mean
    // "write regardless" on the create path, so a second creator silently
    // overwrote the first's record. It now means "the file must not exist".
    @Test
    fun aCreatingWriteIsRefusedWhenTheSidecarAlreadyExists() {
        val projectRoot = Files.createTempDirectory("kt-as-race-").toFile()
        try {
            // Stand in for the other writer having won the race.
            assertTrue(appendVersion(projectRoot.absolutePath, "p1", "test",
                AppendVersionInput("theirs.md", "internal", null, "s1", "create", "agent")))

            // A writer that read Missing BEFORE that landed still holds
            // expectedUpdatedAt = null. Its write must be refused, not applied.
            val fresh = ProjectSidecar(projectId = "p1", name = "test",
                createdAt = "2026-01-01T00:00:00Z", updatedAt = "2026-01-01T00:00:00Z")
            assertTrue(!writeSidecar(projectRoot.absolutePath, null, fresh),
                "A null expectation must REQUIRE the file to be absent")

            // Their record survives — that is the whole point.
            val after = readSidecar(projectRoot.absolutePath)
            assertTrue(after is ReadResult.Ok)
            assertEquals(listOf("theirs.md"), (after as ReadResult.Ok).sidecar.artifacts.map { it.path })
        } finally {
            projectRoot.deleteRecursively()
        }
    }

    @Test
    fun aCorruptSidecarIsStillReplaced() {
        // The other half of splitting null: corruption recovery deliberately
        // overwrites, so it must not be caught by the must-not-exist rule.
        val projectRoot = Files.createTempDirectory("kt-as-corrupt-").toFile()
        try {
            val dir = java.io.File(projectRoot, ".youcoded")
            dir.mkdirs()
            java.io.File(dir, "artifacts.json").writeText("{ this is not json")

            assertTrue(appendVersion(projectRoot.absolutePath, "p1", "test",
                AppendVersionInput("a.md", "internal", null, "s1", "create", "agent")),
                "corruption recovery must still commit")

            val after = readSidecar(projectRoot.absolutePath)
            assertTrue(after is ReadResult.Ok)
            assertEquals(listOf("a.md"), (after as ReadResult.Ok).sidecar.artifacts.map { it.path })
        } finally {
            projectRoot.deleteRecursively()
        }
    }

    @Test
    fun roundTripsSidecar() {
        val projectRoot = Files.createTempDirectory("kt-as-").toFile()
        try {
            // readSidecar on a non-existent sidecar returns Missing
            val before = readSidecar(projectRoot.absolutePath)
            assertTrue(before is ReadResult.Missing, "Expected Missing before any write")

            // appendVersion creates the sidecar
            val committed = appendVersion(
                projectRoot = projectRoot.absolutePath,
                projectId   = "p1",
                projectName = "test",
                input = AppendVersionInput(
                    path         = "foo.md",
                    kind         = "internal",
                    absolutePath = null,
                    sessionId    = "s1",
                    type         = "create",
                    author       = "agent",
                )
            )
            assertTrue(committed, "Expected appendVersion to commit")

            // readSidecar confirms artifact landed
            val after = readSidecar(projectRoot.absolutePath)
            assertTrue(after is ReadResult.Ok, "Expected Ok after appendVersion")
            val sidecar = (after as ReadResult.Ok).sidecar
            assertEquals(1, sidecar.artifacts.size, "Expected 1 artifact")
            assertEquals("foo.md", sidecar.artifacts[0].path)
            assertEquals("internal", sidecar.artifacts[0].kind)
            assertEquals("active", sidecar.artifacts[0].status)
            assertEquals(1, sidecar.artifacts[0].versions.size)
            assertEquals("create", sidecar.artifacts[0].versions[0].type)
            assertEquals("agent", sidecar.artifacts[0].versions[0].author)
            assertEquals("s1", sidecar.artifacts[0].versions[0].sessionId)
        } finally {
            projectRoot.deleteRecursively()
        }
    }

    @Test
    fun appendVersionAddsToExistingArtifact() {
        val projectRoot = Files.createTempDirectory("kt-as-").toFile()
        try {
            // First version — creates the artifact
            appendVersion(
                projectRoot = projectRoot.absolutePath,
                projectId   = "p2",
                projectName = "test",
                input = AppendVersionInput(
                    path = "bar.md", kind = "internal", absolutePath = null,
                    sessionId = "s1", type = "create", author = "agent",
                )
            )

            // Second version — should append to the same ArtifactRecord
            appendVersion(
                projectRoot = projectRoot.absolutePath,
                projectId   = "p2",
                projectName = "test",
                input = AppendVersionInput(
                    path = "bar.md", kind = "internal", absolutePath = null,
                    sessionId = "s2", type = "edit", author = "user",
                )
            )

            val sidecar = (readSidecar(projectRoot.absolutePath) as ReadResult.Ok).sidecar
            assertEquals(1, sidecar.artifacts.size, "Should still be 1 artifact")
            assertEquals(2, sidecar.artifacts[0].versions.size, "Should have 2 versions")
            assertEquals("edit", sidecar.artifacts[0].versions[1].type)
        } finally {
            projectRoot.deleteRecursively()
        }
    }

    @Test
    fun ulidHasCorrectFormat() {
        val id = generateUlid()
        assertEquals(26, id.length, "ULID must be 26 chars")
        assertTrue(id.all { it in "0123456789ABCDEFGHJKMNPQRSTVWXYZ" }, "ULID must use Crockford alphabet")
    }

    @Test
    fun centralIndexRoundTrip() {
        val claudeDir = Files.createTempDirectory("kt-ci-").toFile()
        try {
            // Empty index when file doesn't exist
            val empty = readIndex(claudeDir.absolutePath)
            assertEquals(0, empty.projects.size)

            val project = CentralIndexProject(
                id           = newProjectId(),
                name         = "My Project",
                path         = "/home/user/myproject",
                lastIndexed  = "2026-05-22T00:00:00.000Z",
                lastSession  = null,
                contentTypes = listOf("artifacts"),
                stats        = IndexStats(artifactCount = 3),
            )

            // upsert creates the entry
            upsertProject(claudeDir.absolutePath, project)
            val afterUpsert = listProjects(claudeDir.absolutePath)
            assertEquals(1, afterUpsert.size)
            assertEquals("My Project", afterUpsert[0].name)
            assertEquals(3, afterUpsert[0].stats.artifactCount)
            assertNull(afterUpsert[0].lastSession)

            // upsert again (update) replaces the entry
            val updated = project.copy(stats = IndexStats(artifactCount = 7))
            upsertProject(claudeDir.absolutePath, updated)
            val afterUpdate = listProjects(claudeDir.absolutePath)
            assertEquals(1, afterUpdate.size)
            assertEquals(7, afterUpdate[0].stats.artifactCount)

            // removeProject deletes the entry
            removeProject(claudeDir.absolutePath, project.id)
            val afterRemove = listProjects(claudeDir.absolutePath)
            assertEquals(0, afterRemove.size)
        } finally {
            claudeDir.deleteRecursively()
        }
    }

    // Mirror of desktop's "replay dedupe by (sessionId, toolUseId)" (2026-08-15):
    // re-opening a conversation replays every tool call through the tracker, so
    // the same tool call must not append twice, and the field must survive the
    // hand-written JSON round trip (org.json marshalling drops unknown fields).
    @Test
    fun appendVersionDedupesTheSameToolCallAndKeepsToolUseIdOnDisk() {
        val projectRoot = Files.createTempDirectory("kt-as-").toFile()
        try {
            fun input(session: String, toolUseId: String?) = AppendVersionInput(
                path = "docs/plan.md", kind = "internal", absolutePath = null,
                sessionId = session, type = "edit", author = "agent", toolUseId = toolUseId,
            )
            assertTrue(appendVersion(projectRoot.absolutePath, "p9", "test", input("s1", "toolu_A")))
            val bytesAfterFirst = java.io.File(projectRoot, ".youcoded/artifacts.json").readText()
            // Same tool call again: reports success, writes nothing.
            assertTrue(appendVersion(projectRoot.absolutePath, "p9", "test", input("s1", "toolu_A")))
            assertEquals(bytesAfterFirst, java.io.File(projectRoot, ".youcoded/artifacts.json").readText())
            // Different tool call, and same id in another session: both new versions.
            assertTrue(appendVersion(projectRoot.absolutePath, "p9", "test", input("s1", "toolu_B")))
            assertTrue(appendVersion(projectRoot.absolutePath, "p9", "test", input("s2", "toolu_A")))
            // No toolUseId: legacy always-append.
            assertTrue(appendVersion(projectRoot.absolutePath, "p9", "test", input("s1", null)))
            assertTrue(appendVersion(projectRoot.absolutePath, "p9", "test", input("s1", null)))

            val sidecar = (readSidecar(projectRoot.absolutePath) as ReadResult.Ok).sidecar
            assertEquals(1, sidecar.artifacts.size)
            assertEquals(5, sidecar.artifacts[0].versions.size)
            assertEquals("toolu_A", sidecar.artifacts[0].versions[0].toolUseId)
            assertNull(sidecar.artifacts[0].versions[4].toolUseId)
            // The optional field is omitted, not written as null, when absent.
            val raw = org.json.JSONObject(java.io.File(projectRoot, ".youcoded/artifacts.json").readText())
            val versions = raw.getJSONArray("artifacts").getJSONObject(0).getJSONArray("versions")
            assertTrue(versions.getJSONObject(0).has("toolUseId"))
            assertTrue(!versions.getJSONObject(4).has("toolUseId"))
        } finally {
            projectRoot.deleteRecursively()
        }
    }

    // Mirror of desktop's "a 'delivered' version does NOT bump lastModified on
    // an existing record" (artifact-store.test.ts). Delivery is not a
    // modification — handing over an old file must not jump it to the top of
    // "recently modified" on the phone, and the guard has to exist here too
    // since the renderer's artifact tracker reaches this Kotlin appendVersion
    // when it runs on Android (spec 2026-08-25 §4.2).
    @Test
    fun deliveredVersionDoesNotBumpLastModified() {
        val projectRoot = Files.createTempDirectory("kt-as-").toFile()
        try {
            appendVersion(
                projectRoot = projectRoot.absolutePath,
                projectId   = "p1",
                projectName = "test",
                input = AppendVersionInput(
                    path = "a.md", kind = "internal", absolutePath = null,
                    sessionId = "s", type = "edit", author = "agent",
                )
            )
            val before = (readSidecar(projectRoot.absolutePath) as ReadResult.Ok).sidecar
            val stamp = before.artifacts[0].lastModified
            Thread.sleep(5)
            appendVersion(
                projectRoot = projectRoot.absolutePath,
                projectId   = "p1",
                projectName = "test",
                input = AppendVersionInput(
                    path = "a.md", kind = "internal", absolutePath = null,
                    sessionId = "s2", type = "delivered", author = "agent", toolUseId = "toolu_d",
                )
            )
            val after = (readSidecar(projectRoot.absolutePath) as ReadResult.Ok).sidecar
            assertEquals(stamp, after.artifacts[0].lastModified)
            assertEquals("delivered", after.artifacts[0].versions.last().type)
        } finally {
            projectRoot.deleteRecursively()
        }
    }
}
