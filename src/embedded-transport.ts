import type { AbmindMethod, AbmindRequestV1, AbmindResponseV1, AbmindCapabilitiesV1, AbmindTransport, ServiceCallContext } from "./abmind-protocol.js";
import { ABMIND_PROTOCOL_VERSION, errorBodyV1 } from "./abmind-protocol.js";
import type { AbmindService } from "./abmind-service.js";

export class EmbeddedTransport implements AbmindTransport {
  private service: AbmindService;
  private context: ServiceCallContext;
  private closed = false;

  constructor(service: AbmindService, context: ServiceCallContext) {
    this.service = service;
    this.context = context;
  }

  async negotiate(): Promise<AbmindCapabilitiesV1> {
    const response = await this.service.handle(
      { version: ABMIND_PROTOCOL_VERSION, requestId: "negotiate", method: "system.negotiate", payload: {} },
      this.context,
    );
    if (response.ok) return response.result as AbmindCapabilitiesV1;
    throw new Error(`Negotiation failed: ${response.error.message}`);
  }

  async request<K extends AbmindMethod>(req: AbmindRequestV1<K>): Promise<AbmindResponseV1<K>> {
    if (this.closed) {
      return { ok: false, requestId: req.requestId, error: errorBodyV1("unavailable", "Transport is closed", "pre_dispatch") } as AbmindResponseV1<K>;
    }
    return await this.service.handle(req, this.context);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
