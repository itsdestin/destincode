// Verify projectSlug() against observed slugs in ~/.claude/projects/
const cases = [
  ['C:\\Users\\desti', 'C--Users-desti'],
  ['C:\\Users\\desti\\AppData\\Local\\Temp', 'C--Users-desti-AppData-Local-Temp'],
  ['C:\\Users\\desti\\youcoded-dev', 'C--Users-desti-youcoded-dev'],
];
const projectSlug = (cwd) => cwd.replace(/[\\/:]/g, '-');
for (const [input, expected] of cases) {
  const got = projectSlug(input);
  const ok = got === expected;
  console.log(`${ok ? 'OK' : 'FAIL'}  ${JSON.stringify(input)} -> ${JSON.stringify(got)} (expected ${JSON.stringify(expected)})`);
}
