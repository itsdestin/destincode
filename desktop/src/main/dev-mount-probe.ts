/**
 * The renderer-side expression `wireDevLoadRecovery`'s blank-mount watchdog
 * evaluates (via `webContents.executeJavaScript`) to decide whether React
 * actually committed. See `main.ts` → `wireDevLoadRecovery`.
 *
 * It lives in its own module purely so `tests/dev-load-recovery.test.tsx` can
 * run it against the REAL `src/renderer/index.html` — importing `main.ts` from a
 * test is not viable (module-scope Electron side effects), and this probe is
 * exactly the kind of claim that rots silently: a wrong answer produces NO
 * error, it just disables the only recovery path that covers the failure.
 */
/**
 * "React committed" == "the pre-React boot skeleton is gone".
 *
 * NOT `#root.childElementCount` — that is wrong in BOTH directions, which is
 * why the watchdog silently stopped working (see the test's header comment):
 *  - index.html paints `#boot` INSIDE `#root`, so an un-mounted document has a
 *    child and reads as mounted;
 *  - React's first commit CLEARS the container (`clearContainer` runs whatever
 *    the tree renders — verified in the test against real react-dom), so a
 *    window that legitimately committed an empty tree — a buddy window on
 *    `?mode=buddy-*`, wired through this same recovery path — has zero children
 *    and would read as stranded, earning a reload every ~13s forever.
 *
 * `#root` is still required so a document that never loaded index.html at all
 * fails the probe (retrying is the safe direction) rather than passing it by
 * virtue of having no `#boot` either.
 */
export const MOUNT_PROBE_JS =
  '(() => !!document.getElementById("root") && !document.getElementById("boot"))()';
