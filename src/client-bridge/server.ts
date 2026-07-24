import { createInterface } from "node:readline";
import type { AbmindClient } from "../abmind-client.js";
import { METHOD_REGISTRY, ABMIND_PROTOCOL_VERSION, isIdempotencyRequired } from "../abmind-protocol.js";
import {
  BRIDGE_LINE_MAX_BYTES, BRIDGE_MAX_CONCURRENT, BRIDGE_REQUEST_TIMEOUT_MS, BRIDGE_DRAIN_TIMEOUT_MS,
  type JsonRpcRequest, type JsonRpcResponse, type BridgeMethod, type AbmindCallParams,
} from "./protocol.js";

const BRIDGE_SUPPORTED_METHODS = new Set<BridgeMethod>(["bridge.status", "bridge.negotiate", "abmind.call", "bridge.close"]);
const TAG = "client-bridge";

export class ClientBridgeServer {
  private client: AbmindClient;
  private startTime = Date.now();
  private closed = false;
  private inFlight = 0;
  private transportName: string;

  constructor(client: AbmindClient, transportName: string) {
    this.client = client;
    this.transportName = transportName;
  }

  async run(): Promise<void> {
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
    const activeIds = new Set<string | number | null>();

    for await (const line of rl) {
      if (this.closed) break;

      if (Buffer.byteLength(line, "utf-8") > BRIDGE_LINE_MAX_BYTES) {
        this.writeError(null, -32700, "Line too large");
        continue;
      }

      let req: JsonRpcRequest;
      try {
        req = JSON.parse(line);
      } catch {
        this.writeError(null, -32700, "Parse error");
        continue;
      }

      if (!req.jsonrpc || req.jsonrpc !== "2.0") {
        this.writeError(req.id, -32600, "Invalid Request: must be JSON-RPC 2.0");
        continue;
      }

      if (req.id != null && activeIds.has(req.id)) {
        this.writeError(req.id, -32603, "Duplicate request ID");
        continue;
      }
      if (req.id != null) activeIds.add(req.id);

      this.handleRequest(req);
    }

    await this.drain();
  }

  private async handleRequest(req: JsonRpcRequest): Promise<void> {
    const method = req.method;

    if (!BRIDGE_SUPPORTED_METHODS.has(method as BridgeMethod)) {
      this.writeError(req.id, -32601, `Method not found: ${method}`);
      return;
    }

    if (method === "bridge.close") {
      this.closed = true;
      this.writeResult(req.id, { status: "closing" });
      return;
    }

    if (method === "bridge.status") {
      this.writeResult(req.id, { status: "running", transport: this.transportName, uptimeMs: Date.now() - this.startTime });
      return;
    }

    if (method === "bridge.negotiate") {
      try {
        const caps = await this.client.negotiate();
        this.writeResult(req.id, caps);
      } catch (err) {
        this.writeError(req.id, -32000, (err as Error).message);
      }
      return;
    }

    if (method === "abmind.call") {
      if (this.inFlight >= BRIDGE_MAX_CONCURRENT) {
        this.writeError(req.id, -32001, "Too many concurrent calls");
        return;
      }

      const params = req.params as AbmindCallParams | undefined;
      if (!params || !params.method) {
        this.writeError(req.id, -32602, "Missing method in params");
        return;
      }

      if (!(params.method in METHOD_REGISTRY)) {
        this.writeError(req.id, -32601, `Unsupported method: ${params.method}`);
        return;
      }

      this.inFlight++;
      try {
        const result = await this.client.callRaw(
          params.method, params.payload ?? {}, params.idempotencyKey,
        );
        this.writeResult(req.id, result);
      } catch (err) {
        const e = err as Error & { code?: string; current?: unknown };
        this.writeError(req.id, -32000, e.message, { code: e.code, current: e.current });
      } finally {
        this.inFlight--;
      }
      return;
    }
  }

  private async drain(): Promise<void> {
    const start = Date.now();
    while (this.inFlight > 0 && Date.now() - start < BRIDGE_DRAIN_TIMEOUT_MS) {
      await new Promise(r => setTimeout(r, 100));
    }
  }

  private writeResult(id: string | number | null, result: unknown): void {
    const resp: JsonRpcResponse = { jsonrpc: "2.0", id, result };
    process.stdout.write(JSON.stringify(resp) + "\n");
  }

  private writeError(id: string | number | null, code: number, message: string, data?: unknown): void {
    const resp: JsonRpcResponse = { jsonrpc: "2.0", id, error: { code, message, data } };
    process.stdout.write(JSON.stringify(resp) + "\n");
  }
}
