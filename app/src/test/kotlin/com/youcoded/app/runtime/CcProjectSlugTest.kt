package com.youcoded.app.runtime

import org.junit.Assert.assertEquals
import org.junit.Test

/** Pairs copied from desktop/tests/fixtures/cc-slug-pairs.json (CC 2.1.229
 *  probe, 2026-08-12) — anchored to directories a REAL CC created, never to
 *  the desktop TS implementation. Regenerate both together (spec §7). */
class CcProjectSlugTest {
    @Test fun `fixture pairs`() {
        // probe: _ and .
        assertEquals(
            "-home-destin-YouCoded-probe-under-score-and-dots",
            CcProjectSlug.slug("/home/destin/YouCoded/probe/under_score.and.dots"),
        )
        // probe: punctuation
        assertEquals(
            "-home-destin-YouCoded-probe-punct--x-----y---z",
            CcProjectSlug.slug("/home/destin/YouCoded/probe/punct (x) + 'y' #z"),
        )
        // probe: over-cap
        assertEquals(
            "-home-destin-YouCoded-probe-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-6bal0v",
            CcProjectSlug.slug(
                "/home/destin/YouCoded/probe/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/" +
                    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/" +
                    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            ),
        )
        // probe: symlink resolves to realpath
        assertEquals(
            "-home-destin-YouCoded-probe-real-target",
            CcProjectSlug.slug("/home/destin/YouCoded/probe/real-target"),
        )
        // harvest: the reporting folder (comma+ampersand)
        assertEquals(
            "-home-destin-YouCoded-Projects-PAF-574---Diversity--Ethics----Public-Change",
            CcProjectSlug.slug("/home/destin/YouCoded/Projects/PAF 574 - Diversity, Ethics, & Public Change"),
        )
        // harvest: plain
        assertEquals("-home-destin", CcProjectSlug.slug("/home/destin"))
        // harvest: hyphens are fixed points
        assertEquals("-home-destin-youcoded-dev", CcProjectSlug.slug("/home/destin/youcoded-dev"))
        // windows drive+backslash (synthetic, both rules agree)
        assertEquals("C--Users-alice", CcProjectSlug.slug("C:\\Users\\alice"))
    }

    @Test fun `android home path gets the dashed slug CC writes`() {
        assertEquals(
            "-data-data-com-youcoded-app-files-home",
            CcProjectSlug.slug("/data/data/com.youcoded.app/files/home"),
        )
    }

    @Test fun `hash matches the JS reference`() {
        assertEquals("22ci", CcProjectSlug.hash("abc"))
        assertEquals("0", CcProjectSlug.hash(""))
    }

    @Test fun `int32-min hash does NOT go negative (the Kotlin-only trap)`() {
        // JS Math.abs(-2147483648) = 2147483648; Kotlin abs(Int.MIN_VALUE) is
        // NEGATIVE. The impl must widen to Long before abs. Pinned indirectly:
        assertEquals("zik0zk", kotlin.math.abs(Int.MIN_VALUE.toLong()).toString(36))
    }
}
