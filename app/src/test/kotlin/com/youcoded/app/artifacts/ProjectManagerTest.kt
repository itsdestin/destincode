package com.youcoded.app.artifacts

import org.junit.Test
import java.io.File
import java.nio.file.Files
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class ProjectManagerTest {

    // ── ensureProject ──────────────────────────────────────────────────────────

    @Test
    fun ensureProjectCreatesNewEntryWhenIndexEmpty() {
        val claudeDir  = Files.createTempDirectory("pm-claude-").toFile()
        val projectDir = Files.createTempDirectory("pm-proj-").toFile()
        try {
            val result = ensureProject(claudeDir.absolutePath, projectDir.absolutePath, "sess-1")

            assertTrue(result.created, "Expected created=true for a brand-new project")
            assertEquals(projectDir.name, result.project.name,
                "Name should be derived from directory name when no sidecar exists")
            assertEquals(canonicalize(projectDir.absolutePath, null), result.project.path,
                "Path must be the canonical absolute path")
            assertEquals("sess-1", result.project.lastSession)
            assertEquals(listOf("artifacts"), result.project.contentTypes)
            assertEquals(0, result.project.stats.artifactCount)

            // Entry must be written to the central index
            val listed = listProjects(claudeDir.absolutePath)
            assertEquals(1, listed.size, "Central index should have exactly one entry")
            assertEquals(result.project.id, listed[0].id)
        } finally {
            claudeDir.deleteRecursively()
            projectDir.deleteRecursively()
        }
    }

    @Test
    fun ensureProjectReturnsExistingEntryWithUpdatedSession() {
        val claudeDir  = Files.createTempDirectory("pm-claude-").toFile()
        val projectDir = Files.createTempDirectory("pm-proj-").toFile()
        try {
            // First call creates the entry
            val first = ensureProject(claudeDir.absolutePath, projectDir.absolutePath, "sess-1")
            assertTrue(first.created, "First call should create the entry")

            // Second call with a different sessionId should return created=false and update the session
            val second = ensureProject(claudeDir.absolutePath, projectDir.absolutePath, "sess-2")
            assertFalse(second.created, "Second call should NOT be created=true")
            assertEquals(first.project.id, second.project.id,
                "Project ID must remain stable across calls")
            assertEquals("sess-2", second.project.lastSession,
                "lastSession must be updated to the most-recent session")

            // Central index should still have only one entry
            val listed = listProjects(claudeDir.absolutePath)
            assertEquals(1, listed.size, "Index should not accumulate duplicate entries")
        } finally {
            claudeDir.deleteRecursively()
            projectDir.deleteRecursively()
        }
    }

    @Test
    fun ensureProjectAutoRecoverFromExistingSidecar() {
        val claudeDir  = Files.createTempDirectory("pm-claude-").toFile()
        val projectDir = Files.createTempDirectory("pm-proj-").toFile()
        try {
            // Pre-populate a sidecar (simulates a project whose index entry was wiped)
            val knownProjectId = newProjectId()
            appendVersion(
                projectRoot = projectDir.absolutePath,
                projectId   = knownProjectId,
                projectName = "MyKnownProject",
                input = AppendVersionInput(
                    path         = "README.md",
                    kind         = "internal",
                    absolutePath = null,
                    sessionId    = "seed-sess",
                    type         = "create",
                    author       = "agent",
                )
            )

            // The index is still empty — ensureProject should recover from the sidecar
            val result = ensureProject(claudeDir.absolutePath, projectDir.absolutePath, "recovery-sess")
            assertTrue(result.created, "created=true because the index entry didn't exist yet")
            assertEquals(knownProjectId, result.project.id,
                "Project ID must be recovered from the sidecar, not freshly generated")
            assertEquals("MyKnownProject", result.project.name,
                "Name must be recovered from the sidecar")
        } finally {
            claudeDir.deleteRecursively()
            projectDir.deleteRecursively()
        }
    }

    // ── applyGitTreatment ─────────────────────────────────────────────────────

    @Test
    fun applyGitTreatmentAppendsLineToGitignore() {
        val projectDir = Files.createTempDirectory("pm-git-").toFile()
        try {
            // Create a fake .git directory so the function treats this as a git repo
            File(projectDir, ".git").mkdir()

            // No existing .gitignore
            applyGitTreatment(projectDir.absolutePath)

            val content = File(projectDir, ".gitignore").readText()
            assertTrue(content.contains(".youcoded/"),
                "Expected .youcoded/ in .gitignore after applyGitTreatment")
        } finally {
            projectDir.deleteRecursively()
        }
    }

    @Test
    fun applyGitTreatmentIsIdempotent() {
        val projectDir = Files.createTempDirectory("pm-git-").toFile()
        try {
            File(projectDir, ".git").mkdir()

            // Apply twice — file should not grow
            applyGitTreatment(projectDir.absolutePath)
            val afterFirst = File(projectDir, ".gitignore").readText()

            applyGitTreatment(projectDir.absolutePath)
            val afterSecond = File(projectDir, ".gitignore").readText()

            assertEquals(afterFirst, afterSecond,
                "Second applyGitTreatment call must not modify the .gitignore")

            // Count occurrences — must be exactly one
            val occurrences = Regex("""\.youcoded/""").findAll(afterSecond).count()
            assertEquals(1, occurrences, "Expected exactly one .youcoded/ line")
        } finally {
            projectDir.deleteRecursively()
        }
    }

    @Test
    fun applyGitTreatmentNoOpWhenNotGitRepo() {
        val projectDir = Files.createTempDirectory("pm-nogit-").toFile()
        try {
            // No .git directory — nothing should happen
            applyGitTreatment(projectDir.absolutePath)
            assertFalse(File(projectDir, ".gitignore").exists(),
                ".gitignore must not be created when the directory is not a git repo")
        } finally {
            projectDir.deleteRecursively()
        }
    }

    // ── detectOrphan ──────────────────────────────────────────────────────────

    @Test
    fun detectOrphanReturnsFalseForExistingInternalFile() {
        val projectDir = Files.createTempDirectory("pm-orp-").toFile()
        try {
            val file = File(projectDir, "exists.txt")
            file.writeText("hello")
            val orphan = detectOrphan(projectDir.absolutePath, "exists.txt", "internal", null)
            assertFalse(orphan, "A file that exists on disk should NOT be an orphan")
        } finally {
            projectDir.deleteRecursively()
        }
    }

    @Test
    fun detectOrphanReturnsTrueForMissingInternalFile() {
        val projectDir = Files.createTempDirectory("pm-orp-").toFile()
        try {
            val orphan = detectOrphan(projectDir.absolutePath, "missing.txt", "internal", null)
            assertTrue(orphan, "A file that does not exist on disk should be an orphan")
        } finally {
            projectDir.deleteRecursively()
        }
    }

    // ── rebuildIndex ──────────────────────────────────────────────────────────

    @Test
    fun rebuildIndexDropsProjectsWithMissingSidecar() {
        val claudeDir   = Files.createTempDirectory("pm-claude-").toFile()
        val goodProject = Files.createTempDirectory("pm-good-").toFile()
        val deadProject = Files.createTempDirectory("pm-dead-").toFile()
        try {
            // Seed both projects into the index
            ensureProject(claudeDir.absolutePath, goodProject.absolutePath, "sess-good")
            ensureProject(claudeDir.absolutePath, deadProject.absolutePath, "sess-dead")

            // Give goodProject a real sidecar; deadProject gets no sidecar
            appendVersion(
                projectRoot = goodProject.absolutePath,
                projectId   = "good-id",
                projectName = "Good",
                input = AppendVersionInput(
                    path = "a.md", kind = "internal", absolutePath = null,
                    sessionId = "sess-good", type = "create", author = "agent",
                )
            )

            rebuildIndex(claudeDir.absolutePath)

            val remaining = listProjects(claudeDir.absolutePath)
            assertEquals(1, remaining.size,
                "Dead project (no sidecar) must be removed by rebuildIndex")
            assertEquals(canonicalize(goodProject.absolutePath, null), remaining[0].path)
        } finally {
            claudeDir.deleteRecursively()
            goodProject.deleteRecursively()
            deadProject.deleteRecursively()
        }
    }
}
