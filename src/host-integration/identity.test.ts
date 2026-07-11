import { describe, it, expect } from "vitest";
import { validateIdentity, isValidIdentityField, canAutoWrite, buildProvenance } from "./identity.js";
import type { ExecutionIdentity } from "./types.js";

const validIdentity: ExecutionIdentity = {
  principalId: "user-1",
  conversationId: "conv-1",
  executionId: "exec-1",
  host: "pi",
  origin: "interactive",
  automaticWriteOwner: "pi-adapter",
};

describe("isValidIdentityField", () => {
  it("accepts normal strings", () => {
    expect(isValidIdentityField("user-1")).toBe(true);
    expect(isValidIdentityField("a")).toBe(true);
  });

  it("rejects empty strings", () => {
    expect(isValidIdentityField("")).toBe(false);
    expect(isValidIdentityField("   ")).toBe(false);
  });

  it("rejects control characters", () => {
    expect(isValidIdentityField("user\n1")).toBe(false);
    expect(isValidIdentityField("user\t1")).toBe(false);
    expect(isValidIdentityField("user\x001")).toBe(false);
    expect(isValidIdentityField("user\x7f1")).toBe(false);
  });
});

describe("validateIdentity", () => {
  it("passes valid identity with no diagnostics", () => {
    const result = validateIdentity(validIdentity);
    expect(result.diagnostics).toHaveLength(0);
    expect(result.identity.principalId).toBe("user-1");
  });

  it("trims whitespace from fields", () => {
    const result = validateIdentity({
      ...validIdentity,
      principalId: "  user-1  ",
      host: " pi ",
    });
    expect(result.identity.principalId).toBe("user-1");
    expect(result.identity.host).toBe("pi");
    expect(result.diagnostics).toHaveLength(0);
  });

  it("reports empty required fields", () => {
    const result = validateIdentity({
      ...validIdentity,
      principalId: "",
      conversationId: "",
    });
    const codes = result.diagnostics.map(d => d.code);
    expect(codes).toContain("EMPTY_IDENTITY_FIELD");
    expect(codes.filter(c => c === "EMPTY_IDENTITY_FIELD").length).toBe(2);
  });

  it("reports control characters in fields", () => {
    const result = validateIdentity({
      ...validIdentity,
      host: "pi\nadapter",
    });
    expect(result.diagnostics[0]!.code).toBe("CONTROL_CHAR_IN_IDENTITY");
  });

  it("validates parentExecutionId when present", () => {
    const withParent = validateIdentity({
      ...validIdentity,
      parentExecutionId: "parent-1",
    });
    expect(withParent.diagnostics).toHaveLength(0);

    const emptyParent = validateIdentity({
      ...validIdentity,
      parentExecutionId: "  ",
    });
    expect(emptyParent.diagnostics[0]!.code).toBe("EMPTY_PARENT_EXECUTION_ID");

    const ctrlParent = validateIdentity({
      ...validIdentity,
      parentExecutionId: "bad\nparent",
    });
    expect(ctrlParent.diagnostics[0]!.code).toBe("CONTROL_CHAR_IN_PARENT_EXECUTION_ID");
  });
});

describe("canAutoWrite", () => {
  it("returns true when writerId matches automaticWriteOwner", () => {
    expect(canAutoWrite(validIdentity, "pi-adapter")).toBe(true);
  });

  it("returns false when writerId does not match", () => {
    expect(canAutoWrite(validIdentity, "other-adapter")).toBe(false);
  });
});

describe("buildProvenance", () => {
  it("builds host:writer:operation string", () => {
    expect(buildProvenance(validIdentity, "pi-adapter", "store")).toBe("pi:pi-adapter:store");
  });

  it("does not contain raw content", () => {
    const result = buildProvenance(validIdentity, "adapter", "recall");
    expect(result).not.toContain("user-1");
    expect(result).not.toContain("conv-1");
  });
});
