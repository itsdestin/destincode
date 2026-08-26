// Kotlin port of desktop/src/main/artifacts/project-manager.ts.
//
// Provides two project-level operations:
//   ensureProject      — look up or create a central-index entry for a project root
//   applyGitTreatment  — append .youcoded/ to .gitignore when inside a git repo
//
// All functions are top-level (package-level) to mirror the rest of this package's
// convention (ArtifactStore, CentralIndex, PathCanonicalize are all top-level fns).
package com.youcoded.app.artifacts

import java.io.File
import java.time.Instant

/**
 * Return value of [ensureProject].
 * [created] is true when a new central-index entry was written (either fresh or
 * auto-recovered from an existing sidecar), false when an existing entry was
 * updated in place.
 */
data class EnsureProjectResult(
    val project: CentralIndexProject,
    val created: Boolean,
)

/**
 * Look up a project by canonical root path in the central index.
 * - If a matching entry already exists, refresh [lastSession] + [lastIndexed] and return it.
 * - Otherwise check the .youcoded/artifacts.json sidecar for auto-recovery data (projectId, name).
 *   If the sidecar is absent, generate a fresh projectId and derive the name from the directory.
 * - Writes the entry to the central index in all cases before returning.
 *
 * Mirrors desktop/src/main/artifacts/project-manager.ts::ensureProject exactly.
 */
fun ensureProject(
    claudeDir:   String,
    projectRoot: String,
    sessionId:   String,
): EnsureProjectResult {
    val canonicalRoot = canonicalize(projectRoot, null)
    val now = Instant.now().toString()

    // Check central index first
    val existing = listProjects(claudeDir).find { it.path == canonicalRoot }
    if (existing != null) {
        val updated = existing.copy(lastSession = sessionId, lastIndexed = now)
        upsertProject(claudeDir, updated)
        return EnsureProjectResult(project = updated, created = false)
    }

    // Auto-recovery: read the sidecar to reuse its projectId + name if present
    val sidecar = readSidecar(projectRoot)
    val projectId: String
    val name: String
    if (sidecar is ReadResult.Ok) {
        projectId = sidecar.sidecar.projectId
        name      = sidecar.sidecar.name
    } else {
        projectId = newProjectId()
        name      = File(projectRoot).name
    }

    val project = CentralIndexProject(
        id           = projectId,
        name         = name,
        path         = canonicalRoot,
        lastIndexed  = now,
        lastSession  = sessionId,
        contentTypes = listOf("artifacts"),
        stats        = IndexStats(artifactCount = 0),
    )
    upsertProject(claudeDir, project)
    return EnsureProjectResult(project = project, created = true)
}

/**
 * Append `.youcoded/` to the project's .gitignore if:
 *   1. [projectRoot] is a git repo (has a .git entry at the root), AND
 *   2. the line is not already present.
 *
 * Uses an atomic temp-file + rename write to avoid partial writes.
 * Mirrors desktop/src/main/artifacts/project-manager.ts::applyGitTreatment exactly.
 */
fun applyGitTreatment(projectRoot: String) {
    // Only act when inside a git repository
    if (!File(projectRoot, ".git").exists()) return

    val gitignore = File(projectRoot, ".gitignore")
    val current = if (gitignore.exists()) gitignore.readText(Charsets.UTF_8) else ""

    // Idempotence: skip if the line already exists
    // Matches optional trailing slash + optional trailing whitespace at start of line
    if (Regex("""(?m)^\.youcoded/?[ \t]*$""").containsMatchIn(current)) return

    // Ensure there is a trailing newline before our entry
    val newline = if (current.isNotEmpty() && !current.endsWith("\n")) "\n" else ""
    val next = current + newline + ".youcoded/\n"

    // Atomic write: write to a temp file, then rename over the target
    val tmp = File(projectRoot, ".gitignore.tmp")
    tmp.writeText(next, Charsets.UTF_8)
    java.nio.file.Files.move(
        tmp.toPath(),
        gitignore.toPath(),
        java.nio.file.StandardCopyOption.REPLACE_EXISTING,
    )
}

/**
 * True when [p] is an absolute path we can safely hand to File().
 *
 * WHY: an external artifact's absolutePath is contractually absolute, but
 * records written before the 2026-08-12 resolveTrackedPath fix hold relative
 * strings ("flappy-bird/play.html"). File("flappy-bird/play.html") resolves
 * against the app PROCESS cwd ("/" on Android), so the file reads as missing
 * even though it sits in the project — the "no longer on disk" false positive.
 *
 * Android is always POSIX, so this is a bare leading-slash test. A synced
 * Windows record ("C:/Users/...") is not addressable here and is refused as an
 * orphan — the same result File("C:/Users/...").exists() already gives.
 *
 * Mirrors desktop/src/main/artifacts/write-authorization.ts::isAbsoluteRecorded
 * (which uses path.isAbsolute, platform-correct on both OSes).
 */
fun isAbsoluteRecorded(p: String): Boolean = p.startsWith("/")
