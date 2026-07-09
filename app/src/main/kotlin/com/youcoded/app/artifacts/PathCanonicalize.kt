package com.youcoded.app.artifacts

import java.text.Normalizer

/**
 * Kotlin port of desktop/src/shared/artifacts/canonicalize.ts.
 *
 * Rules (per spec § Path canonicalization):
 *   1. Normalize separators to forward slash
 *   2. Lowercase Windows drive letter
 *   3. Strip \\?\ prefix
 *   4. Resolve . and ..
 *   5. Internal paths → relative POSIX-style (when projectRoot provided)
 *   6. External paths → absolute canonical
 *   7. Strip trailing slashes (preserve drive root like c:/)
 *   8. Unicode NFC normalization
 *
 * Known v1 limitation: bare "/" input returns ".". Not a problem in practice
 * because artifact paths are always files (nested), never bare roots.
 */
fun canonicalize(rawPath: String, projectRoot: String?): String {
    if (rawPath.isEmpty()) return rawPath

    // 3. Strip \\?\ prefix
    var p = if (rawPath.startsWith("\\\\?\\")) rawPath.substring(4) else rawPath

    // 1. Normalize separators
    p = p.replace('\\', '/')

    // 2. Lowercase drive letter — match only uppercase A-Z (same as TS regex /^([A-Z]):/)
    p = if (p.length >= 2 && p[0] in 'A'..'Z' && p[1] == ':') {
        p[0].lowercaseChar() + p.substring(1)
    } else p

    // 8. NFC normalize
    p = Normalizer.normalize(p, Normalizer.Form.NFC)

    // 7. Strip trailing slashes (but keep root '/' or 'c:/')
    if (p.length > 1 && !p.endsWith(":/")) {
        p = p.trimEnd('/')
    }

    // 5. If projectRoot provided, strip prefix to produce a relative POSIX path
    if (projectRoot != null) {
        val root = canonicalize(projectRoot, null) // canonicalize root absolute
        if (p.startsWith("$root/")) {
            p = p.substring(root.length + 1)
        }
        // 4. Resolve . and ..
        p = resolveDots(p)
        return p
    }

    // 4. Resolve . and ..
    return resolveDots(p)
}

/**
 * Mirrors the TS resolveDots function exactly, including the absolute-path
 * handling that pushes "" to preserve the leading "/" when joined.
 */
private fun resolveDots(p: String): String {
    val parts = p.split('/')
    val result = mutableListOf<String>()
    val isAbsolute = p.startsWith('/')

    for (part in parts) {
        if (part == "." || part.isEmpty()) {
            // Preserve leading / (empty part at start means absolute path)
            if (isAbsolute && result.isEmpty()) {
                result.add("") // This will create a leading / when joined
            }
            continue
        }
        if (part == "..") {
            if (result.isNotEmpty() && result.last() != ".." && result.last() != "") {
                result.removeAt(result.size - 1)
            } else if (!isAbsolute) {
                result.add("..")
            }
            continue
        }
        result.add(part)
    }
    return result.joinToString("/").ifEmpty { "." }
}
