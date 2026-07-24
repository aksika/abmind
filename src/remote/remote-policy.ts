import type { DomainName, AbmindMethod, ServiceCallContext, CallerRole } from "../abmind-protocol.js";
import { METHOD_REGISTRY } from "../abmind-protocol.js";
import type { RemoteGrantV1 } from "./remote-config.js";

export function resolveRemoteContext(
  grant: RemoteGrantV1,
  authenticatedBy: "signed_peer",
): ServiceCallContext {
  const domains = new Set<DomainName>(grant.domains);
  const allowedMethods = new Set<AbmindMethod>(grant.methods);
  const capabilities = new Set<string>(grant.capabilities);

  return {
    principalId: grant.principalId,
    role: "peer" as CallerRole,
    grantedDomains: domains,
    allowedMethods,
    capabilities,
    privateUserId: grant.privateUserId,
    authenticatedBy,
  };
}

export function isMethodAllowed(
  method: AbmindMethod,
  context: ServiceCallContext,
): boolean {
  const entry = METHOD_REGISTRY[method];
  if (!entry) return false;

  if (!context.grantedDomains.has(entry.domain as DomainName)) return false;
  if (context.allowedMethods && !context.allowedMethods.has(method)) return false;
  if (entry.capability && (!context.capabilities || !context.capabilities.has(entry.capability))) return false;

  return true;
}

export const DEFAULT_REMOTE_GRANT_METHODS: AbmindMethod[] = [
  "system.negotiate", "system.health", "system.status", "system.capabilities",
  "operational.recall", "operational.submitDraft",
];

export function makeDefaultGrant(peerId: string, principalId: string): RemoteGrantV1 {
  return {
    peerId,
    principalId,
    domains: ["system", "operational"],
    methods: DEFAULT_REMOTE_GRANT_METHODS,
    capabilities: [],
  };
}
