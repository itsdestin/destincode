package com.youcoded.app.analytics

// Static salt for HMAC-SHA256 over the device's ANDROID_ID + platform.
// MUST match desktop/src/main/analytics-salt.ts ANALYTICS_SALT.
// See docs/superpowers/specs/2026-05-01-device-id-analytics-design.md.
const val ANALYTICS_SALT = "9c545b748dacdc18cfe105a196274266048fd9c2f7e1b16be8f9904ece654b9a"
