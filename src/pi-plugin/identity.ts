import { randomUUID } from "node:crypto";
import { loadMasterUserId } from "../user-utils.js";
import type { ExecutionIdentity } from "../host-integration/types.js";
import type { SessionStartEvent, ExtensionContext } from "./pi-types.js";

function nonEmpty(value: string | undefined | null): string | undefined {
  return value?.trim() || undefined;
}

export function resolvePrincipal(): string {
  const fromEnv = process.env.ABMIND_USER_ID?.trim();
  if (fromEnv) return fromEnv;
  try {
    const master = loadMasterUserId();
    if (master && master !== "master") return master;
  } catch {
    // fall through to default
  }
  return "default";
}

export interface PiIdentityResult {
  identity: ExecutionIdentity;
}

export function buildIdentity(event: SessionStartEvent, ctx: ExtensionContext): PiIdentityResult {
  const principalId = resolvePrincipal();
  const conversationId = ctx.sessionManager.getSessionId();
  const executionId = randomUUID();
  const parentExecutionId = nonEmpty(process.env.ABMIND_PARENT_EXECUTION_ID);
  const automaticWriteOwner = nonEmpty(process.env.ABMIND_AUTOMATIC_WRITE_OWNER) ?? "abmind-pi-plugin";

  const identity: ExecutionIdentity = {
    principalId,
    conversationId,
    executionId,
    parentExecutionId,
    host: "pi",
    origin: `pi:${event.reason}`,
    automaticWriteOwner,
  };

  return { identity };
}
