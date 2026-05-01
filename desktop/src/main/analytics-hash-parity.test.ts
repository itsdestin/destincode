import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { ANALYTICS_SALT } from "./analytics-salt";

// Parity contract: a fixed (machine_id, platform_label) input MUST hash to
// this exact value on both desktop and Android. The Android counterpart is
// AnalyticsServiceTest.kt's `hash parity with desktop` test. If you change
// SALT or the hash construction, BOTH this expected value AND the Android
// expected value must be updated together — silent salt drift between
// platforms would fragment the device count for users on both surfaces.
const FIXTURE_INPUT = "parity-fixture-id|darwin";
const EXPECTED = "cc2b29b771d8ad08297ea5a68a21e67d47e1a11ec2129b75346ff0ce5408e4a8";

describe("analytics hash parity", () => {
  it("hashes the parity fixture to the pinned value", () => {
    const actual = createHmac("sha256", ANALYTICS_SALT)
      .update(FIXTURE_INPUT)
      .digest("hex");
    expect(actual).toBe(EXPECTED);
  });
});
