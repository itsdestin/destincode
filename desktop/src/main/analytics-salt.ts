// Static salt for HMAC-SHA256 over the device's machine_id + platform.
// Baked into the source by design — see docs/superpowers/specs/2026-05-01-device-id-analytics-design.md
// "Threat model" for why decompile-resistance is not a goal.
//
// MUST match Android's Salt.kt. Changing this value re-hashes every device,
// fragmenting all device-counted metrics. Do not rotate without intent.
export const ANALYTICS_SALT = "9c545b748dacdc18cfe105a196274266048fd9c2f7e1b16be8f9904ece654b9a";
