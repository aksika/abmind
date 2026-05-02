import { describe, it, expect } from "vitest";
import { pickLevel, renderWakeUp, compressDailySummary, compressSoul } from "./wake-up-renderer.js";

describe("wake-up-renderer", () => {
  describe("pickLevel", () => {
    it("full for large budgets", () => expect(pickLevel(10000)).toBe("full"));
    it("compact for medium", () => expect(pickLevel(1000)).toBe("compact"));
    it("ultra for tiny", () => expect(pickLevel(200)).toBe("ultra"));
    it("signal for minimal", () => expect(pickLevel(50)).toBe("signal"));
  });

  describe("renderWakeUp", () => {
    const entries = [
      { content_compressed: "[D|coding|convict|5|2026-01] @clerk >over @auth0 (pricing+DX)", topic: "coding", emotion_arc: "↑" },
      { content_compressed: "[FT|coding|trust|5|2026-04] @agentbridge: TS+Node", topic: "coding" },
      { content_compressed: "[F|personal|—|5|2026-01] @user: aksika, CET", topic: "personal", emotion_arc: "→" },
    ];

    it("full mode returns raw ABM-L", () => {
      const result = renderWakeUp(entries, "full");
      expect(result).toContain("CORE MEMORY");
      expect(result).toContain("[D|coding|convict|5|2026-01]");
    });

    it("compact mode groups by topic", () => {
      const result = renderWakeUp(entries, "compact");
      expect(result).toContain("## coding ↑");
      expect(result).toContain("## personal →");
    });

    it("compact mode elides default confidence", () => {
      const result = renderWakeUp([
        { content_compressed: "[F|general|—|3|2026-04] some fact", topic: "general" },
      ], "compact");
      // Confidence 3 is default, should be elided
      expect(result).not.toContain("|3|");
    });

    it("compact mode keeps non-default confidence", () => {
      const result = renderWakeUp([
        { content_compressed: "[D|coding|convict|5|2026-01] important decision", topic: "coding" },
      ], "compact");
      expect(result).toContain("|5]");
    });

    it("returns empty for no entries", () => {
      expect(renderWakeUp([], "compact")).toBe("");
    });
  });

  describe("compressDailySummary", () => {
    it("compresses markdown to bullet points", () => {
      const md = "# Daily Summary\n\n## Morning\n- Worked on Telegram poller fix\n- Deployed new authentication module\n\n## Afternoon\n- Reviewed Discord integration\n";
      const result = compressDailySummary(md, "2026-04-07");
      expect(result).toContain("## 2026-04-07");
      expect(result).toContain("TG poller fix");
      expect(result).toContain("auth module");
    });

    it("returns empty for empty input", () => {
      expect(compressDailySummary("", "2026-04-07")).toBe("");
    });

    it("abbreviates platform names", () => {
      const md = "- Telegram poller failed\n- Discord reconnected\n";
      const result = compressDailySummary(md, "2026-04-07");
      expect(result).toContain("TG");
      expect(result).toContain("DC");
    });
  });

  describe("compressSoul", () => {
    it("extracts rules from SOUL markdown", () => {
      const soul = "## Continuity\nI have a memory system.\n- Always recall before saying I don't know\n- Never make things up\n\n## Communication\nI speak the user's language.\n- Use <NO_REPLY> when not needed\n";
      const result = compressSoul(soul);
      expect(result).toContain("continuity");
      expect(result).toContain("recall");
      expect(result).toContain("Never make things up");
      expect(result).toContain("<NO_REPLY>");
    });

    it("strips filler from rules", () => {
      const soul = "## Rules\n- Always check the very important database before responding\n";
      const result = compressSoul(soul);
      expect(result).not.toContain("very");
    });
  });
});
