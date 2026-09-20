/**
 * #1813 — owner-side egress gate tests. No network, no database: the gate
 * reads parsed env only. Each case pins one row of the allow/deny matrix so
 * a future backend or operation cannot silently widen SaaS egress.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initAbmindEnv, _resetAbmindEnv } from "./env-schema.js";
import { checkJudgmentEgress, type JudgmentOperation } from "./judgment-egress.js";

const OPS: JudgmentOperation[] = ["rerank", "lookup", "repeat", "attribution"];

describe("#1813 — checkJudgmentEgress", () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env["SYSTEM1_JEV_EGRESS"];
    delete process.env["SYSTEM1_JEV_EGRESS"];
    _resetAbmindEnv();
    initAbmindEnv();
  });

  afterEach(() => {
    if (saved === undefined) delete process.env["SYSTEM1_JEV_EGRESS"];
    else process.env["SYSTEM1_JEV_EGRESS"] = saved;
    _resetAbmindEnv();
  });

  it("allows laya for every operation without any grant (loopback-only)", () => {
    for (const op of OPS) {
      expect(checkJudgmentEgress("laya", op)).toEqual({ allow: true });
    }
  });

  it("denies jev for every operation when nothing is granted", () => {
    for (const op of OPS) {
      expect(checkJudgmentEgress("jev", op)).toEqual({
        allow: false, reason: "jev-egress-not-granted",
      });
    }
  });

  it("grants jev per operation, case-insensitively, ignoring whitespace", () => {
    process.env["SYSTEM1_JEV_EGRESS"] = " Lookup , REPEAT ";
    initAbmindEnv();
    expect(checkJudgmentEgress("jev", "lookup")).toEqual({ allow: true });
    expect(checkJudgmentEgress("jev", "repeat")).toEqual({ allow: true });
    expect(checkJudgmentEgress("jev", "rerank")).toEqual({
      allow: false, reason: "jev-egress-not-granted",
    });
    expect(checkJudgmentEgress("jev", "attribution")).toEqual({
      allow: false, reason: "jev-egress-not-granted",
    });
  });

  it("denies unknown provider names even with a grant present", () => {
    process.env["SYSTEM1_JEV_EGRESS"] = "rerank,lookup,repeat,attribution";
    initAbmindEnv();
    for (const op of OPS) {
      expect(checkJudgmentEgress("scripted", op)).toEqual({
        allow: false, reason: "unknown-provider",
      });
    }
  });
});
