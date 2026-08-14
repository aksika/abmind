import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync, chmodSync, existsSync, readFileSync, symlinkSync } from "node:fs";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { join, resolve, relative, isAbsolute } from "node:path";
import { tmpdir, homedir } from "node:os";
import { randomUUID, createHash, generateKeyPairSync } from "node:crypto";
import { AbmindClient } from "../../src/index.js";
import { SignedWssTransport } from "../../src/remote/signed-wss-transport.js";
import { RequestOutbox } from "../../src/remote/index.js";
import type { AbmindTransport } from "../../src/abmind-protocol.js";
import type { AcceptanceFixture, PromoteMemoryInput } from "./contracts.js";
import { seedSleepPrompts } from "./scenario-helpers.js";

const COMPILED_ROOT = resolve(import.meta.dirname, "../..");
const REPOSITORY_ROOT = resolve(COMPILED_ROOT, "..");
const DAEMON_ENTRY = resolve(COMPILED_ROOT, "cli/abmind-daemon.js");
const READINESS_POLL_MS = 200;
const READINESS_DEADLINE_MS = 20_000;
const GRACE_PERIOD_MS = 5_000;
const STREAM_BOUND = 512 * 1024;

const CHILD_ENV_ALLOWLIST = new Set([
  "PATH", "NODE_PATH", "PATHEXT", "SystemRoot", "WINDIR",
  "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH",
  "LANG", "LC_ALL", "LC_CTYPE", "TZ", "CI", "TERM",
]);

/** Peer identities created by the fixture. */
const USER_A_PEER = "user-a";
const USER_B_PEER = "user-b";
const NO_CASCADE_PEER = "no-cascade";

const PRINCIPAL_USER_A = "e2e-user-a";
const PRINCIPAL_USER_B = "e2e-user-b";
const PRINCIPAL_NO_CASCADE = "no-cascade-principal";

/** Methods exercised by the shared acceptance matrix. */
const MATRIX_METHODS = [
  "system.negotiate", "system.health", "system.status", "system.capabilities",
  "private.instantStore", "private.edit", "private.reclassify",
  "private.adjustRelevance", "private.merge", "private.recall",
  "private.recordMessage", "private.getRecentConversation",
  "private.assembleSessionContext", "private.getRuntimeStatus",
  "private.getCoreKnowledge", "private.recordFeedback", "private.embed",
  "private.rebuildFts", "private.projectConversationContext",
  "private.dreamQuestions.nextPending", "private.dreamQuestions.list",
  "private.dreamQuestions.markAsked", "private.dreamQuestions.dismiss",
];

/** Methods that need the cascade grant. */
const CASCADE_METHODS = ["private.cascadeDelete"];

/** Sleep service methods required by the Sleep/Dreamy journey. */
const SLEEP_METHODS = [
  "sleep.start", "sleep.status", "sleep.events", "sleep.resume", "sleep.cancel",
  "sleep.runtime.open", "sleep.runtime.next", "sleep.runtime.complete",
  "sleep.runtime.fail", "sleep.runtime.close",
];

/** Sleep runtime capability gates required by the Sleep/Dreamy journey. */
const SLEEP_CAPABILITIES = [
  "sleep_start", "sleep_status", "sleep_events", "sleep_runtime_provider",
  "rebuild_fts",
];

/** Methods for a peer that intentionally lacks the cascade grant. */
const NO_CASCADE_METHODS = [
  "system.negotiate", "system.health", "system.status",
  "private.recordMessage", "private.getRecentConversation",
];

