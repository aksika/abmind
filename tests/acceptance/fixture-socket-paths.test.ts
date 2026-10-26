import { describe, it, expect } from "vitest";
import { join } from "node:path";
import {
  FIXTURE_SOCKET_PATH_LIMIT,
  fixtureDirStem,
  assertFixtureSocketPath,
} from "./scenario-helpers.js";

// Real macOS $TMPDIR shape (50 chars). Linux /tmp is 4 chars, which is why
// CI stayed green while macOS fixtures blew the sun_path limit (#1841).
const LONG_TMPDIR = "/var/folders/qx/m785t7hs7f7dl5tq2fsf0x8w0000gp/T";

describe("fixture socket paths (#1841)", () => {
  it("keeps both lanes within the limit under a long macOS TMPDIR", () => {
    const localRoot = join(LONG_TMPDIR, `${fixtureDirStem("l")}-abcdef`);
    const localSock = join(localRoot, "run", "abmind.sock");
    expect(localSock.length).toBeLessThanOrEqual(FIXTURE_SOCKET_PATH_LIMIT);
    const wssRoot = join(LONG_TMPDIR, `${fixtureDirStem("w")}-abcdef`);
    const wssSock = join(wssRoot, "s.sock");
    expect(wssSock.length).toBeLessThanOrEqual(FIXTURE_SOCKET_PATH_LIMIT);
    expect(() => assertFixtureSocketPath(localSock)).not.toThrow();
    expect(() => assertFixtureSocketPath(wssSock)).not.toThrow();
  });

  it("stems stay compact with a lane tag", () => {
    expect(fixtureDirStem("l")).toMatch(/^abm-l-[0-9a-z]{12}$/);
    expect(fixtureDirStem("w")).toMatch(/^abm-w-[0-9a-z]{12}$/);
  });

  it("rejects over-limit paths with an actionable message", () => {
    const bad = `${"/x".repeat(60)}/run/abmind.sock`;
    expect(bad.length).toBeGreaterThan(FIXTURE_SOCKET_PATH_LIMIT);
    expect(() => assertFixtureSocketPath(bad)).toThrow(/exceeds 100 chars/);
  });
});
