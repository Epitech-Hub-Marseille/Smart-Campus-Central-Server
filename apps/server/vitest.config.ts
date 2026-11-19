import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration tests start an in-memory MongoDB and a real HTTP/WebSocket server.
    testTimeout: 15_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    // The two-factor requirement for admins is switched off here so the suites sign in with a password alone; the two-factor suite turns it on.
    env: { ALLOWED_ORIGINS: "http://10.0.0.5:5173, http://192.168.1.20:3000", REQUIRE_ADMIN_2FA: "false", LOGIN_RATE_LIMIT: "1000" },
  },
});
