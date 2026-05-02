/**
 * session-mapper.ts — Map OpenClaw session keys to abmind chatIds.
 * Format: "agent:<agentId>:<rest>" → chatId = rest
 */

/**
 * Extract chatId from OpenClaw session key.
 * "agent:main:telegram:12345" → "telegram:12345"
 * Falls back to full key if not in agent: format.
 */
export function toChatId(sessionKey: string): string {
  const parts = sessionKey.split(":");
  if (parts.length >= 3 && parts[0] === "agent") {
    return parts.slice(2).join(":");
  }
  return sessionKey;
}
