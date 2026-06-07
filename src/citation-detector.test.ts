import { describe, it, expect } from "vitest";
import { detectCitations } from "./citation-detector.js";

describe("detectCitations", () => {
  const memories = [
    { id: 1, contentEn: "User prefers TypeScript over JavaScript for all new projects" },
    { id: 2, contentEn: "The deployment pipeline uses GitHub Actions with a staging environment" },
    { id: 3, contentEn: "Short" },
  ];

  it("detects substring match ≥20 chars", () => {
    const response = "Based on your preferences, you prefer TypeScript over JavaScript for all new projects, so I'll use TypeScript.";
    const cited = detectCitations(response, memories);
    expect(cited).toContain(1);
  });

  it("detects keyword overlap ≥5", () => {
    const response = "For the deployment, I recommend using GitHub Actions with the staging environment configured in the pipeline.";
    const cited = detectCitations(response, memories);
    expect(cited).toContain(2);
  });

  it("returns empty for no match", () => {
    const response = "Sure, I can help you with that database query.";
    const cited = detectCitations(response, memories);
    expect(cited).toEqual([]);
  });

  it("skips memories too short for substring", () => {
    const response = "Short answer: yes.";
    const cited = detectCitations(response, [{ id: 3, contentEn: "Short" }]);
    expect(cited).toEqual([]);
  });

  it("handles empty response", () => {
    expect(detectCitations("", memories)).toEqual([]);
  });

  it("handles empty memories", () => {
    expect(detectCitations("hello world", [])).toEqual([]);
  });

  it("is case-insensitive", () => {
    const response = "USER PREFERS TYPESCRIPT OVER JAVASCRIPT FOR ALL NEW PROJECTS";
    const cited = detectCitations(response, memories);
    expect(cited).toContain(1);
  });
});
