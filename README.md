# YouCoded

**Claude Code on every device.** A cross-platform app for Windows, macOS, Linux, and Android — with remote access from any web browser.

> Built entirely without coding experience, using Claude Code itself.

---

## What is YouCoded?

YouCoded is an open-source app that puts [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — Anthropic's agentic coding and AI assistant tool — into a real app with a chat interface, themes, a skill marketplace, and multiplayer games. Sign in with your Claude Pro or Max plan and start using it.

It's designed for students, professionals, and anyone who uses AI regularly — not just developers.

**Disclaimer:** YouCoded is an independent, community-built project. It is not affiliated with, endorsed by, or officially supported by Anthropic.

## Features

**Chat & Terminal**
- Chat interface with structured message rendering, tool cards, and markdown
- Full terminal emulator for direct shell access
- Multiple concurrent sessions with color-coded status
- Model selector — cycle between Claude models with persistence
- Folder switcher — quick-access saved directories for session creation
- Permission mode cycling (Normal, Auto-Accept, Plan Mode)

**Social AI**
- Create custom skills and share them with friends, classmates, or coworkers
- Play multiplayer games (Connect Four) while waiting for Claude to finish working
- Build and share custom theme packs with the community

**Skill Marketplace**
- Browse and install skills from 150+ available options
- Create your own prompt skills and share them via deep links
- Quick-launch chips for your most-used skills
- Theme Builder and Marketplace Publisher ship pre-installed (auto-installed on every launch and not removable) so `/theme-builder` and plugin-publishing flows work out of the box

**Commands**
- Browse and search slash commands directly in the command drawer
- Three sources: YouCoded-handled (clickable, dispatched in-app), filesystem-scanned user/project/plugin commands (forwarded to the terminal), and Claude Code built-ins (visible reference, run in Terminal View)

**Themes**
- 4 built-in themes (Light, Dark, Midnight, Creme) + community theme packs
- Custom wallpapers, particle effects, mascot characters, and icon overrides
- Build your own themes with `/theme-builder`

**Announcements**
- Maintainer announcements (release notices, status updates) are fetched hourly and shown in the status bar
- Source: [`announcements.txt`](https://github.com/itsdestin/youcoded/blob/master/announcements.txt) in this repo

**Remote Access**
- Access YouCoded from any web browser on your network
- Use it from your phone, tablet, or another computer
- Same full UI — just open a URL
- The Android app permits cleartext WebSocket connections to paired desktop hosts on your LAN or Tailscale network. Use Tailscale (WireGuard encryption) for sensitive traffic — every connection is still gated by a bcrypt password handshake regardless

**Multiplayer Lobby (Privacy Note)**
- The multiplayer game lobby (powered by [PartyKit](https://www.partykit.io/) on Cloudflare Durable Objects) shares your GitHub username and idle/in-game status with other signed-in YouCoded users so they can challenge you
- Toggle **Incognito** in the multiplayer settings to stay hidden — no presence is broadcast in incognito mode

**Powered by YouCoded**
- Optional [YouCoded toolkit](https://github.com/itsdestin/youcoded-core) adds journaling, a personal encyclopedia, task inbox processing, text messaging, and cross-device sync
- Heavily encouraged but not required — install what you want

## Platforms

| Platform | Status | Install |
|----------|--------|---------|
| Windows | Available | Download `.exe` from [Releases](https://github.com/itsdestin/youcoded/releases) |
| macOS | Available | Download `.dmg` from [Releases](https://github.com/itsdestin/youcoded/releases) |
| Linux | Available | Download `.AppImage` from [Releases](https://github.com/itsdestin/youcoded/releases) |
| Android | Available | Download `.apk` from [Releases](https://github.com/itsdestin/youcoded/releases) |
| Web browser | Via remote access | Open the app on any device, then access from any browser on your network |

## Requirements

- A [Claude Pro or Max plan](https://claude.ai/) (sign in with your Claude account)
- Android: Android 9+ (arm64)
- Desktop: Windows 10+, macOS 11+, or Linux (x64)

## Building from Source

### Desktop (Electron)

```bash
git clone https://github.com/itsdestin/youcoded.git
cd youcoded/desktop
npm ci
npm run dev       # Development mode with hot reload
npm test          # Run tests
npm run build     # Build distributable installer
```

### Android

```bash
git clone https://github.com/itsdestin/youcoded.git
cd youcoded
./gradlew assembleDebug
```

Debug APK at `app/build/outputs/apk/debug/app-debug.apk`.

## Project Structure

```
youcoded/
  desktop/     # Electron app (Windows, macOS, Linux)
  app/         # Android app (Kotlin + Jetpack Compose)
  scripts/     # Shared build scripts
```

## Contributing

Contributions welcome — bug fixes, features, documentation, testing on different devices.

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## Related Projects

- [YouCoded](https://github.com/itsdestin/youcoded-core) — The plugin toolkit that powers YouCoded's personalization features
- [YouCoded Themes](https://github.com/itsdestin/wecoded-themes) — Community theme registry
- [YouCoded Marketplace](https://github.com/itsdestin/wecoded-marketplace) — Skill marketplace registry

## License

YouCoded is dual-licensed to reflect the distinct obligations of its two distributions:

- **Desktop application** (`desktop/`): **MIT** — see [desktop/LICENSE](desktop/LICENSE).
- **Android application** (`app/`): **GPLv3** — see [app/LICENSE](app/LICENSE). Android is GPLv3 because it links against Termux terminal components, which are GPLv3.
- **Shared source, build scripts, and docs**: **MIT** — see the root [LICENSE](LICENSE) for the full explanation of how the dual license works.

The React UI that powers both platforms is MIT-licensed at the source level. When it is aggregated into the Android APK alongside Termux, GPLv3 governs the resulting Android distribution as a whole; the underlying source, as offered in this repository, retains its MIT license (GPLv3 Section 5, aggregation).