function generateRunId(): string {
  return `e2e-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

function buildChildEnv(fixtureRoot: string, remoteDir: string, homeDir: string, memoryDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of CHILD_ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.HOME = homeDir;
  env.USERPROFILE = homeDir;
  env.ABMIND_HOME = join(homeDir, ".abmind");
  env.XDG_CONFIG_HOME = join(homeDir, ".config");
  env.XDG_CACHE_HOME = join(homeDir, ".cache");
  env.XDG_STATE_HOME = join(homeDir, ".local", "state");
  env.MEMORY_DIR = memoryDir;
  env.ABMIND_REMOTE_DIR = remoteDir;
  env.EMBEDDING_ENABLED = "false";
  env.NODE_ENV = "test";
  env.ABMIND_USER = "e2e-daemon";
  // #1608: sleep requires the canonical primary-user identity. The daemon
  // child must carry ABMIND_USER_ID (ABMIND_USER alone is not enough), or the
  // Sleep/Dreamy acceptance scenario fails before any step runs.
  env.ABMIND_USER_ID = "e2e-user-a";
  return env;
}

export class RemoteWssFixture implements AcceptanceFixture {
  readonly transport = "remote-wss" as const;
  readonly grantEnforcement = true;
  readonly root: string;
  readonly runId: string;
  readonly remoteDir: string;
  readonly memoryDir: string;
  readonly abmindHome: string;
  readonly abmindRoot: string;
  readonly homeDir: string;

  private child: ChildProcess | null = null;
  private clients: AbmindClient[] = [];
  private stdoutPath = "";
  private stderrPath = "";
  private stdoutBuf = "";
  private stderrBuf = "";
  private stdoutLen = 0;
  private stderrLen = 0;
  private usedSigkill = false;
  private childExitCode: number | null = null;
  private childSignal: string | null = null;
  private requestIds: string[] = [];
  private peerKeys = new Map<string, string>();

  private port = 0;
  private pin = "";

  /** Loopback port the daemon WSS endpoint listens on (set at startOwner). */
  get endpointPort(): number { return this.port; }

  /** SHA-256 DER certificate pin for the generated endpoint. */
  get certificatePin(): string { return this.pin; }

  /** Absolute path to a peer's generated Ed25519 signing key (never its contents). */
  peerSigningKeyPath(peerId: string): string {
    const p = this.peerKeys.get(peerId);
    if (!p) throw new Error(`Unknown peer ${peerId}`);
    return p;
  }

  /** Peer id bound to the primary acceptance principal (e2e-user-a). */
  get userAPeerId(): string { return USER_A_PEER; }

  constructor() {
    this.runId = generateRunId();
    this.root = mkdtempSync(join(tmpdir(), `abmind-e2e-wss-${this.runId}-`));
    chmodSync(this.root, 0o700);
    this.homeDir = join(this.root, "home");
    const xdgConfig = join(this.homeDir, ".config");
    const xdgCache = join(this.homeDir, ".cache");
    const xdgState = join(this.homeDir, ".local", "state");
    this.abmindHome = join(this.homeDir, ".abmind");
    this.memoryDir = join(this.root, "memory");
    this.remoteDir = join(this.root, "remote");
    this.abmindRoot = REPOSITORY_ROOT;

    for (const dir of [this.homeDir, this.abmindHome, join(this.abmindHome, "config"),
      xdgConfig, xdgCache, xdgState,
      this.memoryDir, this.remoteDir]) {
      mkdirSync(dir, { recursive: true });
      chmodSync(dir, 0o700);
    }

    writeFileSync(join(this.abmindHome, "config", "users.json"), JSON.stringify({
      users: [{ userId: "e2e-user-a", role: "master" }, { userId: "e2e-user-b", role: "user" }],
    }));
    chmodSync(join(this.abmindHome, "config", "users.json"), 0o600);

    seedSleepPrompts(this.abmindRoot, this.abmindHome);

    const sharedNativeDeps = join(homedir(), ".local", "lib", "node_modules");
    if (existsSync(sharedNativeDeps)) {
      const localNativeParent = join(this.homeDir, ".local", "lib");
      mkdirSync(localNativeParent, { recursive: true });
      try { symlinkSync(sharedNativeDeps, join(localNativeParent, "node_modules"), "dir"); } catch { /* existing link */ }
    }

    this.stdoutPath = join(this.root, "run", "daemon.stdout.log");
    this.stderrPath = join(this.root, "run", "daemon.stderr.log");

    this.generateTlsAndPeers();
  }

  // ── Disposable material generation ───────────────────────────────────────

  private generateTlsAndPeers(): void {
    const keyPath = join(this.root, "tls-key.pem");
    const certPath = join(this.root, "tls-cert.pem");
    execSync(
      `openssl req -x509 -newkey ed25519 -nodes -keyout ${keyPath} -out ${certPath} -subj /CN=localhost -days 1 -addext subjectAltName=DNS:localhost,IP:127.0.0.1`,
      { stdio: "ignore" },
    );
    chmodSync(keyPath, 0o600);
    chmodSync(certPath, 0o600);
    const der = execSync(`openssl x509 -in ${certPath} -outform DER`) as Buffer;
    this.pin = createHash("sha256").update(der).digest("hex");

    for (const peerId of [USER_A_PEER, USER_B_PEER, NO_CASCADE_PEER]) {
      const kp = generateKeyPairSync("ed25519");
      const keyPathForPeer = join(this.root, `${peerId}-ed25519.pem`);
      writeFileSync(keyPathForPeer, kp.privateKey.export({ type: "pkcs8", format: "pem" }));
      chmodSync(keyPathForPeer, 0o600);
      this.peerKeys.set(peerId, keyPathForPeer);
      this.writeRestricted(join(this.root, `${peerId}-verify.pem`),
        kp.publicKey.export({ type: "spki", format: "pem" }).toString().trim());
    }
  }

  /** Reserve an ephemeral loopback port before writing daemon config. */
  private reservePort(): number {
    const out = execSync(
      `node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>console.log(p));})"`,
      { encoding: "utf-8", timeout: 10_000 },
    );
    return Number(out.trim());
  }

  private writeRestricted(p: string, data: string): void {
    writeFileSync(p, data);
    chmodSync(p, 0o600);
  }

  private writeDaemonConfig(): void {
    const enrollments = [USER_A_PEER, USER_B_PEER, NO_CASCADE_PEER].map(peerId => ({
      peerId,
      verifyKey: readFileSync(join(this.root, `${peerId}-verify.pem`), "utf-8").trim(),
      enrolledAt: new Date().toISOString(),
    }));
    const grants = [
      {
        peerId: USER_A_PEER, principalId: PRINCIPAL_USER_A,
        domains: ["system", "private", "sleep"],
        methods: [...MATRIX_METHODS, ...CASCADE_METHODS, ...SLEEP_METHODS],
        capabilities: SLEEP_CAPABILITIES,
      },
      {
        peerId: USER_B_PEER, principalId: PRINCIPAL_USER_B,
        domains: ["system", "private", "sleep"],
        methods: [...MATRIX_METHODS, ...SLEEP_METHODS],
        capabilities: SLEEP_CAPABILITIES,
      },
      {
        peerId: NO_CASCADE_PEER, principalId: PRINCIPAL_NO_CASCADE,
        domains: ["system", "private"],
        methods: NO_CASCADE_METHODS,
        capabilities: [],
      },
    ];

    this.writeRestricted(join(this.remoteDir, "endpoint.json"), JSON.stringify({
      enabled: true, host: "127.0.0.1", port: this.port,
      tlsCertPath: join(this.root, "tls-cert.pem"),
      tlsKeyPath: join(this.root, "tls-key.pem"),
    }));
    this.writeRestricted(join(this.remoteDir, "enrollments.json"), JSON.stringify(enrollments, null, 2));
    this.writeRestricted(join(this.remoteDir, "grants.json"), JSON.stringify(grants, null, 2));
    this.writeRestricted(join(this.remoteDir, "client-profiles.json"), JSON.stringify([
      { name: USER_A_PEER, url: this.wssUrl(), peerId: USER_A_PEER, signingKeyPath: this.peerKeys.get(USER_A_PEER)!, serverCertSha256: this.pin },
      { name: USER_B_PEER, url: this.wssUrl(), peerId: USER_B_PEER, signingKeyPath: this.peerKeys.get(USER_B_PEER)!, serverCertSha256: this.pin },
      { name: NO_CASCADE_PEER, url: this.wssUrl(), peerId: NO_CASCADE_PEER, signingKeyPath: this.peerKeys.get(NO_CASCADE_PEER)!, serverCertSha256: this.pin },
    ], null, 2));
  }

  private wssUrl(): string {
    return `wss://127.0.0.1:${this.port}`;
  }

  /** abtars consumer profile: production endpoint selector config for the remote probe. */

  private principalToPeer(principalId?: string): string {
    if (principalId === PRINCIPAL_USER_B) return USER_B_PEER;
    if (principalId === PRINCIPAL_NO_CASCADE) return NO_CASCADE_PEER;
    return USER_A_PEER;
  }

  // ── AcceptanceFixture ────────────────────────────────────────────────────

  async createClient(principalId?: string): Promise<AbmindClient> {
    const peerId = this.principalToPeer(principalId);
    const profile = {
      name: peerId,
      url: `wss://127.0.0.1:${this.port}` as const,
      peerId,
      signingKeyPath: this.peerKeys.get(peerId)!,
      serverCertSha256: this.pin,
    };
    const outbox = new RequestOutbox(peerId, join(this.root, "outboxes", `${peerId}-${randomUUID().slice(0, 6)}.json`));
    const base = new SignedWssTransport(profile, outbox);
    const transport: AbmindTransport = {
      negotiate: () => base.negotiate(),
      request: async (req) => {
        this.requestIds.push(req.requestId);
        return base.request(req);
      },
      close: () => base.close(),
    };
    const client = new AbmindClient(transport);
    await client.negotiate();
    this.clients.push(client);
    return client;
  }

  /** Fixture-owned promotion: the public private.adjustRelevance equivalent of the local CLI. */
  /** #1658: seed a legacy row directly (bypasses the Master-only gate). */
  async seedMemory(input: { userId: string; contentEn: string; contentOriginal: string }): Promise<void> {
    const { initializeDatabase } = await import("../../src/memory-db.js");
    const db = initializeDatabase(join(this.memoryDir, "memory.db"));
    try {
      const now = Date.now();
      db.prepare(
        `INSERT INTO extracted_memories
           (user_id, content_original, content_en, memory_type, source_timestamp, created_at, emotion_score, classification)
         VALUES (?, ?, ?, 'fact', ?, ?, 0, 1)`,
      ).run(input.userId, input.contentOriginal, input.contentEn, now, now);
    } finally {
      db.close();
    }
  }

  async promoteMemory(input: PromoteMemoryInput): Promise<void> {
    const client = await this.createClient(input.principalId);
    try {
      const result = await client.privateMemory.adjustRelevance({
        userId: input.principalId,
        memoryId: input.memoryId,
        expectedRevision: input.expectedRevision,
        delta: 10,
      }, input.operationKey);
      if (!result.ok || !result.ref || result.ref.semanticRevision !== input.expectedRevision + 1) {
        throw new Error(`adjustRelevance promotion failed: ${JSON.stringify(result)}`);
      }
    } finally {
      await client.close();
    }
  }

  takeRequestIds(): string[] {
    const ids = [...this.requestIds];
    this.requestIds = [];
    return ids;
  }

  // ── Daemon lifecycle ─────────────────────────────────────────────────────

  private validatePaths(): void {
    const resolved = resolve(this.root);
    for (const p of [this.memoryDir, this.homeDir, this.remoteDir]) {
      const rel = relative(resolved, resolve(p));
      if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
        throw new Error(`Path escapes fixture root: ${p}`);
      }
    }
    if (!existsSync(DAEMON_ENTRY)) throw new Error(`Built daemon not found: ${DAEMON_ENTRY}`);
  }

  async startOwner(): Promise<void> {
    this.validatePaths();
    mkdirSync(join(this.root, "run"), { recursive: true });

    // Reuse the previous port across restartOwner so existing clients can
    // reconnect to the same endpoint.
    this.port = this.port === 0 ? this.reservePort() : this.port;
    this.writeDaemonConfig();

    const childEnv = buildChildEnv(this.root, this.remoteDir, this.homeDir, this.memoryDir);
    this.child = spawn(process.execPath, [DAEMON_ENTRY, "--foreground"], {
      cwd: this.abmindRoot,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.stdoutBuf = "";
    this.stderrBuf = "";
    this.stdoutLen = 0;
    this.stderrLen = 0;
    this.usedSigkill = false;
    this.childExitCode = null;
    this.childSignal = null;

    this.child.stdout!.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      appendFileSync(this.stdoutPath, text);
      this.stdoutLen += text.length;
      this.stdoutBuf = this.stdoutLen > STREAM_BOUND ? this.stdoutBuf.slice(-STREAM_BOUND / 2) + text : this.stdoutBuf + text;
    });
    this.child.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      appendFileSync(this.stderrPath, text);
      this.stderrLen += text.length;
      this.stderrBuf = this.stderrLen > STREAM_BOUND ? this.stderrBuf.slice(-STREAM_BOUND / 2) + text : this.stderrBuf + text;
    });
    this.child.on("exit", (code, signal) => {
      this.childExitCode = code;
      this.childSignal = signal;
    });

    await this.waitForReadiness();
  }

  private async waitForReadiness(): Promise<void> {
    const deadline = Date.now() + READINESS_DEADLINE_MS;

    while (Date.now() < deadline) {
      if (this.child && (this.child.exitCode !== null || this.child.signalCode !== null)) {
        throw new Error(
          `Daemon exited before readiness (exit=${this.child.exitCode}, signal=${this.child.signalCode})\n` +
          `stdout tail:\n${this.stdoutBuf.slice(-2000)}\n\n` +
          `stderr tail:\n${this.stderrBuf.slice(-2000)}`
        );
      }

      try {
        const probe = await this.createProbeClient();
        try {
          await probe.negotiate();
          return;
        } finally {
          await probe.close();
        }
      } catch {
        await this.delay(READINESS_POLL_MS);
      }
    }

    throw new Error(
      `Daemon did not become ready within ${READINESS_DEADLINE_MS}ms\n` +
      `stdout tail:\n${this.stdoutBuf.slice(-2000)}\n\n` +
      `stderr tail:\n${this.stderrBuf.slice(-2000)}`
    );
  }

  private async createProbeClient(): Promise<AbmindClient> {
    const profile = {
      name: USER_A_PEER,
      url: `wss://127.0.0.1:${this.port}` as const,
      peerId: USER_A_PEER,
      signingKeyPath: this.peerKeys.get(USER_A_PEER)!,
      serverCertSha256: this.pin,
    };
    const transport = new SignedWssTransport(profile, new RequestOutbox("probe", join(this.root, "outboxes", "probe.json")));
    return new AbmindClient(transport);
  }

  async stopOwner(): Promise<void> {
    for (const client of this.clients) {
      try { await client.close(); } catch { }
    }
    this.clients = [];
    await this.killOwner();
  }

  /**
   * #1382: stop and restart the daemon on the same WSS port WITHOUT closing
   * fixture clients, so a route-loss journey observes the drop and recovers
   * through reconnect + renegotiation on the same client instance.
   */
  async restartOwner(): Promise<void> {
    await this.killOwner();
    await this.startOwner();
  }

  private async killOwner(): Promise<void> {
    if (!this.child) return;
    this.child.kill("SIGTERM");

    const deadline = Date.now() + GRACE_PERIOD_MS;
    while (Date.now() < deadline) {
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        this.child = null;
        return;
      }
      await this.delay(100);
    }

    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.usedSigkill = true;
      this.child.kill("SIGKILL");
    }
    const killedChild = this.child;
    const killDeadline = Date.now() + 2_000;
    while (killedChild.exitCode === null && killedChild.signalCode === null && Date.now() < killDeadline) {
      await this.delay(50);
    }
    this.child = null;
  }

  get degradedCleanup(): boolean { return this.usedSigkill; }

  get exitMetadata(): { exitCode: number | null; signal: string | null; degradedCleanup: boolean; stdoutTail: string; stderrTail: string } {
    return {
      exitCode: this.childExitCode,
      signal: this.childSignal,
      degradedCleanup: this.usedSigkill,
      stdoutTail: this.stdoutBuf.slice(-2000),
      stderrTail: this.stderrBuf.slice(-2000),
    };
  }

  async copyFailureArtifacts(stage: string): Promise<string> {
    await this.stopOwner();
    const logDir = join(this.root, "run");
    const dbPath = join(this.memoryDir, "memory.db");
    if (existsSync(dbPath) && process.env.ABMIND_E2E_KEEP === "1") {
      try {
        writeFileSync(join(logDir, "memory.db"), readFileSync(dbPath));
      } catch { }
    }
    const meta = this.exitMetadata;
    writeFileSync(join(logDir, "child-exit.json"), JSON.stringify(meta, null, 2));
    return logDir;
  }

  async cleanup(): Promise<void> {
    await this.stopOwner();
    try { rmSync(this.root, { recursive: true, force: true }); } catch { }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
