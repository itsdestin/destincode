/**
 * Single source of truth for the "YouCoded <version>" line in Settings → About
 * (the row subtitle and the popup header, on both desktop and Android).
 *
 * WHY a channel: test builds are installed over a real install and share its
 * appId, so nothing else on screen distinguishes a dogfood build from a shipped
 * one. `desktop-test-build.yml` stamps YOUCODED_BUILD_CHANNEL=BETA, which Vite
 * bakes in as __BUILD_CHANNEL__, and the line becomes `YouCoded v1.3.0-beta
 * (BETA)`. Release builds set no channel and render exactly as they did before:
 * `YouCoded 1.2.4` on desktop, `YouCoded 1.2.1 · 17` on Android (where `build`
 * is the versionCode — that's why the channel is a separate field and not
 * folded into `build`).
 */
export function formatVersionLine(opts: {
  version: string;
  build?: string;
  channel?: string;
}): string {
  const { version, build, channel } = opts;
  if (channel) return `YouCoded v${version} (${channel})`;
  return `YouCoded ${version}${build ? ` · ${build}` : ''}`;
}
