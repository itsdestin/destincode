package com.youcoded.app.config

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

// WHY: description mirrors desktop's per-project description (Task 3/4) so a plain
// local folder can carry the same optional summary on Android; null means "no description
// set" and is distinct from an empty string.
data class WorkingDir(val label: String, val path: String, val description: String? = null)

class WorkingDirStore(private val homeDir: File) {
    private val file = File(homeDir, ".claude-mobile/working-dirs.json")
    private val _dirs = MutableStateFlow<List<WorkingDir>>(emptyList())
    val dirs: StateFlow<List<WorkingDir>> = _dirs

    init { reload() }

    fun reload() {
        _dirs.value = readFromDisk()
    }

    fun add(dir: WorkingDir) {
        val current = _dirs.value.toMutableList()
        if (current.any { it.path == dir.path }) return // duplicate
        current.add(dir)
        _dirs.value = current
        writeToDisk(current)
    }

    fun remove(path: String) {
        val current = _dirs.value.toMutableList()
        current.removeAll { it.path == path }
        _dirs.value = current
        writeToDisk(current)
    }

    fun rename(path: String, newLabel: String) {
        val current = _dirs.value.toMutableList()
        val idx = current.indexOfFirst { it.path == path }
        if (idx >= 0) {
            current[idx] = current[idx].copy(label = newLabel)
            _dirs.value = current
            writeToDisk(current)
        }
    }

    fun setDescription(path: String, description: String?) {
        val current = _dirs.value.toMutableList()
        val idx = current.indexOfFirst { it.path == path }
        if (idx >= 0) {
            // WHY: Trim + cap to 200 chars to match desktop's PROJECT_DESCRIPTION_MAX
            // (desktop/src/shared/artifacts/types.ts) — the two stores must not disagree
            // about what a valid description is. Kotlin can't import the TS constant, so
            // the value is re-typed here as a literal; keep it in sync if that changes.
            val next = description?.trim()?.take(200)?.ifEmpty { null }
            current[idx] = current[idx].copy(description = next)
            _dirs.value = current
            writeToDisk(current)
        }
    }

    private fun readFromDisk(): List<WorkingDir> {
        if (!file.exists()) return emptyList()
        return try {
            val arr = JSONArray(file.readText())
            (0 until arr.length()).mapNotNull { i ->
                val obj = arr.optJSONObject(i) ?: return@mapNotNull null
                val label = obj.optString("label", "")
                val path = obj.optString("path", "")
                // WHY: optString defaults to "" for a missing key, so a working-dirs.json
                // written by an older build (no "description" field) must load as null,
                // not empty string — ifBlank collapses both "" and missing to null.
                val description = obj.optString("description", "").ifBlank { null }
                if (label.isNotBlank() && path.isNotBlank()) WorkingDir(label, path, description) else null
            }
        } catch (_: Exception) {
            android.util.Log.w("WorkingDirStore", "Invalid JSON in working dirs file, treating as empty")
            emptyList()
        }
    }

    private fun writeToDisk(dirs: List<WorkingDir>) {
        file.parentFile?.mkdirs()
        val arr = JSONArray()
        for (wd in dirs) {
            val obj = JSONObject()
            obj.put("label", wd.label)
            obj.put("path", wd.path)
            // WHY: org.json's put(String, Object) removes the key entirely when the
            // value is null, so a folder with no description writes no "description"
            // field at all (rather than a literal JSON null) — keeps old-format files
            // round-trippable.
            obj.put("description", wd.description)
            arr.put(obj)
        }
        file.writeText(arr.toString(2))
    }
}
