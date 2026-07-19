import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { MemoryConfig } from "./memory-config.js";
import { MemoryManager } from "./memory-manager.js";
import { ensureInitialized } from "./ensure-initialized.js";
import { AbmindService } from "./abmind-service.js";
import type { ServiceCallContext, DomainName } from "./abmind-protocol.js";
import { createOwnerLease, createProcessIdentityProvider, cleanTombstones, getCanonicalLeaseDir, type OwnerLease, type ProcessIdentityProvider } from "./abmind-owner-lease.js";
import { EmbeddedTransport } from "./embedded-transport.js";
import { AbmindClient } from "./abmind-client.js";
import { logError, logInfo } from "./mem-logger.js";

export interface AbmindOwnerConfig {
  mode: "embedded" | "daemon";
  memory: MemoryConfig;
  policy: AbmindServicePolicy;
  processIdentity?: ProcessIdentityProvider;
}

export interface AbmindServicePolicy {
  principalId: string;
  role: "local_user" | "host_agent" | "service" | "peer";
  grantedDomains: DomainName[];
  authenticatedBy: "embedded" | "local_peer" | "signed_peer";
}

export interface EmbeddedCaller {
  principalId: string;
  role: "local_user" | "host_agent" | "service" | "peer";
}

export interface EmbeddedAbmind {
  host: AbmindServiceHost;
  client: AbmindClient;
}

const TAG = "abmind-host";

export class AbmindServiceHost {
  private lease_: OwnerLease | null = null;
  private manager_: MemoryManager | null = null;
  private service_: AbmindService | null = null;
  private dbPath_: string | null = null;
  private config_: AbmindOwnerConfig;
  private started_ = false;
  private stopped_ = false;

  constructor(config: AbmindOwnerConfig) {
    this.config_ = config;
  }

  get started(): boolean { return this.started_; }
  get manager(): MemoryManager | null { return this.manager_; }
  get service(): AbmindService | null { return this.service_; }

  async start(): Promise<void> {
    if (this.started_) return;
    cleanTombstones(getCanonicalLeaseDir());

    let lease: OwnerLease | null = null;
    try {
      const processIdentity = this.config_.processIdentity ?? createProcessIdentityProvider();
      const dbPath = join(this.config_.memory.memoryDir, "memory.db");
      this.dbPath_ = dbPath;

      mkdirSync(this.config_.memory.memoryDir, { recursive: true });

      lease = await createOwnerLease({
        runRoot: this.config_.memory.memoryDir,
        databasePath: dbPath,
        mode: this.config_.mode,
        processIdentity,
      });
      await lease.acquire();

      const manager = new MemoryManager(this.config_.memory);
      await manager.initialize();
      this.manager_ = manager;

      const db = manager.getDatabase();

      ensureInitialized(db!, this.config_.memory.memoryDir);

      const serverInstanceId = lease.instanceId;
      const service = new AbmindService({
        serverInstanceId,
        mode: this.config_.mode,
        manager,
        operational: manager.operational,
        requestLedgerDb: db,
      });
      this.service_ = service;

      if (service.ledger) {
        service.ledger.cleanup();
        service.ledger.recoverCrashed();
      }

      this.lease_ = lease;
      this.started_ = true;
      logInfo(TAG, `AbmindServiceHost started (${this.config_.mode}, instance=${serverInstanceId})`);
    } catch (err) {
      logError(TAG, "AbmindServiceHost start failed", err);
      try { lease?.release(); } catch { /* best effort */ }
      try { this.manager_?.close(); } catch { /* best effort */ }
      this.manager_ = null;
      this.service_ = null;
      this.lease_ = null;
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (this.stopped_) return;
    this.stopped_ = true;
    this.started_ = false;

    const svc = this.service_;
    svc?.close();
    await svc?.drain(30_000);

    try {
      this.manager_?.close();
    } catch (err) {
      logError(TAG, "Error closing memory manager", err);
    }
    this.manager_ = null;
    this.service_ = null;

    try {
      await this.lease_?.release();
    } catch (err) {
      logError(TAG, "Error releasing owner lease", err);
    }
    this.lease_ = null;
  }
}

export function createAbmindClient(transport: EmbeddedTransport): AbmindClient {
  return new AbmindClient(transport);
}

export async function createEmbeddedAbmind(
  config: AbmindOwnerConfig,
  caller: EmbeddedCaller,
): Promise<EmbeddedAbmind> {
  const host = new AbmindServiceHost(config);
  await host.start();

  const effectivePolicy: AbmindServicePolicy = config.policy ?? {
    principalId: caller.principalId,
    role: caller.role,
    grantedDomains: ["system", "private", "operational"],
    authenticatedBy: "embedded",
  };

  const context: ServiceCallContext = {
    principalId: effectivePolicy.principalId,
    role: effectivePolicy.role,
    grantedDomains: new Set(effectivePolicy.grantedDomains),
    authenticatedBy: effectivePolicy.authenticatedBy,
  };

  const transport = new EmbeddedTransport(host.service!, context);
  const client = new AbmindClient(transport);

  return { host, client };
}
