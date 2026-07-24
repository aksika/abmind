export const BRIDGE_LINE_MAX_BYTES = 1_000_000;
export const BRIDGE_MAX_CONCURRENT = 16;
export const BRIDGE_REQUEST_TIMEOUT_MS = 120_000;
export const BRIDGE_DRAIN_TIMEOUT_MS = 30_000;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type BridgeMethod = "bridge.status" | "bridge.negotiate" | "abmind.call" | "bridge.close";

export interface AbmindCallParams {
  method: string;
  payload: unknown;
  idempotencyKey?: string;
  context?: { sessionId?: string; origin?: string };
}

export interface BridgeStatusResult {
  status: "running" | "closed";
  transport: string;
  uptimeMs: number;
}
