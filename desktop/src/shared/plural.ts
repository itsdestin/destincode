// Pluralise a count for user-facing copy (P-21 #3 — cards read "1 installs").
//   plural(1, "install")          → "1 install"
//   plural(2, "install")          → "2 installs"
//   plural(1204, "install")       → "1,204 installs"   (toLocaleString separators)
//   plural(3, "entry", "entries") → "3 entries"        (irregular plural)
export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? singular : pluralForm}`;
}
