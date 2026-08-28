package com.youcoded.app.skills

/**
 * Port of desktop's `desktop/src/shared/version-compare.ts` (`isNewerVersion`)
 * — keep the two in step. Returns true if `latest` is a greater dotted
 * version than `installed`. Falls back to strict string inequality for
 * non-numeric version strings (different string = treat as an update).
 */
object VersionCompare {
    fun isNewer(installed: String?, latest: String?): Boolean {
        if (installed.isNullOrBlank() || latest.isNullOrBlank()) return false
        // Strip one leading "v"/"V", same as the TS `replace(/^v/i, '')`.
        val a = installed.removePrefix("v").removePrefix("V").trim()
        val b = latest.removePrefix("v").removePrefix("V").trim()
        if (a == b) return false
        val pa = a.split('.', '-', '+').map { it.toIntOrNull() }
        val pb = b.split('.', '-', '+').map { it.toIntOrNull() }
        // Any non-numeric segment on either side → fall back to "different = update".
        if (pa.any { it == null } || pb.any { it == null }) return a != b
        for (i in 0 until maxOf(pa.size, pb.size)) {
            val ai = pa.getOrNull(i) ?: 0
            val bi = pb.getOrNull(i) ?: 0
            if (bi > ai) return true
            if (bi < ai) return false
        }
        return false
    }
}
