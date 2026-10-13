import { describe, expect, it } from "vitest";
import { renderStatus, type AbmindStatusView } from "./status-view.js";

function base(): AbmindStatusView {
  return {
    install: {
      home: "/home/u/.abmind",
      releaseId: "0.3.2-alpha.0-dev-abc123",
      commit: "abc123",
      source: "git",
      activatedAt: "2026-10-05T21:35:02.003Z",
      host: "some-host",
      keyPresent: true,
      soulBytes: 2355,
      deploymentLock: "free",
      daemon: "stopped",
      system1: "laya 127.0.0.1:8765 (recall off) — local config",
      layaService: "stopped",
    },
    service: { state: "unavailable", message: "Negotiation failed: Could not connect to daemon" },
    hooks: { errorCount: 0, lastError: null, activeSidecars: 0 },
  };
}

describe("renderStatus", () => {
  it("renders three headline-free sections when the daemon is stopped", () => {
    const out = renderStatus(base());
    expect(out).toBe([
      "abmind status",
      "  home:          /home/u/.abmind",
      "  release:       0.3.2-alpha.0-dev-abc123",
      "  commit:        abc123",
      "  source:        git",
      "  lock:          not held",
      "  SOUL:          ✓ (2.3 KB)",
      "  activated:     2026-10-05T21:35:02.003Z",
      "  host:          some-host",
      "  key:           ✓ abmind.key",
      "",
      "  daemon:        stopped — Run 'abmind start' to launch it, 'abmind doctor' for details.",
      "",
      "  system1:       laya 127.0.0.1:8765 (recall off) — local config",
      "  laya service:  stopped",
    ].join("\n"));
    // No version line (redundant with release), no Service headline.
    expect(out).not.toContain("version:");
    expect(out).not.toContain("── Service ──");
    expect(out).not.toContain("Negotiation failed");
  });

  it("renders daemon details without headlines when the daemon is ready", () => {
    const view = base();
    view.install.daemon = "running (pid 1901)";
    view.install.layaService = "running (pid 1897)";
    view.service = {
      state: "ready",
      mode: "daemon",
      instanceId: "i-1",
      pid: 1901,
      uptimeMs: 42000,
      memoryEnabled: true,
      totalMessages: 128,
      extractedMemories: 35,
      consolidationDaily: 5,
      consolidationWeekly: 2,
      consolidationQuarterly: 0,
      dbSizeBytes: 3.2 * 1024 * 1024,
    };
    const out = renderStatus(view);
    expect(out).toContain("  daemon:        running (pid 1901)");
    expect(out).toContain("  mode:          daemon");
    expect(out).toContain("  messages:      128");
    expect(out).toContain("  consolidation: q00/w02/d05");
    expect(out).toContain("  laya service:  running (pid 1897)");
    expect(out).not.toContain("──");
  });

  it("keeps supervisor truth plus the failure detail when RPC fails on a running job", () => {
    const view = base();
    view.install.daemon = "running (pid 1901)";
    const out = renderStatus(view);
    expect(out).toContain("  daemon:        running (pid 1901)");
    expect(out).toContain("Negotiation failed: Could not connect to daemon");
    expect(out).toContain("Run 'abmind doctor' for details.");
  });
});
