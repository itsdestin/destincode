// Kotlin port of desktop/src/main/artifacts/central-index.ts.
//
// Manages the global ~/.claude/youcoded-projects-index.json that tracks all
// known YouCoded projects. Operations: readIndex, upsertProject, removeProject,
// listProjects.
//
// CAS note: the TS implementation uses a best-effort casWrite (expectedUpdatedAt
// = null, no extractor) for v1 since index contention is rare. We mirror that
// here — no CAS guard, but still goes through the atomic tmp→rename path so
// partial writes don't corrupt the file.
package com.youcoded.app.artifacts

import org.json.JSONObject
import java.io.File

const val INDEX_FILE = "youcoded-projects-index.json"

private const val MAX_RETRIES = 5

/**
 * Read the central index from [claudeDir]. Returns an empty index if the file
 * does not exist (mirrors the TS ENOENT branch).
 */
fun readIndex(claudeDir: String): CentralIndex {
    val file = File(claudeDir, INDEX_FILE)
    if (!file.exists()) return CentralIndex()
    return try {
        val raw = file.readText(Charsets.UTF_8)
        JSONObject(raw).toCentralIndex()
    } catch (_: Exception) {
        // Corrupt or unreadable index — return empty rather than crash.
        // The next upsert will overwrite it atomically.
        CentralIndex()
    }
}

private fun writeIndex(claudeDir: String, index: CentralIndex) {
    // Best-effort write without CAS for v1 — index contention is rare.
    // null expectedUpdatedAt + null extractor → skip CAS, only atomic write.
    val path = File(claudeDir, INDEX_FILE).absolutePath
    val json = index.toJson().toString(2)
    casWrite(
        target            = path,
        expectedUpdatedAt = null,
        content           = json,
        extractUpdatedAt  = null,
    )
}

/**
 * Insert or replace the [project] entry in the index. Retries up to
 * MAX_RETRIES times on write failure (mirrors the TS retry loop).
 */
fun upsertProject(claudeDir: String, project: CentralIndexProject) {
    for (attempt in 0 until MAX_RETRIES) {
        val idx = readIndex(claudeDir)
        val i = idx.projects.indexOfFirst { it.id == project.id }
        if (i >= 0) idx.projects[i] = project
        else idx.projects.add(project)
        try {
            writeIndex(claudeDir, idx)
            return
        } catch (e: Exception) {
            if (attempt == MAX_RETRIES - 1) throw e
        }
    }
}

/**
 * Remove the project with [projectId] from the index.
 *
 * WHY this stays although no production Kotlin code calls it yet (ROADMAP L235,
 * re-justified 2026-09-01): this file is a 1:1 port of desktop's central-index.ts,
 * whose `removeProject` is LIVE — it backs the `artifacts:delete-project` IPC
 * channel (desktop ipc-handlers.ts). Android answers that same channel with a
 * `not-implemented-on-mobile` stub in SessionService.kt until mobile Project View
 * (v2) lands; when that stub is filled in, this is the function it calls. Pruning
 * it would force the v2 work to re-port it and would leave the Kotlin module
 * missing one of the four operations the header lists. `ArtifactStoreTest.kt`
 * pins its behaviour so the port cannot silently rot in the meantime.
 */
fun removeProject(claudeDir: String, projectId: String) {
    val idx = readIndex(claudeDir)
    idx.projects.removeAll { it.id == projectId }
    writeIndex(claudeDir, idx)
}

/**
 * Return all projects in the index.
 */
fun listProjects(claudeDir: String): List<CentralIndexProject> =
    readIndex(claudeDir).projects.toList()
