// build-overlay.js — compile the macOS keytap overlay helper.
//
// The helper is a native CGEventTap binary (src/main/overlay/keytap.swift) and
// only runs on macOS — the runtime is already darwin-gated in overlay-bridge.ts
// (`if (process.platform !== "darwin") return;`). swiftc doesn't exist on
// Windows/Linux, so this script skips compilation there instead of failing the
// whole build. Replaces the inline `swiftc` npm script for cross-platform CI.

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");

if (process.platform !== "darwin") {
  console.log(`[build:overlay] skipped — macOS-only helper (platform: ${process.platform})`);
  process.exit(0);
}

fs.mkdirSync("dist/main/overlay", { recursive: true });
execFileSync(
  "swiftc",
  ["src/main/overlay/keytap.swift", "-o", "dist/main/overlay/keytap"],
  { stdio: "inherit" },
);
