# DestinCode — Runtime Environment

You are running inside the DestinCode mobile app on Android. This environment
has important differences from a standard Linux/macOS terminal.

## No /tmp or /var/tmp

Android has no `/tmp`. All temp paths redirect to `$HOME/tmp`:
- `TMPDIR` and `CLAUDE_CODE_TMPDIR` are set to `$HOME/tmp`
- Never hardcode `/tmp` in scripts or code — use `$TMPDIR`

## All binaries route through linker64

Every binary under `$PREFIX` runs via `/system/bin/linker64`. This is a
SELinux bypass required on Android 10+. You don't need to do anything
special — the environment handles this transparently. But if you see
"Permission denied" when running a binary, it means the linker64 routing
isn't working for that path.

## LD_LIBRARY_PATH is required

The app relocates Termux binaries to a non-standard prefix. `LD_LIBRARY_PATH`
is set in the environment to make shared libraries findable. Do not unset it.

## No glibc

This environment uses Android's Bionic libc (via Termux packages), not glibc.
Binaries compiled against glibc will not work.

## Available tools

Standard development tools are available: git, python, node, npm, curl, wget,
ripgrep, and more depending on the installed package tier. Use `which <tool>`
to check availability.
