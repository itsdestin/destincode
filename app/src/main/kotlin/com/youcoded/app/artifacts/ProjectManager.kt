// Kotlin port of desktop/src/main/artifacts/project-manager.ts.
//
// Provides four project-level operations:
//   ensureProject      — look up or create a central-index entry for a project root
//   applyGitTreatment  — append .youcoded/ to .gitignore when inside a git repo
//   detectOrphan       — check whether a tracked artifact file has gone missing
//   rebuildIndex       — walk known projects, refresh stats, drop any whose sidecar is gone
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
 * Return true if the file backing [path] / [absolutePath] no longer exists on disk.
 *
 * [kind] determines which path to check:
 *   "internal" → [projectRoot] + [path] (relative)
 *   "external" → [absolutePath] (must be non-null)
 *
 * Mirrors desktop/src/main/artifacts/project-manager.ts::detectOrphan exactly.
 */
fun detectOrphan(
    projectRoot:  String,
    path:         String,
    kind:         String,
    absolutePath: String?,
): Boolean {
    val fullPath = if (kind == "internal") {
        File(projectRoot, path)
    } else {
        File(requireNotNull(absolutePath) { "absolutePath required for external artifact" })
    }
    return !fullPath.exists()
}

/**
 * Walk all projects in the central index and:
 *   - For each project whose sidecar still exists: refresh [IndexStats.artifactCount] + [lastIndexed].
 *   - For each project whose sidecar is gone: remove it from the index.
 *
 * Mirrors desktop/src/main/artifacts/project-manager.ts::rebuildIndex exactly.
 */
fun rebuildIndex(claudeDir: String) {
    val original = listProjects(claudeDir)
    val survivingIds = mutableSetOf<String>()

    for (p in original) {
        val sidecar = readSidecar(p.path)
        if (sidecar is ReadResult.Ok) {
            val refreshed = p.copy(
                stats       = IndexStats(artifactCount = sidecar.sidecar.artifacts.size),
                lastIndexed = Instant.now().toString(),
            )
            upsertProject(claudeDir, refreshed)
            survivingIds.add(p.id)
        }
    }

    // Remove projects that no longer have a sidecar
    for (p in original) {
        if (p.id !in survivingIds) {
            removeProject(claudeDir, p.id)
        }
    }
}
