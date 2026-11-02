/**
 * mcp-server.test.ts — MCP recall input contract.
 *
 * Regression: the model-visible schema (SdkRecallInput) once omitted
 * `profile` while the handler schema (StrictRecallInput) required it, so a
 * model-compliant memory_recall call always failed validation. The strict
 * schema now defaults an omitted profile to recall_normal and the SDK schema
 * advertises the field. Owner dispatch stays at the acceptance boundary.
 */
import { describe, it, expect } from "vitest";
import { SdkRecallInput, StrictRecallInput } from "./mcp-server.js";

describe("mcp recall input contract", () => {
  it("advertises profile to models as an optional field", () => {
    expect("profile" in SdkRecallInput.shape).toBe(true);
    const parsed = SdkRecallInput.safeParse({ keywords: ["migration"] });
    expect(parsed.success).toBe(true);
  });

  it("defaults an omitted profile to recall_normal", () => {
    const parsed = StrictRecallInput.safeParse({ keywords: ["migration"] });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.profile).toBe("recall_normal");
  });

  it("accepts a model-shaped call without profile end to end", () => {
    const sdk = SdkRecallInput.safeParse({ keywords: ["backup"], limit: 5 });
    expect(sdk.success).toBe(true);
    if (!sdk.success) return;
    const strict = StrictRecallInput.safeParse(sdk.data);
    expect(strict.success).toBe(true);
  });

  it("rejects an unknown profile instead of defaulting", () => {
    const parsed = StrictRecallInput.safeParse({ profile: "recall_all", keywords: ["x"] });
    expect(parsed.success).toBe(false);
  });

  it("still requires deliberate keywords", () => {
    expect(StrictRecallInput.safeParse({ profile: "recall_normal", keywords: [] }).success).toBe(false);
    expect(StrictRecallInput.safeParse({ profile: "recall_normal" }).success).toBe(false);
  });
});
