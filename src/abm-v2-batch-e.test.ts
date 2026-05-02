import { describe, it, expect } from "vitest";
import { isFlashbulb, isAgingProtected, effectiveConfidence, detectInterference } from "./brain-patterns.js";

describe("brain-patterns", () => {
  describe("E1: flashbulb protection", () => {
    it("marks high emotion + pivot as flashbulb", () => {
      expect(isFlashbulb(5, "pivot,decision")).toBe(true);
      expect(isFlashbulb(-4, "pivot")).toBe(true);
    });

    it("marks high emotion + correction as flashbulb", () => {
      expect(isFlashbulb(-5, "correction")).toBe(true);
      expect(isFlashbulb(4, "correction,lesson")).toBe(true);
    });

    it("rejects low emotion or missing pivot/correction", () => {
      expect(isFlashbulb(3, "pivot")).toBe(false);
      expect(isFlashbulb(5, "decision")).toBe(false);
      expect(isFlashbulb(2, "milestone")).toBe(false);
      expect(isFlashbulb(-3, "correction")).toBe(false);
    });
  });

  describe("E1: aging protection", () => {
    it("protects high emotion", () => {
      expect(isAgingProtected(4, 0, "general")).toBe(true);
      expect(isAgingProtected(-5, 0, "general")).toBe(true);
    });

    it("protects frequently recalled", () => {
      expect(isAgingProtected(0, 3, "general")).toBe(true);
    });

    it("protects core tier", () => {
      expect(isAgingProtected(0, 0, "core")).toBe(true);
    });

    it("does not protect low-value general memories", () => {
      expect(isAgingProtected(1, 1, "general")).toBe(false);
    });
  });

  describe("E2: spaced repetition decay", () => {
    it("full confidence when recently recalled", () => {
      expect(effectiveConfidence(5, 0, 3)).toBe(5);
    });

    it("decays for never-recalled memories", () => {
      expect(effectiveConfidence(5, 45, 0)).toBeLessThan(5);
      expect(effectiveConfidence(5, 90, 0)).toBe(0);
    });

    it("decays slower for frequently recalled", () => {
      const neverRecalled = effectiveConfidence(5, 60, 0);
      const recalled3x = effectiveConfidence(5, 60, 3);
      expect(recalled3x).toBeGreaterThan(neverRecalled);
    });

    it("returns 0 for very old never-recalled", () => {
      expect(effectiveConfidence(3, 100, 0)).toBe(0);
    });
  });

  describe("E6: interference detection", () => {
    it("detects similar but different content in same topic", () => {
      expect(detectInterference(
        "We use PostgreSQL for the main database",
        "We are evaluating PostgreSQL for the new service database",
        "coding", "coding",
      )).toBe(true);
    });

    it("no interference across different topics", () => {
      expect(detectInterference(
        "We use PostgreSQL for the database",
        "We use PostgreSQL for the database",
        "coding", "personal",
      )).toBe(false);
    });

    it("no interference for identical content", () => {
      expect(detectInterference(
        "We use Clerk for auth",
        "We use Clerk for auth",
        "coding", "coding",
      )).toBe(false);
    });

    it("no interference for unrelated content", () => {
      expect(detectInterference(
        "We use Clerk for auth",
        "The weather is sunny today",
        "coding", "coding",
      )).toBe(false);
    });
  });
});
