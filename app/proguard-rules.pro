# YouCoded ProGuard Rules

# Termux terminal libraries — native JNI and reflection usage
-keep class com.termux.terminal.** { *; }
-keep class com.termux.view.** { *; }

# Apache Commons Compress — reflection-based codec loading
-keep class org.apache.commons.compress.** { *; }
-dontwarn org.apache.commons.compress.**

# XZ and Zstd — native decompression
-keep class org.tukaani.xz.** { *; }
-keep class com.github.luben.zstd.** { *; }
-dontwarn com.github.luben.zstd.**

# CommonMark — markdown parser
-keep class org.commonmark.** { *; }

# Keep JSON parsing (org.json is part of Android SDK but accessed via reflection in some cases)
-keep class org.json.** { *; }

# Suppress various dependency warnings
-dontwarn javax.annotation.**
-dontwarn javax.annotation.concurrent.**
-dontwarn com.google.errorprone.annotations.**
-dontwarn com.google.api.client.http.**
-dontwarn com.google.api.client.http.javanet.**
-dontwarn org.joda.time.**

# Keep our hook event and session classes (used with JSON parsing)
-keep class com.youcoded.app.parser.HookEvent { *; }
-keep class com.youcoded.app.parser.HookEvent$* { *; }

# Bootstrap: defense against future reflection regressions.
#
# PluginInstaller historically called bootstrap.javaClass.getMethod(
# "buildRuntimeEnv") via reflection. R8 obfuscated buildRuntimeEnv to a
# one-letter name, the lookup threw NoSuchMethodException, the silent
# fallback shipped a stripped env without LD_PRELOAD, and every git
# clone in the marketplace install path died with "cannot exec
# 'remote-https': Permission denied". Shipped silently from
# 2026-03-25 (e18ab861) through every release until 2026-04-30 when
# a user finally reported it.
#
# The reflection has been removed (see PluginInstaller.kt). This keep
# rule is belt-and-suspenders so that if someone reintroduces reflection
# against Bootstrap in the future, R8 can't silently break it. The cost
# is one class's public surface kept un-obfuscated — negligible.
-keep class com.youcoded.app.runtime.Bootstrap {
    public *;
}
