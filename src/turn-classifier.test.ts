import { describe, it, expect } from "vitest";
import { classifyTurn, typeCodeToFull } from "./turn-classifier.js";

describe("turn-classifier", () => {
  describe("classifyType", () => {
    it("identifies questions ending with ? and interrogative", () => {
      expect(classifyTurn("user", "What is the time?").typeHint).toBe("Q");
      expect(classifyTurn("user", "How do I fix this?").typeHint).toBe("Q");
      expect(classifyTurn("user", "Why is it broken?").typeHint).toBe("Q");
    });

    it("does NOT classify as question if ? but no interrogative", () => {
      // Rhetorical/exclamation
      expect(classifyTurn("user", "Really?").typeHint).not.toBe("Q");
    });

    it("identifies decisions", () => {
      expect(classifyTurn("user", "I decided to go with Clerk.").typeHint).toBe("D");
      expect(classifyTurn("assistant", "Let's use GraphQL instead.").typeHint).toBe("D");
      expect(classifyTurn("user", "We'll go with option A.").typeHint).toBe("D");
    });

    it("identifies user preferences", () => {
      expect(classifyTurn("user", "I prefer dark mode.").typeHint).toBe("P");
      expect(classifyTurn("user", "I love minimal UIs.").typeHint).toBe("P");
      expect(classifyTurn("user", "I always use vim.").typeHint).toBe("P");
    });

    it("does NOT classify assistant preference statements as P", () => {
      // "I prefer" from assistant shouldn't trigger (edge case)
      const r = classifyTurn("assistant", "I prefer clarity in code.");
      expect(r.typeHint).not.toBe("P");
    });

    it("identifies technical content", () => {
      expect(classifyTurn("user", "```\nnpm install\n```").typeHint).toBe("T");
      expect(classifyTurn("user", "Check /src/components/Button.tsx").typeHint).toBe("T");
      expect(classifyTurn("user", "The regex pattern broke.").typeHint).toBe("T");
    });

    it("identifies lessons / realizations", () => {
      expect(classifyTurn("user", "I keep getting that FTS issue again.").typeHint).toBe("L");
      expect(classifyTurn("user", "Turns out the bug was in config.").typeHint).toBe("L");
      expect(classifyTurn("user", "Note to self: always back up first.").typeHint).toBe("L");
    });

    it("defaults: assistant → F (fact), user → O (observation)", () => {
      expect(classifyTurn("assistant", "The sky is blue.").typeHint).toBe("F");
      expect(classifyTurn("user", "Okay thanks.").typeHint).toBe("O");
    });
  });

  describe("classifyTopic", () => {
    it("coding keywords", () => {
      expect(classifyTurn("user", "Fix this bug in the code.").topicHint).toBe("coding");
      expect(classifyTurn("user", "Check the SQL query.").topicHint).toBe("coding");
      expect(classifyTurn("user", "API returns 500.").topicHint).toBe("coding");
    });

    it("finance keywords", () => {
      expect(classifyTurn("user", "The pricing is too high.").topicHint).toBe("finance");
      expect(classifyTurn("user", "My budget is tight.").topicHint).toBe("finance");
    });

    it("health keywords", () => {
      expect(classifyTurn("user", "I feel sick today.").topicHint).toBe("health");
      expect(classifyTurn("user", "Need to exercise more.").topicHint).toBe("health");
    });

    it("memory (meta) keywords", () => {
      expect(classifyTurn("user", "I can't remember the name.").topicHint).toBe("memory");
      expect(classifyTurn("user", "Let me recall what happened.").topicHint).toBe("memory");
    });

    it("returns null for unrecognized topics", () => {
      expect(classifyTurn("user", "Hello there.").topicHint).toBeNull();
    });
  });

  describe("classifyEmotion", () => {
    it("matches common emotion words", () => {
      expect(classifyTurn("user", "I'm so frustrated with this.").emotionHint).toBe("frust");
      expect(classifyTurn("user", "Feeling anxious today.").emotionHint).toBe("anx");
      expect(classifyTurn("user", "I'm happy to help.").emotionHint).toBe("joy");
    });

    it("returns null when no emotion word present", () => {
      expect(classifyTurn("user", "The code compiles.").emotionHint).toBeNull();
    });
  });

  describe("typeCodeToFull", () => {
    it("maps single-letter codes to full names", () => {
      expect(typeCodeToFull("F")).toBe("fact");
      expect(typeCodeToFull("D")).toBe("decision");
      expect(typeCodeToFull("P")).toBe("preference");
      expect(typeCodeToFull("L")).toBe("lesson");
      expect(typeCodeToFull("Q")).toBe("question");
      expect(typeCodeToFull("T")).toBe("technical");
      expect(typeCodeToFull("E")).toBe("event");
      expect(typeCodeToFull("O")).toBe("observation");
    });

    it("null / undefined / unknown → 'fact'", () => {
      expect(typeCodeToFull(null)).toBe("fact");
      expect(typeCodeToFull(undefined)).toBe("fact");
      expect(typeCodeToFull("Z")).toBe("fact");
    });
  });
});
