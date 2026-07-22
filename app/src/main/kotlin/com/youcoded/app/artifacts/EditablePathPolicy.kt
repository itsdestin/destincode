package com.youcoded.app.artifacts

/**
 * Kotlin port of desktop/src/shared/artifacts/editable-path-policy.ts — the
 * D5 security boundary for artifact writes (2026-07-22).
 *
 * Android implements artifacts:save FOR REAL (SessionService.kt), so this
 * policy must be enforced here too or the identical React UI would call an
 * unguarded Kotlin write path. Pinned to the TS implementation by the shared
 * fixture artifacts/editable-path-policy-cases.json (EditablePathPolicyTest).
 *
 * Callers pass a CANONICAL path (canonicalize(p, null)) of the RESOLVED
 * target — File.canonicalFile first — so symlinks cannot dodge a segment match.
 */
object EditablePathPolicy {

    enum class EditTier { FREE, NEEDS_CONFIRM, DENIED }

    /** Segments refused for reads AND writes anywhere in the path. */
    private val SENSITIVE_SEGMENTS = setOf(".ssh", ".gnupg", ".aws", ".azure", ".kube")

    /** Basenames refused outright (credential stores). */
    private val SENSITIVE_BASENAMES = setOf(".netrc", "_netrc", ".credentials.json")

    /** .config/gh holds the GitHub OAuth token (hosts.yml). */
    private val SENSITIVE_SUBPATHS = listOf("/.config/gh/")

    /** Never editable: escalation vectors with no in-pane editing story.
     * Matches a `.git` FILE too (worktrees) — a basename is just a segment. */
    private val DENIED_SEGMENTS = setOf(".git", ".youcoded")

    /** Editable behind an explicit confirm (settings/hooks run commands). */
    private val CONFIRM_SEGMENTS = setOf(".claude")

    /** .env / .env.<suffix> / .envrc — NOT unrelated names like .environment. */
    fun isDotenvBasename(base: String): Boolean =
        base == ".env" || base == ".envrc" || base.startsWith(".env.")

    /** Per-path write policy. Precedence: DENIED > NEEDS_CONFIRM > FREE. */
    fun editTier(canonicalPath: String): EditTier {
        val parts = canonicalPath.split('/')
        val base = parts.lastOrNull() ?: ""
        if (parts.any { it in DENIED_SEGMENTS }) return EditTier.DENIED
        if (parts.any { it in SENSITIVE_SEGMENTS }) return EditTier.DENIED
        if (base in SENSITIVE_BASENAMES) return EditTier.DENIED
        if (SENSITIVE_SUBPATHS.any { canonicalPath.contains(it) }) return EditTier.DENIED
        if (parts.any { it in CONFIRM_SEGMENTS }) return EditTier.NEEDS_CONFIRM
        if (isDotenvBasename(base)) return EditTier.NEEDS_CONFIRM
        return EditTier.FREE
    }

    /** Paths artifacts:get refuses to READ: the sensitive set MINUS dotenv
     * (.env stays viewable because it is confirm-tier editable — D5). */
    fun protectedReadPath(canonicalPath: String): Boolean {
        val parts = canonicalPath.split('/')
        val base = parts.lastOrNull() ?: ""
        if (parts.any { it in SENSITIVE_SEGMENTS }) return true
        if (base in SENSITIVE_BASENAMES) return true
        return SENSITIVE_SUBPATHS.any { canonicalPath.contains(it) }
    }

    /** Full sensitive check INCLUDING dotenv — the read-binary deny-list
     * (port of the desktop isSensitivePath; Kotlin read-binary previously had
     * NO guard at all — pre-existing gap closed 2026-07-22). */
    fun isSensitivePath(canonicalPath: String): Boolean {
        val base = canonicalPath.split('/').lastOrNull() ?: ""
        return protectedReadPath(canonicalPath) || isDotenvBasename(base)
    }

    /** Files above this are not served inline by artifacts:get (tooLarge). */
    const val EDIT_MAX_BYTES: Long = 2L * 1024 * 1024

    /** git-style sniff: NUL byte in the head slice means not-text. */
    fun looksBinary(head: ByteArray): Boolean {
        val n = minOf(head.size, 8192)
        for (i in 0 until n) if (head[i] == 0.toByte()) return true
        return false
    }
}
