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
