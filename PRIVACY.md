# YouCoded Privacy Policy

**Effective date:** September 3, 2026

YouCoded is made and published by **Destin's Adventures, LLC**, an Arizona limited liability company. It is not affiliated with Anthropic or any other commercial entity. This policy explains in plain language what data the YouCoded software touches, what gets sent to servers operated by the project, and what doesn't.

If anything here conflicts with what the app actually does, **the app is wrong and should be fixed.** Please report mismatches to support@youcoded.ai.

---

## 1. The short version

- **Your conversations with Claude Code never reach YouCoded servers.** They go directly between your device and Anthropic, using your own Claude Pro/Max sign-in.
- **Your sign-in tokens never reach YouCoded servers.** They sit in local files on your device managed by Claude Code.
- **Your personal files, journal entries, encyclopedia notes, and any other user data created in the app stay on your device.** YouCoded ships several plugins (journaling, encyclopedia, task inbox, text-message tools, etc.) that operate entirely locally — they read and write files in your own home directory and don't transmit any of that data to YouCoded servers.
- **Backup and sync use *your* accounts.** YouCoded supports backing up local state to Google Drive, GitHub, or iCloud — those are your accounts; YouCoded servers are never the destination.
- **There are three narrow data flows that DO touch YouCoded-operated servers:** anonymous usage analytics (opt-out at any time), marketplace plugin discovery (anonymous reads, optional GitHub sign-in for ratings), and multiplayer games (only while a game lobby is open). Each is described in detail below.

---

## 2. What YouCoded does NOT collect

To make the boundaries explicit, YouCoded servers do **not** receive:

- The contents of any conversation between you and Claude.
- Your Claude Pro/Max sign-in token, OAuth tokens for any other service, API keys, or passwords.
- Files on your device, the contents of your projects, or the contents of any Claude Code transcript file.
- Your name, email, real address, or other personal identifiers — except where you voluntarily sign in with GitHub for the marketplace (Section 3.2 below) or contact us by email.
- Anything you type into the chat box, the terminal, the journaling plugin, the encyclopedia, or any other in-app surface.
- Plugin or theme usage telemetry — we do not record which skills you run, which themes you switch to, or how often you open the app.

If you discover a code path that contradicts any of the above, treat it as a privacy bug and report it.

---

## 3. What YouCoded DOES collect, when, and why

### 3.1 Anonymous usage analytics (opt-out)

**What it is:** A daily heartbeat ping from each device that has the app open at least once that day, telling YouCoded *which version* of the app is in active use *on roughly how many devices* in *which countries and regions*. That's the entire purpose. It is a daily-attendance counter — there are no session counts, no message counts, no plugin usage events, no in-app behavior tracking.

**What we send:**

- An **irreversible hash of your device's hardware ID.** YouCoded reads a hardware identifier from your device (Windows MachineGuid, macOS IOPlatformUUID, Linux `/etc/machine-id`, or Android `Settings.Secure.ANDROID_ID`), combines it with a secret salt baked into the app source, and runs HMAC-SHA256 over the result. **The raw hardware ID never leaves your device.** Only the 64-character hex hash is transmitted. The hash cannot be reversed back into the original ID.
- The installed app version (e.g. `1.3.0`).
- The platform (`desktop` or `android`).
- On desktop, the OS family (`win`, `mac`, or `linux`). Android omits this.

**What our server adds (server-side, from your IP at request time):**

