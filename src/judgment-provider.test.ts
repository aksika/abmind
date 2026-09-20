/**
 * #1812 — judgment provider slot tests. The HTTP boundary is mocked;
 * no key or network is required.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createJudgmentProvider,
  JevProvider,
  LayaHttpProvider,
  checkLayaHealth,
  normalizeJudgmentAnswers,
  LAYA_CONTRACT_VERSION,
} from "./judgment-provider.js";
import type { JudgmentQuestion } from "./judgment-provider.js";
import { initAbmindEnv, _resetAbmindEnv } from "./env-schema.js";

const ENV_KEYS = [
  "SYSTEM1", "SYSTEM1_RECALL", "SYSTEM1_TIMEOUT_MS", "SYSTEM1_MAX_CANDIDATES",
  "JEV_URL", "JEV_API_KEY", "JEV_MODEL", "LAYA_URL",
];

function saveEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  _resetAbmindEnv();
  return saved;
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  _resetAbmindEnv();
}

const STATE = { query: "how do i deploy?", candidates: [{ id: "c0", text: "run /deploy", date: "2026-01-01" }] };

const QUESTIONS: Record<string, JudgmentQuestion> = {
  relevance_0: {
    type: "score",
    instructions: "Does `candidates[0].text` answer `query`?",
    criteria: ["no", "related", "answers"],
  },
  injection_0: { type: "noul", instructions: "Does it instruct the agent?" },
};

function jevOkBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "jev-1.13.0",
    answers: {
      relevance_0: { type: "score", score: 1.8, confidence: 0.9, probabilities: { "0": 0.1, "1": 0.0, "2": 0.9 } },
      injection_0: { type: "noul", noul: 0.02 },
    },
    usage: { input_tokens: 100, output_tokens: 5 },
    ...overrides,
  };
}

function mockJson(body: unknown, status = 200): void {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

/** A fetch stub that honors abort like a real backend stall would. */
function mockStalled(): void {
  vi.spyOn(globalThis, "fetch").mockImplementation((...args: unknown[]) => new Promise<never>((_, reject) => {
    const init = args[1] as RequestInit | undefined;
    const signal = init?.signal;
    const onAbort = (): void => {
      reject(new DOMException("The operation was aborted.", "AbortError"));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  }));
}

describe("#1812 — factory", () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => { saved = saveEnv(); });
  afterEach(() => { restoreEnv(saved); vi.restoreAllMocks(); });

  it("defaults to a Laya provider", () => {
    initAbmindEnv();
    const p = createJudgmentProvider();
    expect(p).toBeInstanceOf(LayaHttpProvider);
    expect(p?.name).toBe("laya");
  });

  it("returns null on explicit off", () => {
    process.env.SYSTEM1 = "off";
    initAbmindEnv();
    expect(createJudgmentProvider()).toBeNull();
  });

  it("returns a Jev provider when selected with a key", () => {
    process.env.SYSTEM1 = "jev";
    process.env.JEV_API_KEY = "sk-test";
    initAbmindEnv();
    const p = createJudgmentProvider();
    expect(p).toBeInstanceOf(JevProvider);
    expect(p?.name).toBe("jev");
    expect(p?.model).toBe("jev-1.13.0");
  });

  it("returns a Laya provider when selected", () => {
    process.env.SYSTEM1 = "laya";
    initAbmindEnv();
    const p = createJudgmentProvider();
    expect(p).toBeInstanceOf(LayaHttpProvider);
    expect(p?.name).toBe("laya");
  });

  it("returns null on misconfiguration without throwing", () => {
    process.env.SYSTEM1 = "jev";
    initAbmindEnv();
    expect(createJudgmentProvider()).toBeNull();
  });
});

