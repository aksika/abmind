/**
 * #1812 — System One judgment provider slot.
 *
 * Pluggable judgment backend behind one normalized interface. Pick via the
 * SYSTEM1 env selector (off | jev | laya); recall and diagnostics are the
 * consumers. Modeled on src/embedding-provider.ts: env-gated factory,
 * warn-once, null-on-failure, plain fetch, no new npm dependency.
 *
 * Two built-in providers:
 * - JevProvider: POST {url}/v1/systemone, body { model, state, questions }.
 * - LayaHttpProvider: POST {url}/predict, body { state, questions }, served
 *   by scripts/laya-server.py. Expects contractVersion 1.
 *
 * Execution bounds (product contracts, not harness conventions): one
 * in-flight request per instance (concurrent callers fall back immediately),
 * 64 KiB request cap, 256 KiB response cap, bounded timeout, redirects
 * rejected. Provider judgments are advice; combining code owns decisions.
 */

import { getAbmindEnv } from "./env-schema.js";
import { resolveSystem1Config } from "./system1-config.js";
import { logWarn, logDebug } from "./mem-logger.js";

const TAG = "system1";

/** Conservative local caps: not claims about vendor token limits. */
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
/** Error bodies are read only for failure classification. */
const MAX_ERROR_SNIPPET_BYTES = 4096;

export const LAYA_CONTRACT_VERSION = 1;

export type JudgmentType = "choice" | "score" | "noul";

export interface JudgmentQuestion {
  type: JudgmentType;
  instructions: string | Record<string, unknown>;
  criteria?: Record<string, string> | string[] | null;
}

export type JudgmentAnswer =
  | { type: "choice"; choice: string; confidence: number; probabilities?: Record<string, number> }
  | { type: "score"; score: number; confidence: number; probabilities?: Record<string, number> }
  | { type: "noul"; noul: number; derivedCertainty: number };

export type JudgmentAnswers = Record<string, JudgmentAnswer>;

/** Sanitized failure classes; callers branch on these, never on raw errors. */
export type JudgmentFailure =
  | "unreachable" | "timeout" | "cancelled" | "redirect-blocked"
  | "oversize-request" | "oversize-response" | "malformed" | "busy"
  | "contract-mismatch" | "unauthorized" | "rejected (422)"
  | "rate-limited" | "overloaded"
  | `http-${number}`;

export interface JudgmentResult {
  answers: JudgmentAnswers;
  provider: string;
  model: string;
  latencyMs: number;
}

export interface JudgeOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface IJudgmentProvider {
  readonly name: string;
  readonly model: string;
  /** Judge typed questions over a state. Null = no usable judgment; never throws. */
  judge(
    state: Record<string, unknown>,
    questions: Record<string, JudgmentQuestion>,
    opts?: JudgeOptions,
  ): Promise<JudgmentResult | null>;
  /** True while a request is in flight (single-flight slot, no queue). */
  readonly busy: boolean;
  /** Sanitized failure class of the most recent failed call, else null. */
  readonly lastFailure: JudgmentFailure | null;
}

