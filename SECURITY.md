# Security Policy

## Reporting a Vulnerability

If you've found a security issue in YouCoded — desktop, Android, the marketplace worker, or any of the bundled plugins — **please report it privately rather than opening a public GitHub issue**.

**Email:** support@youcoded.ai
**Subject line:** `[YouCoded Security] <short description>`

What helps:

- A clear description of the issue and the impact you observed.
- Steps to reproduce, or a proof-of-concept if you have one.
- The platform (Windows / macOS / Linux / Android) and YouCoded version.
- Whether you've shared the issue with anyone else, and any timeline you'd like respected before public disclosure.

I aim to acknowledge reports within **5 days** and to triage / fix or explain the constraint within **30 days**, depending on severity. YouCoded is a small, hobbyist-scale project maintained by one person, so timing isn't enterprise-grade — please bear with me.

## Scope

In scope:

- The YouCoded desktop application (`youcoded/desktop/`).
- The YouCoded Android application (`youcoded/app/`).
- The marketplace Cloudflare Worker (`wecoded-marketplace/worker/`).
- The bundled plugins (`youcoded-core`, `wecoded-themes-plugin`, `wecoded-marketplace-publisher`).
- The theme and marketplace registries (`wecoded-themes`, `wecoded-marketplace`) where they affect what end users download.

Out of scope (please report to the upstream project instead):

- Vulnerabilities in Anthropic's Claude Code CLI itself.
- Vulnerabilities in Electron, Node.js, Termux, or other underlying frameworks.
- Vulnerabilities in third-party plugins or themes contributed by community members — those should be reported to the plugin/theme author, though I'm happy to receive a copy and help coordinate.

## Disclosure

I'll work with you on a coordinated disclosure timeline. Once a fix is shipped, I'll credit you in the release notes if you want the credit (and won't if you don't). I won't take legal action against good-faith security research that follows this policy.

## Trademark / Affiliation Note

YouCoded is an independent, community-built project. It is not affiliated with, endorsed by, or officially supported by Anthropic. Please do not report YouCoded vulnerabilities to Anthropic — they don't maintain this project.
