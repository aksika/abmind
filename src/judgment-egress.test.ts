/**
 * Owner-side egress gate tests. No network, no database: the gate
 * reads parsed env only. Each case pins one row of the allow/deny matrix so
 * a future backend or operation cannot silently widen SaaS egress.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initAbmindEnv, _resetAbmindEnv } from "./env-schema.js";
import { checkJudgmentEgress, type JudgmentOperation } from "./judgment-egress.js";

const OPS: JudgmentOperation[] = ["rerank", "sleep-support"];

describe("checkJudgmentEgress", () => {
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
    process.env["SYSTEM1_JEV_EGRESS"] = " Rerank , SLEEP-support ";
    initAbmindEnv();
    expect(checkJudgmentEgress("jev", "rerank")).toEqual({ allow: true });
    expect(checkJudgmentEgress("jev", "sleep-support")).toEqual({ allow: true });
  });

  it("denies ungranted jev operations", () => {
    process.env["SYSTEM1_JEV_EGRESS"] = "rerank";
    initAbmindEnv();
    expect(checkJudgmentEgress("jev", "sleep-support")).toEqual({
      allow: false, reason: "jev-egress-not-granted",
    });
  });

  it("denies unknown provider names even with a grant present", () => {
    process.env["SYSTEM1_JEV_EGRESS"] = "rerank,sleep-support";
    initAbmindEnv();
    for (const op of OPS) {
      expect(checkJudgmentEgress("scripted", op)).toEqual({
        allow: false, reason: "unknown-provider",
      });
    }
  });
});
