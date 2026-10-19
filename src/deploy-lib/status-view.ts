/**
 * Status view — pure rendering for `abmind status`.
 *
 * The view carries pre-collected strings; this module does no I/O, no env
 * reads, and no network calls, so the layout is covered by fixture tests in
 * `status-view.test.ts`. Collection lives in `cli/abmind-status-runtime.ts`.
 *
 * Layout contract (#1920): two sections, no headlines, separated by one
 * empty row — (1) generic install block, (2) abmind daemon block.
 * Hooks append only when non-empty.
 */

export interface StatusInstall {
  home: string;
  releaseId: string | null;
  commit: string | null;
  source: string | null;
  activatedAt: string | null;
  host: string | null;
  keyPresent: boolean;
  soulBytes: number | null;
  deploymentLock: "free" | "held" | "stale";
  /** Pre-rendered daemon supervisor state: `running (pid N)`, `running`, or `stopped`. */
  daemon: string;
}

export type StatusService = {
  state: "ready";
  mode: string;
  instanceId: string;
  pid: number;
  uptimeMs: number;
  memoryEnabled: boolean;
  totalMessages: number;
  extractedMemories: number;
  consolidationDaily: number;
  consolidationWeekly: number;
  consolidationQuarterly: number;
  dbSizeBytes: number;
} | {
  state: "unavailable" | "incompatible" | "unauthorized";
  message: string;
};

export interface StatusHooks {
  errorCount: number;
  lastError: string | null;
  activeSidecars: number;
}

export interface AbmindStatusView {
  install: StatusInstall;
  service: StatusService;
  hooks: StatusHooks;
}

export function renderStatus(view: AbmindStatusView): string {
  const { install, service, hooks } = view;
  const lines: string[] = [
    "abmind status",
    `  home:          ${install.home}`,
  ];
  if (install.releaseId) lines.push(`  release:       ${install.releaseId}`);
  if (install.commit) lines.push(`  commit:        ${install.commit}`);
  if (install.source) lines.push(`  source:        ${install.source}`);
  lines.push(`  lock:          ${install.deploymentLock === "free" ? "not held" : `HELD${install.deploymentLock === "stale" ? " — STALE" : ""}`}`);
  if (install.soulBytes !== null) lines.push(`  SOUL:          ✓ (${(install.soulBytes / 1024).toFixed(1)} KB)`);
  else lines.push(`  SOUL:          ✗ missing`);
  if (install.activatedAt) lines.push(`  activated:     ${install.activatedAt}`);
  if (install.host) lines.push(`  host:          ${install.host}`);
  lines.push(`  key:           ${install.keyPresent ? "✓ abmind.key" : "✗ missing"}`);

  lines.push("");
  if (service.state === "ready") {
    const dbMb = (service.dbSizeBytes / 1024 / 1024).toFixed(1);
    const cDaily = String(service.consolidationDaily).padStart(2, "0");
    const cWeekly = String(service.consolidationWeekly).padStart(2, "0");
    const cQuarterly = String(service.consolidationQuarterly).padStart(2, "0");
    lines.push(
      `  daemon:        ${install.daemon}`,
      `  mode:          ${service.mode}`,
      `  instance:      ${service.instanceId}`,
      `  pid:           ${service.pid}`,
      `  uptime:        ${(service.uptimeMs / 1000).toFixed(0)}s`,
      `  memory:        ${service.memoryEnabled ? "enabled" : "disabled"}`,
      `  messages:      ${service.totalMessages}`,
      `  memories:      ${service.extractedMemories}`,
      `  consolidation: q${cQuarterly}/w${cWeekly}/d${cDaily}`,
      `  DB size:       ${dbMb} MB`,
    );
  } else if (install.daemon.startsWith("running")) {
    // Supervisor holds the job but RPC negotiation failed (slow boot or a
    // wedged socket): keep the supervisor truth and the raw detail together.
    lines.push(
      `  daemon:        ${install.daemon}`,
      `  ${service.message}`,
      `                 Run 'abmind doctor' for details.`,
    );
  } else {
    lines.push(
      `  daemon:        stopped — Run 'abmind start' to launch it, 'abmind doctor' for details.`,
    );
  }

  if (hooks.errorCount > 0 || hooks.activeSidecars > 0) {
    lines.push("");
    lines.push("  ── Hooks (#344) ──");
    if (hooks.errorCount > 0) {
      lines.push(`  errors:        ${hooks.errorCount} total`);
      if (hooks.lastError) lines.push(`  last error:    ${hooks.lastError.slice(0, 100)}`);
      lines.push(`                 run 'abmind hook-doctor' for details`);
    }
    if (hooks.activeSidecars > 0) lines.push(`  active sidecars: ${hooks.activeSidecars}`);
  }

  return lines.join("\n");
}