- Your country (from Cloudflare's `CF-IPCountry` header).
- Your approximate region (US state, Canadian province, etc., from `CF-IPRegionCode` — ISO 3166-2).

**Your IP address itself is read once per request and immediately discarded.** It is not stored, logged, or associated with the heartbeat in our analytics database.

**Where it goes:** Cloudflare Analytics Engine, a Cloudflare-hosted columnar analytics store. **Retention is 90 days** (Cloudflare's free-tier default — older rows age out automatically). Aggregated counts pulled from this data are used internally to understand active-user counts, version adoption, and rough geographic distribution; aggregates are not sold or shared with third parties.

**Why we collect it:** With fewer than a hundred users at the time of writing, knowing whether anyone is actually using the app — and which versions they're on — is the difference between maintaining the project well and flying blind. The anonymous-by-construction design is a deliberate floor: we wanted a usable signal without ever getting access to identifiable per-user behavior.

**Your control:** This is **opt-out at any time**, with no penalty or feature loss, in **Settings → About → Privacy** in the app. When opt-out is set to off, no analytics events fire and no hash is computed.

**What we cannot do:** Because the data is keyed by an irreversible hash and your IP is never stored, we cannot identify which row in the analytics database is yours. As a result, we **cannot delete an individual user's analytics history on request** — we genuinely don't know which row is yours. The mitigations are (a) the 90-day automatic retention limit and (b) the opt-out toggle.

### 3.2 Marketplace plugin discovery and ratings

**Anonymous use (default):** Browsing the marketplace, viewing plugin metadata, and downloading plugins make HTTP requests to a Cloudflare Worker backend and to `raw.githubusercontent.com`. Those requests do not require sign-in; they are subject to standard server logs (IP address, user agent, requested URL) for routing and abuse-prevention purposes only. The marketplace Worker does record install **counts** (incremented on each install) — those counts are aggregate numbers, not tied to a user identifier.

**Signed-in use (optional):** If you choose to **rate** a plugin or **submit** a plugin to the marketplace, you sign in with **GitHub OAuth**. In that case YouCoded's marketplace Worker records:

- Your GitHub user ID and login name (so ratings persist across sessions and submissions can be attributed).
- Your rating value(s) and the plugins they apply to.
- (For plugin submitters) The pull request you opened to the marketplace registry repository.

This data is stored in a Cloudflare D1 database. **You can delete this data on request** by emailing support@youcoded.ai from the GitHub address associated with the account (or otherwise demonstrating ownership), and YouCoded will remove your ratings and any associated metadata within 30 days.

### 3.3 Multiplayer games

YouCoded includes a multiplayer game system (currently Connect 4) backed by PartyKit (running on Cloudflare Durable Objects). When you are **in an active game lobby or game**:

- Your GitHub login name (used as your in-game username) is shared with the room.
- Your moves and any in-game chat are relayed through the room to the other player(s) in real time.

When you leave the lobby or the game ends, the room shuts down and game state is discarded. **No game traffic is retained server-side beyond the active room.** No game data is written to long-term storage.

### 3.4 Announcements

Once an hour while the app is running, YouCoded fetches a small text file (`announcements.txt`) from the YouCoded GitHub repo via `raw.githubusercontent.com` to display any pending in-app announcement. The fetch is anonymous from a YouCoded perspective — we do not see who fetched it. GitHub may log the request as it does any public CDN request.

### 3.5 Theme registry and bundled plugins

Theme metadata and the bundled-plugin manifest are also fetched from public GitHub URLs (`raw.githubusercontent.com`). These fetches are anonymous from YouCoded's perspective and are subject to GitHub's own logging.

### 3.6 Remote access (optional, off by default)

The app can serve its UI to a web browser over your local network or via Tailscale. This is **off by default**. When enabled, traffic flows directly between your device and the browser you connect from — **none of it touches YouCoded-operated servers.** The connection is **not TLS-encrypted** at the YouCoded layer; we strongly recommend Tailscale (which encrypts end-to-end with WireGuard) for sensitive sessions.

---

## 4. Third parties

YouCoded relies on the following third-party services. Each has its own privacy policy that governs what they do with the data described above:

- **Cloudflare** — hosts the marketplace Worker, the Analytics Engine analytics store, the D1 database, and the PartyKit multiplayer rooms. Cloudflare receives the network requests that carry the data described in Section 3, including your IP address (which Cloudflare's edge network uses to serve content and to derive country/region for our analytics). See [Cloudflare's privacy policy](https://www.cloudflare.com/privacypolicy/).
- **GitHub** — hosts the YouCoded source code, the marketplace registry, the theme registry, and the OAuth flow used for marketplace ratings/submissions. GitHub receives the network requests that carry the data described in Section 3.2 and 3.5. See [GitHub's privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).
- **Anthropic** — operates the Claude Code servers your conversations go to. Anthropic does not receive anything from YouCoded; it receives content directly from your local Claude Code CLI under your own Pro/Max sign-in. See [Anthropic's privacy policy](https://www.anthropic.com/privacy).
- **Termux package mirrors (Android only)** — during initial setup, the Android app downloads runtime packages over HTTPS (with SHA256 verification) from `packages.termux.dev`. See [Termux's project pages](https://termux.dev/) for their policies.

Beyond the above, YouCoded does not share your data with any third parties. We do not sell data, we do not run ads, we do not have any commercial partners.

---

## 5. Your rights and choices

- **Opt out of analytics** at any time in **Settings → About → Privacy**. This stops all heartbeat pings immediately.
- **Delete marketplace ratings and OAuth data** by emailing support@youcoded.ai from your GitHub-associated email; we'll remove the data within 30 days.
- **Stop using YouCoded** at any time. Uninstalling the app stops all data flows; existing analytics rows continue to age out under the 90-day retention window described in Section 3.1.
- **Right to access** — for the data described in Section 3.2, we will provide a copy of what we have on file on request.
- **Children** — YouCoded is not directed at children under 13 and we do not knowingly collect data from them. If you believe a child has used the app, contact us and we'll work with you to handle it.
- **International users** — YouCoded's servers are hosted on Cloudflare's edge network. By using the app you agree that your data may be processed by Cloudflare and GitHub in jurisdictions outside your home country.

If you are in the EU, UK, California, or another jurisdiction with a comprehensive privacy law (GDPR, UK GDPR, CCPA/CPRA, etc.), the rights described here are intended to satisfy the spirit of those laws. If you believe more is owed, please contact us — YouCoded is a small project and we are not equipped for adversarial regulatory disputes, but we will respond in good faith.

---

## 6. Security

We do our best to handle data carefully — analytics is anonymous by construction, secrets are stored in Cloudflare's secret store rather than in source, and the marketplace Worker auto-deploys via GitHub Actions with vetted secrets. We are not, however, a security-resourced organization. If you have security concerns, see [SECURITY.md](./SECURITY.md).

---

## 7. Changes to this policy

If we change this policy, we'll update the **Effective date** at the top, push the new file to the YouCoded repository, and — for material changes — note the change in the in-app announcement system. The current version always lives at `https://github.com/itsdestin/youcoded/blob/master/PRIVACY.md`. We recommend re-reading it occasionally if the project's data flows matter to you.

We will not retroactively expand what's collected from data already in our systems without first updating this policy and giving users a chance to opt out.

---

## 8. Contact

Destin's Adventures, LLC, Arizona, United States.

- **Email:** support@youcoded.ai
- **Subject line for privacy questions:** `[YouCoded Privacy] <short description>`
- **Source code:** https://github.com/itsdestin/youcoded
- **Issue tracker (non-sensitive):** https://github.com/itsdestin/youcoded/issues

For security issues specifically, see [SECURITY.md](./SECURITY.md).