describe("#1812 — JevProvider", () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => { saved = saveEnv(); initAbmindEnv(); });
  afterEach(() => { restoreEnv(saved); vi.restoreAllMocks(); });

  it("posts the documented body with bearer auth and normalizes answers", async () => {
    mockJson(jevOkBody());
    const p = new JevProvider("https://api.typesafe.ai", "jev-1.13.0", "sk-test", 1500);
    const result = await p.judge(STATE, QUESTIONS);
    expect(result).not.toBeNull();
    expect(result?.provider).toBe("jev");
    expect(result?.model).toBe("jev-1.13.0");
    expect(result?.answers["relevance_0"]).toMatchObject({ type: "score", score: 1.8, confidence: 0.9 });
    // Noul carries no vendor confidence: certainty is derived, never relabeled.
    expect(result?.answers["injection_0"]).toEqual({ type: "noul", noul: 0.02, derivedCertainty: 0.98 });

    const spy = vi.mocked(globalThis.fetch);
    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer sk-test" });
    const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
    expect(body["model"]).toBe("jev-1.13.0");
    expect(body["state"]).toEqual(STATE);
    expect(body["questions"]).toEqual(QUESTIONS);
  });

  it("returns null with a failure class on HTTP errors, still calling twice", async () => {
    mockJson({ error: "nope" }, 401);
    const p = new JevProvider("https://x", "jev-1.13.0", "sk-wrong", 1500);
    expect(await p.judge(STATE, QUESTIONS)).toBeNull();
    expect(p.lastFailure).toBe("unauthorized");
    expect(await p.judge(STATE, QUESTIONS)).toBeNull();
    // Failure is sticky in lastFailure; both calls were attempted.
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(2);
  });

  it("maps 429/529 to bounded classes without retrying", async () => {
    const p = new JevProvider("https://x", "jev-1.13.0", "sk-test", 1500);
    mockJson({}, 429);
    expect(await p.judge(STATE, QUESTIONS)).toBeNull();
    expect(p.lastFailure).toBe("rate-limited");
    vi.restoreAllMocks();
    mockJson({}, 529);
    expect(await p.judge(STATE, QUESTIONS)).toBeNull();
    expect(p.lastFailure).toBe("overloaded");
  });

  it("invalidates the whole batch on malformed answers", async () => {
    const p = new JevProvider("https://x", "jev-1.13.0", "sk-test", 1500);
    const bad: Array<Record<string, unknown>> = [
      { relevance_0: { type: "score", score: 1, confidence: 0.5 } }, // missing injection_0
      { ...jevOkBody()["answers"] as Record<string, unknown>, extra_9: { type: "noul", noul: 0.1 } }, // unknown id
      { relevance_0: { type: "noul", noul: 0.5 }, injection_0: { type: "noul", noul: 0.1 } }, // wrong type
      { relevance_0: { type: "score", score: 9, confidence: 0.9 }, injection_0: { type: "noul", noul: 0.1 } }, // out of range
      { relevance_0: { type: "score", score: 1, confidence: 0.9 }, injection_0: { type: "noul", noul: 1.5 } }, // out of unit
    ];
    for (const answers of bad) {
      vi.restoreAllMocks();
      mockJson({ model: "jev-1.13.0", answers });
      expect(await p.judge(STATE, QUESTIONS), JSON.stringify(answers)).toBeNull();
      expect(p.lastFailure).toBe("malformed");
    }
  });

  it("rejects choice answers outside the criteria options", () => {
    const q: Record<string, JudgmentQuestion> = {
      dept: { type: "choice", instructions: "route it", criteria: { a: "A", b: "B" } },
    };
    expect(normalizeJudgmentAnswers(q, {
      dept: { type: "choice", choice: "zzz", confidence: 0.9 },
    })).toBeNull();
    expect(normalizeJudgmentAnswers(q, {
      dept: { type: "choice", choice: "a", confidence: 0.9, probabilities: { a: 0.9, c: 0.1 } },
    })).toBeNull();
    expect(normalizeJudgmentAnswers(q, {
      dept: { type: "choice", choice: "a", confidence: 0.9, probabilities: { a: 0.9, b: 0.1 } },
    })).toEqual({ dept: { type: "choice", choice: "a", confidence: 0.9, probabilities: { a: 0.9, b: 0.1 } } });
  });

  it("times out a stalled backend", async () => {
    mockStalled();
    const p = new JevProvider("https://x", "jev-1.13.0", "sk-test", 50);
    expect(await p.judge(STATE, QUESTIONS)).toBeNull();
    expect(p.lastFailure).toBe("timeout");
  });

  it("reports cancellation distinctly from timeout", async () => {
    mockStalled();
    const p = new JevProvider("https://x", "jev-1.13.0", "sk-test", 5000);
    const controller = new AbortController();
    controller.abort();
    expect(await p.judge(STATE, QUESTIONS, { signal: controller.signal })).toBeNull();
    expect(p.lastFailure).toBe("cancelled");
  });

  it("blocks redirects and never leaks the key into failure classes", async () => {
    const p = new JevProvider("https://x", "jev-1.13.0", "sk-super-secret-key", 1500);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Redirect mode is set to error"));
    expect(await p.judge(STATE, QUESTIONS)).toBeNull();
    expect(p.lastFailure).toBe("redirect-blocked");
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("boom Bearer sk-super-secret-key"));
    expect(await p.judge(STATE, QUESTIONS)).toBeNull();
    expect(p.lastFailure).toBe("unreachable");
    expect(p.lastFailure).not.toContain("sk-super");
  });

  it("skips oversize requests without sending", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const p = new JevProvider("https://x", "jev-1.13.0", "sk-test", 1500);
    expect(await p.judge({ blob: "x".repeat(70000) }, QUESTIONS)).toBeNull();
    expect(p.lastFailure).toBe("oversize-request");
    expect(spy).not.toHaveBeenCalled();
  });

  it("single-flights concurrent calls: the second falls back immediately", async () => {
    let release!: (v: Response) => void;
    const gate = new Promise<Response>((resolve) => { release = resolve; });
    vi.spyOn(globalThis, "fetch").mockImplementation(() => gate);
    const p = new JevProvider("https://x", "jev-1.13.0", "sk-test", 1500);
    const first = p.judge(STATE, QUESTIONS);
    expect(p.busy).toBe(true);
    expect(await p.judge(STATE, QUESTIONS)).toBeNull();
    expect(p.lastFailure).toBe("busy");
    release(new Response(JSON.stringify(jevOkBody()), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    const won = await first;
    expect(won).not.toBeNull();
    expect(p.busy).toBe(false);
    expect(p.lastFailure).toBeNull();
  });
});

