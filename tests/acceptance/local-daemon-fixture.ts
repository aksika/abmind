import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync, existsSync, readFileSync, symlinkSync } from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { join, resolve, relative, isAbsolute } from "node:path";
import { tmpdir, homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { AbmindClient, LocalTransport } from "../../src/index.js";
import type { AbmindTransport } from "../../src/abmind-protocol.js";
import type { AcceptanceFixture, PromoteMemoryInput } from "./contracts.js";

const COMPILED_ROOT = resolve(import.meta.dirname, "../..");
const REPOSITORY_ROOT = resolve(COMPILED_ROOT, "..");
const DAEMON_ENTRY = resolve(COMPILED_ROOT, "cli/abmind-daemon.js");
const READINESS_POLL_MS = 200;
const READINESS_DEADLINE_MS = 15_000;
const GRACE_PERIOD_MS = 5_000;
const STREAM_BOUND = 512 * 1024;

const CHILD_ENV_ALLOWLIST = new Set([
  "PATH", "NODE_PATH", "PATHEXT", "SystemRoot", "WINDIR",
  "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH",
  "LANG", "LC_ALL", "LC_CTYPE", "TZ", "CI", "TERM",
]);

function generateRunId(): string {
  return `e2e-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

function buildChildEnv(fixtureRoot: string, socketPath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of CHILD_ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const home = join(fixtureRoot, "home");
  env.HOME = home;
  env.USERPROFILE = home;
  env.ABMIND_HOME = join(home, ".abmind");
  env.XDG_CONFIG_HOME = join(home, ".config");
  env.XDG_CACHE_HOME = join(home, ".cache");
  env.XDG_STATE_HOME = join(home, ".local", "state");
  env.MEMORY_DIR = join(fixtureRoot, "memory");
  env.ABMIND_ENDPOINT = socketPath;
  env.EMBEDDING_ENABLED = "false";
  env.NODE_ENV = "test";
  env.ABMIND_USER = "e2e-daemon";
  return env;
}

export class LocalDaemonFixture implements AcceptanceFixture {
  readonly transport = "local-unix" as const;
  readonly grantEnforcement = false;
  readonly root: string;
  readonly runId: string;
  readonly socketPath: string;
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

  constructor() {
    this.runId = generateRunId();
    this.root = mkdtempSync(join(tmpdir(), `abmind-e2e-${this.runId}-`));
    this.homeDir = join(this.root, "home");
    const xdgConfig = join(this.homeDir, ".config");
    const xdgCache = join(this.homeDir, ".cache");
    const xdgState = join(this.homeDir, ".local", "state");
    this.abmindHome = join(this.homeDir, ".abmind");
    this.memoryDir = join(this.root, "memory");
    this.socketPath = join(this.root, "run", "abmind.sock");
    this.abmindRoot = REPOSITORY_ROOT;

    for (const dir of [this.homeDir, this.abmindHome, xdgConfig, xdgCache, xdgState,
      this.memoryDir, join(this.root, "run"), join(this.root, "result"), join(this.abmindHome, "config")]) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(join(this.abmindHome, "config", "users.json"), JSON.stringify({
      users: [{ userId: "e2e-user-a", role: "master" }],
    }));

    const sharedNativeDeps = join(homedir(), ".local", "lib", "node_modules");
    if (existsSync(sharedNativeDeps)) {
      const localNativeParent = join(this.homeDir, ".local", "lib");
      mkdirSync(localNativeParent, { recursive: true });
      try { symlinkSync(sharedNativeDeps, join(localNativeParent, "node_modules"), "dir"); } catch { /* existing link */ }
    }

    this.stdoutPath = join(this.root, "run", "daemon.stdout.log");
    this.stderrPath = join(this.root, "run", "daemon.stderr.log");
  }

  private validatePaths(): void {
    const resolved = resolve(this.root);
    for (const p of [this.socketPath, this.memoryDir, this.homeDir]) {
      const rel = relative(resolved, resolve(p));
      if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
        throw new Error(`Path escapes fixture root: ${p}`);
      }
    }
    if (!existsSync(DAEMON_ENTRY)) throw new Error(`Built daemon not found: ${DAEMON_ENTRY}`);
  }

  async startOwner(): Promise<void> {
    this.validatePaths();

    const childEnv = buildChildEnv(this.root, this.socketPath);

    this.child = spawn(process.execPath, [DAEMON_ENTRY, "--foreground", "--socket", this.socketPath], {
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
        const transport = new LocalTransport(this.socketPath);
        try {
          const health = await transport.request({ version: 1, requestId: "health-check", method: "system.health", payload: {} });
          if (health.ok === true) {
            await transport.request({ version: 1, requestId: "neg-check", method: "system.negotiate", payload: {} });
            return;
          }
        } finally {
          await transport.close();
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

  async stopOwner(): Promise<void> {
    for (const client of this.clients) {
      try { await client.close(); } catch { }
    }
    this.clients = [];

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

  async createClient(_principalId?: string): Promise<AbmindClient> {
    const base = new LocalTransport(this.socketPath);
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

  /**
   * Fixture-owned sleep promotion: the local lane invokes the existing CLI
   * against this fixture's daemon (the transport-neutral equivalent of the
   * remote lane's public private.adjustRelevance call).
   */
  async promoteMemory(input: PromoteMemoryInput): Promise<void> {
    const sleepApplyCli = resolve(this.abmindRoot, "dist/cli/abmind-sleep-apply.js");
    const result = spawnSync(process.execPath, [
      sleepApplyCli,
      "--promote", String(input.memoryId),
      "--expected-revision", String(input.expectedRevision),
    ], {
      cwd: this.abmindRoot,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: this.homeDir,
        USERPROFILE: this.homeDir,
        ABMIND_HOME: join(this.homeDir, ".abmind"),
        MEMORY_DIR: this.memoryDir,
        ABMIND_ENDPOINT: this.socketPath,
        ABMIND_USER: input.principalId,
        EMBEDDING_ENABLED: "false",
        NODE_ENV: "test",
      },
      encoding: "utf-8",
      timeout: 20_000,
      maxBuffer: 512 * 1024,
    });
    if (result.status !== 0) {
      throw new Error(`abmind-sleep-apply exited ${result.status}: ${result.stderr?.slice(-500) ?? ""}`);
    }
    if (!result.stdout?.includes("✅")) {
      throw new Error(`abmind-sleep-apply success marker missing: ${result.stdout?.slice(-500) ?? ""}`);
    }
  }

  takeRequestIds(): string[] {
    const ids = [...this.requestIds];
    this.requestIds = [];
    return ids;
  }

  probeEnv(): NodeJS.ProcessEnv {
    return buildChildEnv(this.root, this.socketPath);
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
