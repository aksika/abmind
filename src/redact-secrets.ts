/**
 * redactSecrets — secret-pattern sanitization for log/file output.
 *
 * INTENTIONALLY DUPLICATED across abtars and abmind — they are
 * independent products that both need this utility. If you add or
 * modify a pattern here, also update the sibling file:
 *   abtars/src/components/logger.ts (SECRET_PATTERNS + redactSecrets)
 *   abmind/src/redact-secrets.ts          (SECRET_PATTERNS + redactSecrets)
 *
 * Do NOT create an import relationship between them. Each product stays
 * independent so the bridge can run against a different memory backend
 * and abmind can ship as a standalone npm package without pulling
 * abtars in for a utility function.
 *
 * See abproject/docs/plans/178-redact-secrets-move.md for the rationale.
 */

export const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/sk-[A-Za-z0-9_-]{20,}/g, "sk-***REDACTED***"],
  [/ghp_[A-Za-z0-9]{36,}/g, "ghp_***REDACTED***"],
  [/github_pat_[A-Za-z0-9_]{20,}/g, "github_pat_***REDACTED***"],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, "xox_-***REDACTED***"],
  [/AIza[A-Za-z0-9_-]{30,}/g, "AIza***REDACTED***"],
  [/AKIA[A-Z0-9]{16}/g, "AKIA***REDACTED***"],
  [/\d{8,12}:[A-Za-z0-9_-]{35,}/g, "***BOT_TOKEN***"],
  [/Bearer [A-Za-z0-9._-]{20,}/g, "Bearer ***REDACTED***"],
  [/hf_[A-Za-z0-9]{20,}/g, "hf_***REDACTED***"],
  [/npm_[A-Za-z0-9]{20,}/g, "npm_***REDACTED***"],
  [/sk_live_[A-Za-z0-9]{20,}/g, "sk_live_***REDACTED***"],
  [/sk_test_[A-Za-z0-9]{20,}/g, "sk_test_***REDACTED***"],
  [/SG\.[A-Za-z0-9_-]{20,}/g, "SG.***REDACTED***"],
  [/("(?:api[_-]?key|token|secret|password|authorization|credential)"\s*:\s*")[^"]{8,}"/gi, '$1***REDACTED***"'],
  [/([A-Z_]*(?:KEY|TOKEN|SECRET|PASSWORD)=)[^\s]{8,}/g, "$1***REDACTED***"],
];

/** Strip known secret patterns from a log line or file content. */
export function redactSecrets(text: string): string {
  let result = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}
