// Lives in shared/ because the renderer's deny-list copy module
// (components/permissions/deny-list-copy.ts) must classify with the SAME
// matcher the engine decided with — two matchers would eventually disagree.
// Tiny glob for permission SUBJECTS (bash command strings, relative paths).
// Homegrown on purpose: no new dep, and `*` must cross path separators here
// ("git push*" must match "git push origin x") — unlike file globbing.
// `*` also matches the empty string, so a bare "git push" matches "git push*".
export function subjectMatches(subject: string, pattern?: string): boolean {
  if (pattern === undefined) return true;
  const rx = new RegExp(
    '^' + pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex chars EXCEPT * and ?
      .replace(/\*/g, '[\\s\\S]*')
      .replace(/\?/g, '.') + '$',
    'i',
  );
  return rx.test(subject);
}
