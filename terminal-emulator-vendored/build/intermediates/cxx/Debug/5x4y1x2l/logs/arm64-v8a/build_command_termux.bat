@echo off
"C:\\Users\\desti\\AppData\\Local\\Android\\Sdk\\ndk\\27.0.12077973\\ndk-build.cmd" ^
  "NDK_PROJECT_PATH=null" ^
  "APP_BUILD_SCRIPT=C:\\Users\\desti\\youcoded-dev\\youcoded\\terminal-emulator-vendored\\src\\main\\jni\\Android.mk" ^
  "APP_ABI=arm64-v8a" ^
  "NDK_ALL_ABIS=arm64-v8a" ^
  "NDK_DEBUG=1" ^
  "APP_PLATFORM=android-28" ^
  "NDK_OUT=C:\\Users\\desti\\youcoded-dev\\youcoded\\terminal-emulator-vendored\\build\\intermediates\\cxx\\Debug\\5x4y1x2l/obj" ^
  "NDK_LIBS_OUT=C:\\Users\\desti\\youcoded-dev\\youcoded\\terminal-emulator-vendored\\build\\intermediates\\cxx\\Debug\\5x4y1x2l/lib" ^
  "APP_CFLAGS+=-std=c11" ^
  "APP_CFLAGS+=-Wall" ^
  "APP_CFLAGS+=-Wextra" ^
  "APP_CFLAGS+=-Werror" ^
  "APP_CFLAGS+=-Os" ^
  "APP_CFLAGS+=-fno-stack-protector" ^
  "APP_CFLAGS+=-Wl,--gc-sections" ^
  termux