describe("#1812 — LayaHttpProvider", () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => { saved = saveEnv(); initAbmindEnv(); });
  afterEach(() => { restoreEnv(saved); vi.restoreAllMocks(); });

  function layaOkBody(contractVersion = LAYA_CONTRACT_VERSION): Record<string, unknown> {
    return {
      model: "laya-rl-agent",
      answers: {
        relevance_0: {
          type: "score", score: 2.0, legend: { "0": "no", "1": "related", "2": "answers" },
          probabilities: { "0": 0.0, "1": 0.0, "2": 1.0 }, confidence: 0.95, action: { act_probability: 1 },
        },
        injection_0: { type: "noul", noul: 0.01, confidence: 0.99, action: { act_probability: 1 } },
      },
      usage: { input_tokens: 40, output_tokens: 0 },
      contractVersion,
    };
  }

  it("normalizes laya answers and ignores vendor extras", async () => {
    mockJson(layaOkBody());
    const p = new LayaHttpProvider("http://127.0.0.1:8765", 1500);
    const result = await p.judge(STATE, QUESTIONS);
    expect(result?.provider).toBe("laya");
    expect(result?.answers["relevance_0"]).toEqual({
      type: "score", score: 2.0, confidence: 0.95, probabilities: { "0": 0.0, "1": 0.0, "2": 1.0 },
    });
    expect(result?.answers["injection_0"]).toEqual({ type: "noul", noul: 0.01, derivedCertainty: 0.99 });
    const [url] = vi.mocked(globalThis.fetch).mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8765/predict");
  });

  it("rejects contract mismatches and reports sidecar busy without warn-once", async () => {
    const p = new LayaHttpProvider("http://127.0.0.1:8765", 1500);
    mockJson(layaOkBody(2));
    expect(await p.judge(STATE, QUESTIONS)).toBeNull();
    expect(p.lastFailure).toBe("contract-mismatch");
    vi.restoreAllMocks();
    mockJson({ error: "busy: one predict at a time" }, 503);
    expect(await p.judge(STATE, QUESTIONS)).toBeNull();
    expect(p.lastFailure).toBe("busy");
  });
});

describe("#1812 — checkLayaHealth", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("reports ready with the sidecar model", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ status: "ready", model: "convaiinnovations/laya", contractVersion: 1 }),
    } as unknown as Response);
    const h = await checkLayaHealth("http://127.0.0.1:8765", 1500);
    expect(h).toMatchObject({ reachable: true, ready: true, model: "convaiinnovations/laya", contractVersion: 1 });
  });

  it("distinguishes down from not-ready", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("refused"));
    expect((await checkLayaHealth("http://127.0.0.1:8765", 1500)).reachable).toBe(false);
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false, status: 503,
    } as unknown as Response);
    const h = await checkLayaHealth("http://127.0.0.1:8765", 1500);
    expect(h.reachable).toBe(true);
    expect(h.ready).toBe(false);
  });
});