// ── Answer normalization ────────────────────────────────────────────────
// Ingress from two vendors starts as unknown; every expected answer ID,
// type, range, finite value, and Choice/Score option is validated against
// its question. One bad answer invalidates the whole batch — a partial
// rerank is worse than none.

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function inUnit(v: unknown): v is number {
  return isFiniteNumber(v) && v >= 0 && v <= 1;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validateQuestion(id: string, q: JudgmentQuestion): string | null {
  if (q.type !== "choice" && q.type !== "score" && q.type !== "noul") {
    return `question ${id} has unknown type`;
  }
  const ins = q.instructions as unknown;
  if (typeof ins !== "string" && (typeof ins !== "object" || ins === null)) {
    return `question ${id} has unusable instructions`;
  }
  if (q.type === "choice") {
    if (!isRecord(q.criteria) || Object.keys(q.criteria).length === 0) {
      return `choice question ${id} needs a non-empty criteria map`;
    }
  }
  if (q.type === "score") {
    if (!Array.isArray(q.criteria) || q.criteria.length < 2 || q.criteria.length > 10) {
      return `score question ${id} needs 2-10 ordered levels`;
    }
  }
  return null;
}

function normalizeAnswer(
  id: string,
  q: JudgmentQuestion,
  raw: unknown,
): JudgmentAnswer | null {
  if (!isRecord(raw) || raw["type"] !== q.type) return null;
  if (q.type === "choice") {
    const options = Object.keys(q.criteria as Record<string, string>);
    const choice = raw["choice"];
    const confidence = raw["confidence"];
    if (typeof choice !== "string" || !options.includes(choice)) return null;
    if (!inUnit(confidence)) return null;
    const probs = raw["probabilities"];
    if (probs !== undefined) {
      if (!isRecord(probs)) return null;
      for (const [k, v] of Object.entries(probs)) {
        if (!options.includes(k) || !isFiniteNumber(v)) return null;
      }
    }
    return {
      type: "choice", choice, confidence,
      ...(probs !== undefined ? { probabilities: probs as Record<string, number> } : {}),
    };
  }
  if (q.type === "score") {
    const levels = (q.criteria as string[]).length;
    const score = raw["score"];
    const confidence = raw["confidence"];
    if (!isFiniteNumber(score) || score < 0 || score > levels - 1) return null;
    if (!inUnit(confidence)) return null;
    const probs = raw["probabilities"];
    if (probs !== undefined) {
      if (!isRecord(probs)) return null;
      for (const [k, v] of Object.entries(probs)) {
        const idx = Number(k);
        if (!Number.isInteger(idx) || idx < 0 || idx >= levels || !isFiniteNumber(v)) return null;
      }
    }
    return {
      type: "score", score, confidence,
      ...(probs !== undefined ? { probabilities: probs as Record<string, number> } : {}),
    };
  }
  // noul — vendors differ: Jev sends no confidence, Laya sends its own.
  // derivedCertainty = max(p, 1-p) is computed, never relabeled as vendor
  // confidence; score-side confidence thresholds must not use it.
  const p = raw["noul"];
  if (!inUnit(p)) return null;
  return { type: "noul", noul: p, derivedCertainty: Math.round(Math.max(p, 1 - p) * 1e4) / 1e4 };
}

/** Normalize a vendor answers map; null invalidates the whole batch. */
export function normalizeJudgmentAnswers(
  questions: Record<string, JudgmentQuestion>,
  rawAnswers: unknown,
): JudgmentAnswers | null {
  const ids = Object.keys(questions);
  if (ids.length === 0 || !isRecord(rawAnswers)) return null;
  const rawIds = Object.keys(rawAnswers);
  if (rawIds.length !== ids.length) return null;
  const out: JudgmentAnswers = {};
  for (const id of ids) {
    const q = questions[id]!;
    const bad = validateQuestion(id, q);
    if (bad) return null;
    if (!(id in rawAnswers)) return null;
    const ans = normalizeAnswer(id, q, rawAnswers[id]);
    if (!ans) return null;
    out[id] = ans;
  }
  return out;
}

// ── Shared HTTP base ────────────────────────────────────────────────────

function classifyHttpStatus(status: number): JudgmentFailure {
  if (status === 401) return "unauthorized";
  if (status === 422) return "rejected (422)";
  if (status === 429) return "rate-limited";
  if (status === 529) return "overloaded";
  return `http-${status}`;
}

function maskKey(message: string, apiKey: string): string {
  if (!apiKey || apiKey.length < 8) return message;
  return message.split(apiKey).join("***");
}

/** Distinguish a caller cancellation from our own timeout. */
function abortReason(combined: AbortSignal, signal: AbortSignal | undefined): JudgmentFailure {
  const reasonName = (combined.reason as { name?: string } | undefined)?.name;
  return signal?.aborted && reasonName !== "TimeoutError" ? "cancelled" : "timeout";
}

abstract class BaseJudgmentProvider implements IJudgmentProvider {
  abstract readonly name: string;
  abstract readonly model: string;
  abstract judge(
    state: Record<string, unknown>,
    questions: Record<string, JudgmentQuestion>,
    opts?: JudgeOptions,
  ): Promise<JudgmentResult | null>;
  busy = false;
  lastFailure: JudgmentFailure | null = null;
  protected warnedOnce = false;

  protected fail(reason: JudgmentFailure): null {
    this.lastFailure = reason;
    if (!this.warnedOnce) {
      this.warnedOnce = true;
      logWarn(TAG, `${this.name} unavailable — judgments disabled: ${reason}`);
    } else {
      logDebug(TAG, `${this.name} unavailable: ${reason}`);
    }
    return null;
  }

  protected acquireSlot(): boolean {
    if (this.busy) {
      this.lastFailure = "busy";
      return false;
    }
    this.busy = true;
    return true;
  }

  protected releaseSlot(): void {
    this.busy = false;
  }

  /** POST JSON with bounds; returns parsed JSON or a classified failure. */
  protected async postJson(
    url: string,
    body: Record<string, unknown>,
    headers: Record<string, string>,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    apiKey: string,
  ): Promise<
    | { ok: true; json: unknown; ms: number }
    | { ok: false; reason: JudgmentFailure; status?: number; bodyText?: string }
  > {
    const encoded = JSON.stringify(body);
    if (Buffer.byteLength(encoded, "utf8") > MAX_REQUEST_BYTES) {
      return { ok: false, reason: "oversize-request" };
    }
    const t0 = Date.now();
    const combined = signal
      ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal])
      : AbortSignal.timeout(timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: encoded,
        signal: combined,
        redirect: "error",
      });
    } catch (err) {
      const msg = maskKey(err instanceof Error ? err.message : String(err), apiKey);
      if (/redirect/i.test(msg)) return { ok: false, reason: "redirect-blocked" };
      if (combined.aborted) return { ok: false, reason: abortReason(combined, signal) };
      return { ok: false, reason: "unreachable" };
    }
    if (!res.ok) {
      const snippet = await readErrorSnippet(res);
      return {
        ok: false,
        reason: classifyHttpStatus(res.status),
        status: res.status,
        ...(snippet === null ? {} : { bodyText: snippet }),
      };
    }
    const declared = res.headers.get("content-length");
    if (declared !== null && Number(declared) > MAX_RESPONSE_BYTES) {
      return { ok: false, reason: "oversize-response" };
    }
    let text: string | null;
    try {
      text = await readBoundedBody(res, MAX_RESPONSE_BYTES);
    } catch {
      // Body read failed or was aborted mid-stream — stay on baseline.
      return { ok: false, reason: combined.aborted ? abortReason(combined, signal) : "unreachable" };
    }
    if (text === null) return { ok: false, reason: "oversize-response" };
    try {
      const ms = Date.now() - t0;
      return { ok: true, json: JSON.parse(text) as unknown, ms };
    } catch {
      // Malformed body from a 2xx — untrusted input, not a crash.
      return { ok: false, reason: "malformed" };
    }
  }
}

