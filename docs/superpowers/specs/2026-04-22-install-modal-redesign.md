---
title: Install Modal Redesign
date: 2026-04-22
status: spec
---

# Install Modal Redesign

Rework the download flow on [itsdestin.github.io/youcoded](https://itsdestin.github.io/youcoded/) so that clicking a platform's download card shows a popup with platform-specific install guidance first. The actual download only starts when the user clicks a **Download Now** button inside the popup. Instructions are rewritten to be more robust — in particular the macOS steps, which broke for users on macOS 15 Sequoia when Apple removed the old right-click → Open bypass.

## Problem

The current site at `youcoded/docs/index.html` wires four download cards (Windows / macOS / Linux / Android) so that a click both starts the download immediately AND opens an "Installing now…" modal with tips. Two issues:

1. **Timing:** Users miss the install guidance because the download fires at the same moment the modal opens. Many close the modal and try to run the file with no context.
2. **Outdated macOS content:** The modal tells Mac users to "right-click → Open" an unsigned app. Apple removed that bypass in macOS 15 Sequoia (fall 2024). Two Mac users have reported the instructions do not work. Destin's old Mac mini runs pre-Sequoia, which masked the regression.
3. **Thin Android content:** The Android modal has two lines about "allow installs from your browser" and nothing about Google Play Protect's "unrecognized developer" warning, which is the actual step where most first-time sideloaders bail.

The Mac DMG and Windows installer are both unsigned (no codesign/notarize step in `.github/workflows/desktop-release.yml`). Acquiring certificates is a separate, paid effort out of scope for this spec.

## Goals

- Click a download card → popup opens → user reads instructions → user clicks **Download Now** → download starts.
- Replace every platform's install content with robust, non-technical steps that match current OS behavior (Sequoia on Mac, current Android versions).
- Add a collapsible **After install: What to expect on first launch** section so curious users can see what happens after they run the app — without making the default modal longer.
- No changes that would require signing/notarizing the installers.

## Non-goals

- Getting the DMG notarized or the `.exe` signed. These are paid, separate engineering tasks.
- Auto-detecting macOS version or Android OEM to branch instructions. Decided against during brainstorming in favor of a single flat flow per platform (see "Branching decisions" below).
- Changing the "Prerequisites" section that sits above the downloads.
- Changing OS auto-detection / primary-card highlighting.
- Changing the Android-only mid-page CTA pill that shows only to Android visitors.

## Scope

All edits are in one file: `youcoded/docs/index.html`.

Three zones change:
1. The CSS block for `.install-modal` and descendants (new button and collapsible styles).
2. The modal markup at the `#install-modal` element (add footer with Download Now button and new collapsible section).
3. The JS IIFE at the bottom (`// --- Install-tips modal ---`) — rewrite click behavior, inject new per-platform content, plumb release-asset URL + size into the Download Now button.

## Branching decisions (made during brainstorming)

- **Flat per-platform content**, not version-branched. macOS gets the Sequoia-compatible flow for everyone — the two extra steps are harmless on older macOS. Android gets one generic flow with a single Samsung-path callout.
- **Collapsible "After install" section**, not a separate modal or a second page. Default-closed so the "Before you install" steps stay prominent.
- **No auto-close** after Download Now is clicked. Button text changes to "Download Initiated"; user closes the modal when ready.
- **No antivirus line** on Windows. Rare enough that the noise cost > benefit.
- **libfuse2 terminal command stays** on Linux. It's the single most common "AppImage won't launch" cause on Ubuntu 22.04+; worth the mild technical flavor.

## Flow change

### Before
```
click card → download fires (href navigation)
           → modal opens with generic tips
```

### After
```
click card → preventDefault
           → modal opens with "Before you install" + "After install" sections
           → user reads
           → user clicks Download Now inside modal
           → Download Now's href navigation starts download
           → button text changes to "Download Initiated"
           → modal remains open until user closes it manually (X, scrim, or Esc)
```

Graceful fallback: if JS is disabled, the existing `href="https://github.com/itsdestin/youcoded/releases/latest"` on each card still works — the user just bypasses the modal entirely and lands on the release page. This is acceptable because it matches the pre-redesign behavior minus the lost tips.

## Modal layout (top to bottom)

1. **Close button (X)** — top-right, existing `.install-modal-close`, no change.
2. **Title** — "Before you install YouCoded on [Platform]" where [Platform] is "Mac", "Windows", "Linux", or "Android".
3. **"Before you install" section** — always visible. Intro paragraph + numbered `<ol>`. Platform-specific content below.
4. **"After install: What to expect on first launch"** — collapsible `<details>` element (default closed). Universal content with one Android callout. Content below.
5. **Footer row** — flex row, space-between alignment:
   - *Left:* nothing (or keep a subtle "Not now" text-only cancel — see Open Question below).
   - *Right:* **Download Now (XX MB)** primary button. This is an `<a>` styled as a button so right-click → "Save As" still works.

## Content

### macOS — "Before you install on Mac"

**Intro:**
> YouCoded is open-source and isn't signed with an Apple Developer certificate yet (it costs $99/yr 😢). macOS will block it on first launch — this is expected. Here's how to get past it.

**Steps:**
1. Open the file you just downloaded, then drag YouCoded into your **Applications** folder.
2. Open your **Applications** folder and double-click YouCoded. macOS will show a warning: *"YouCoded can't be opened because Apple cannot check it for malicious software."* Click **Done**.
3. Open **System Settings → Privacy & Security** (Apple menu → System Settings).
4. Scroll down to the **Security** section. You'll see a note: *"YouCoded was blocked to protect your Mac."* Click the **Open Anyway** button next to it.
5. Enter your password or use Touch ID to confirm.
6. Go back to your Applications folder and double-click YouCoded one more time. A final dialog appears — click **Open**.
7. You only have to do this the first time. After that, YouCoded opens normally.

### Windows — "Before you install on Windows"

**Intro:**
> YouCoded is open-source and isn't signed with a Microsoft code-signing certificate yet. Windows will show a warning on first launch — this is expected. Here's how to get past it.

**Steps:**
1. Open the file you just downloaded (the YouCoded installer).
2. Windows SmartScreen will likely show a blue window: **"Windows protected your PC."** Don't click the big "Don't run" button.
3. Click the small **More info** link under the warning text. A **Run anyway** button will appear.
4. Click **Run anyway**. The installer will proceed normally.
5. You only see this prompt the first time. Windows remembers your choice for future launches.

### Linux — "Before you install on Linux"

**Intro:**
> YouCoded ships as an AppImage — a self-contained file that runs without a traditional installer.

**Steps:**
1. Open the file you just downloaded (the YouCoded AppImage).
2. If double-clicking doesn't work, your file manager may need permission to run it: right-click → **Properties → Permissions** → check **"Allow executing file as program."**
3. Double-click to launch.

**Optional note at bottom:**
> **If the app doesn't start:** Some newer Linux distributions need an extra library. Open a terminal and run: `sudo apt install libfuse2` (Ubuntu/Debian) or equivalent for your distro.

### Android — "Before you install on Android"

**Intro:**
> YouCoded isn't on the Google Play Store yet, so you'll install it directly from the APK you just downloaded. Android asks for permission the first time you do this.

**Steps:**
1. When the download finishes, tap the notification (or open **Files → Downloads** and tap the YouCoded APK).
2. Android will say *"For your security, your phone isn't allowed to install unknown apps from this source."* Tap **Settings**.
3. Enable **Allow from this source** for whichever app you're installing from (usually Chrome). Tap back.
4. Tap **Install**. If **Google Play Protect** shows a warning, tap **More details → Install anyway**. Play Protect often doesn't recognize apps that aren't in the Play Store — this is normal.
5. Wait for the install to finish, then tap **Open**.

**Small note at bottom:**
> **On Samsung phones:** The "Allow from this source" setting lives under **Settings → Biometrics and security → Install unknown apps** if Android doesn't take you there automatically.

### Universal — "After install: What to expect on first launch"

Collapsible `<details>` element, default closed. Same content on every platform except for the Android callout at the end.

**When expanded:**

1. **Sign in with your Claude account.** YouCoded uses your existing **Claude Pro or Max** subscription — the same account you use on claude.ai. No separate account, no API key. If you don't have a paid plan yet, you can [sign up here](https://claude.ai/upgrade).
2. **Pick a starter theme and model.** Both are changeable anytime from the settings panel, so don't overthink it.
3. **Browse the marketplace.** Skills (things that give Claude new abilities) and themes (visual overhauls) are a few taps away and shareable with friends.

**Android-only callout** — rendered at the bottom of the "After install" section (after step 3 of the numbered list), only when the modal's platform is Android:
> **On Android, expect one extra step:** the first launch runs a one-time setup that downloads and unpacks the Claude Code runtime (~400–600MB depending on the package tier you pick). Keep the app open on the setup screen until it finishes — it's fast on Wi-Fi.

## Download Now button

### URL and size resolution

The existing JS already fetches `/releases/latest` from the GitHub API and rewrites each card's `href` when the response lands. That same flow is extended to also capture each asset's `size` (in bytes) and store both `{url, size}` keyed by platform.

Button text:
- Before latest-release metadata resolves: **Download Now**
- After metadata resolves: **Download Now (XX MB)** where XX is `Math.round(size / 1024 / 1024)`
- After click: **Download Initiated**

If the user clicks Download Now before metadata resolves (edge case — slow GitHub API), the button's `href` falls back to the same generic `releases/latest` page the cards already point at. User lands on the release page and picks the asset manually. No broken path.

### DOM

Use an `<a>` styled as a button so the browser's native download-on-click works, right-click → "Save link as" works, and keyboard navigation works for free. The click handler updates the button's text to "Download Initiated" on the same click, then lets the default navigation proceed.

## CSS additions

All new styles live in the existing `/* --- Install-tips modal --- */` CSS block.

- `.install-modal-footer` — flex row at the bottom of the panel, space-between alignment.
- `.install-modal-download-btn` — primary button style matching the page's existing accent color (reuse `var(--accent)` tokens). Pronounced enough to read as the primary action.
- `.install-modal-details` — wraps the `<details>` collapsible; small top margin separating it from the "Before you install" block. `summary` element styled like a secondary header with a rotating caret.
- `.install-modal-note` — small-text callout block for the optional Linux/Android/Android-callout notes, same indent as `<li>` items.

Panel max-height must accommodate the expanded collapsible — bump `.install-modal-panel` `max-height` to `90vh` and keep the existing `overflow-y: auto`.

## JS changes

Rewrite the `// --- Install-tips modal ---` IIFE:

1. Remove current per-platform `tipsByPlatform` flat HTML strings. Replace with a structured object per platform: `{ title, intro, steps: string[], note?: string, afterInstallExtra?: string }`.
2. Build modal innerHTML from the structured object so the "Before you install" + "After install" sections can both reference the same strings.
3. Intercept each card's click with `event.preventDefault()`; pass the card's `id` (e.g., `dl-windows`) to `openModal()`.
4. Inside `openModal`, populate the title, the two content sections, and wire up the Download Now button's `href` to the stored URL for that platform (+ size-suffixed text if resolved).
5. On Download Now click, set button text to "Download Initiated" before the default navigation runs (don't preventDefault).
6. Extend the existing latest-release fetch to persist `{url, size}` into a closure variable the modal reads on open.

## Behavior & edge cases

- **JS disabled:** Cards' existing `href="https://github.com/itsdestin/youcoded/releases/latest"` still navigates. User misses the modal but doesn't get a broken link.
- **Latest-release fetch fails:** Modal opens and the Download Now button falls back to the generic `/releases/latest` URL the cards already had pre-redesign.
- **Latest-release fetch still pending when user clicks a card:** Modal opens with "Download Now" (no size suffix). Clicking Download Now before the fetch resolves uses the fallback URL.
- **User clicks multiple platforms:** Opens the new platform's modal every time. No stale state between opens — content is rebuilt from scratch each click.
- **Mobile viewport:** Modal already uses `max-height: 85vh` with `overflow-y: auto`. Bumping to `90vh` keeps the Download Now button visible at the bottom even with the collapsible expanded.
- **Download Initiated state is per-modal-open.** Closing and reopening the modal for the same platform restores "Download Now" text. (No need for persistence — it's a per-session visual cue, not state.)

## Testing

Manual only (this is a static HTML/CSS/JS page, no test harness):

1. Click each of the four download cards — confirm no download starts and the modal opens with the correct platform title and content.
2. Click Download Now in each modal — confirm download starts, button text flips to "Download Initiated", modal stays open.
3. Close via X, scrim click, Escape key — confirm all three work.
4. Expand the "After install" collapsible — confirm it renders below the "Before you install" section, Android sees the extra 400–600MB callout.
5. Open on a phone-width viewport (Chrome DevTools mobile emulation) — confirm modal is scrollable and the Download Now button stays reachable.
6. Throttle network / block the `/releases/latest` fetch and confirm Download Now still navigates somewhere usable (the generic `/releases/latest` fallback).
7. Disable JS in the browser and confirm cards still navigate to `/releases/latest` directly.

## Open questions

- **"Not now" cancel link in the footer?** None of the brainstorming decisions called for one explicitly. Current X button + scrim + Escape are sufficient to close. Leaving out unless review feedback says otherwise.

## Rollout

Single PR to `itsdestin/youcoded` editing `docs/index.html`. GitHub Pages redeploys automatically on push to master. No release tag needed — the site is independent of the desktop/Android release cycle.