/**
 * Read a response body with a hard byte cap. Returns null as soon as the cap
 * is exceeded instead of buffering the whole body: an oversize or stalled
 * endpoint must not be able to grow memory before the timeout fires.
 */
async function readBoundedBody(res: Response, maxBytes: number): Promise<string | null> {
  const reader = res.body?.getReader();
  if (!reader) {
    const text = await res.text();
    return Buffer.byteLength(text, "utf8") <= maxBytes ? text : null;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.length;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // Reader already closed or cancelled.
      }
      return null;
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(merged);
}

// ── Jev ─────────────────────────────────────────────────────────────────

/** Read a bounded prefix of a response body for failure classification. */
async function readErrorSnippet(res: Response): Promise<string | null> {
  try {
    return await readBoundedBody(res, MAX_ERROR_SNIPPET_BYTES);
  } catch {
    // Unreadable error body — classify by status alone.
    return null;
  }
}

export class JevProvider extends BaseJudgmentProvider {
  readonly name = "jev";
  readonly model: string;

  constructor(
    private url: string,
    model: string,
    private apiKey: string,
    private timeoutMs: number,
  ) {
    super();
    this.model = model;
  }

  async judge(
    state: Record<string, unknown>,
    questions: Record<string, JudgmentQuestion>,
    opts?: JudgeOptions,
  ): Promise<JudgmentResult | null> {
    if (!this.acquireSlot()) return null;
    try {
      const endpoint = `${this.url.replace(/\/+$/, "")}/v1/systemone`;
      const sent = await this.postJson(
        endpoint,
        { model: this.model, state, questions },
        { Authorization: `Bearer ${this.apiKey}` },
        opts?.timeoutMs ?? this.timeoutMs,
        opts?.signal,
        this.apiKey,
      );
      if (!sent.ok) return this.fail(sent.reason);
      const answers = normalizeJudgmentAnswers(questions, (sent.json as Record<string, unknown>)["answers"]);
      if (!answers) return this.fail("malformed");
      this.lastFailure = null;
      const returnedModel = (sent.json as Record<string, unknown>)["model"];
      logDebug(TAG, `jev ${this.model} judged ${Object.keys(questions).length}q in ${sent.ms}ms`);
      return {
        answers,
        provider: this.name,
        model: typeof returnedModel === "string" ? returnedModel : this.model,
        latencyMs: sent.ms,
      };
    } finally {
      this.releaseSlot();
    }
  }
}

// ── Laya (local sidecar) ────────────────────────────────────────────────

/** Sanitized health failure classes; doctor reports them as distinct warnings. */
export type LayaHealthError =
  | "warming" | "malformed" | "oversize" | "contract-mismatch"
  | "timeout" | "unreachable"
  | `http-${number}`;

export interface LayaHealth {
  reachable: boolean;
  ready: boolean;
  model: string;
  contractVersion: number;
  latencyMs: number;
  error?: LayaHealthError;
}

/** Probe the sidecar health endpoint. Free: no inference, no weights touched. */
export async function checkLayaHealth(url: string, timeoutMs: number): Promise<LayaHealth> {
  const t0 = Date.now();
  const endpoint = `${url.replace(/\/+$/, "")}/health`;
  const failed = (error: LayaHealthError, reachable: boolean): LayaHealth =>
    ({ reachable, ready: false, model: "", contractVersion: 0, latencyMs: Date.now() - t0, error });
  try {
    const res = await fetch(endpoint, { signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
    if (!res.ok) {
      // The shipped sidecar serves 503 while the checkpoint preloads.
      return failed(res.status === 503 ? "warming" : `http-${res.status}`, true);
    }
    const text = await readBoundedBody(res, MAX_RESPONSE_BYTES);
    if (text === null) return failed("oversize", true);
    let data: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (!isRecord(parsed)) throw new Error("health payload is not an object");
      data = parsed;
    } catch {
      // Reachable endpoint with an unusable payload — distinct from down.
      return failed("malformed", true);
    }
    const model = typeof data["model"] === "string" ? data["model"] : "";
    const contractVersion = typeof data["contractVersion"] === "number" ? data["contractVersion"] : 0;
    const withIdentity = (health: LayaHealth): LayaHealth => ({ ...health, model, contractVersion });
    if (data["status"] !== "ready") return withIdentity(failed("warming", true));
    if (contractVersion !== LAYA_CONTRACT_VERSION) return withIdentity(failed("contract-mismatch", true));
    if (model === "") return withIdentity(failed("malformed", true));
    return { reachable: true, ready: true, model, contractVersion: LAYA_CONTRACT_VERSION, latencyMs: Date.now() - t0 };
  } catch (err) {
    const reason: LayaHealthError = err instanceof Error && err.name === "AbortError" ? "timeout" : "unreachable";
    return failed(reason, false);
  }
}

export class LayaHttpProvider extends BaseJudgmentProvider {
  readonly name = "laya";
  readonly model = "laya-sidecar";

  constructor(
    private url: string,
    private timeoutMs: number,
  ) {
    super();
  }

  async judge(
    state: Record<string, unknown>,
    questions: Record<string, JudgmentQuestion>,
    opts?: JudgeOptions,
  ): Promise<JudgmentResult | null> {
    if (!this.acquireSlot()) return null;
    try {
      const endpoint = `${this.url.replace(/\/+$/, "")}/predict`;
      const sent = await this.postJson(
        endpoint,
        { state, questions },
        {},
        opts?.timeoutMs ?? this.timeoutMs,
        opts?.signal,
        "",
      );
      if (!sent.ok) {
        if (sent.status === 503 && (sent.bodyText ?? "").includes("busy")) {
          // Single local inference slot is occupied — routine under
          // concurrency, not an endpoint failure; no warn-once.
          this.lastFailure = "busy";
          logDebug(TAG, "laya sidecar busy — baseline kept");
          return null;
        }
        return this.fail(sent.reason);
      }
      const payload = sent.json as Record<string, unknown>;
      if (payload["contractVersion"] !== LAYA_CONTRACT_VERSION) return this.fail("contract-mismatch");
      const answers = normalizeJudgmentAnswers(questions, payload["answers"]);
      if (!answers) return this.fail("malformed");
      this.lastFailure = null;
      const returnedModel = payload["model"];
      logDebug(TAG, `laya judged ${Object.keys(questions).length}q in ${sent.ms}ms`);
      return {
        answers,
        provider: this.name,
        model: typeof returnedModel === "string" ? returnedModel : this.model,
        latencyMs: sent.ms,
      };
    } finally {
      this.releaseSlot();
    }
  }
}

// ── Factory ─────────────────────────────────────────────────────────────

/** Create the configured judgment provider, or null when disabled/misconfigured. */
export function createJudgmentProvider(): IJudgmentProvider | null {
  const env = getAbmindEnv();
  const cfg = resolveSystem1Config(env);
  if (cfg.state === "off") {
    logDebug(TAG, "system1: disabled");
    return null;
  }
  if (cfg.state === "invalid") {
    logWarn(TAG, `system1 misconfigured — ${cfg.reason}`);
    return null;
  }
  if (cfg.backend === "jev") {
    return new JevProvider(cfg.url, cfg.model, env.jevApiKey, cfg.timeoutMs);
  }
  return new LayaHttpProvider(cfg.url, cfg.timeoutMs);
}
