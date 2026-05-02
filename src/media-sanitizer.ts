/**
 * Media sanitizer — strips binary/media payloads from message content
 * before summarization. Prevents images/files from consuming token budget.
 *
 * Patterns from Lossless-claw's compaction.ts.
 */

const BASE64_DATA_URL_RE = /data:[^;\s"'`]+;base64,[A-Za-z0-9+/=\s]+/gi;
const MEDIA_PATH_RE = /^MEDIA:\/.+$/;

/** Detect whether a string is mostly binary/base64 payload. */
function looksLikeBinary(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length < 256) return false;
  if (/^data:[^;\s"'`]+;base64,/i.test(trimmed)) return true;
  const compact = trimmed.replace(/\s+/g, "");
  if (compact.length % 4 !== 0) return false;
  if (!/^[A-Za-z0-9+/=]+$/.test(compact)) return false;
  return !/[ .,:;!?()[\]{}]/.test(trimmed);
}

/** Strip media payloads from message content. Returns clean text for summarization. */
export function stripMediaPayloads(content: string): string {
  if (!content) return "";
  // Remove data URLs
  let result = content.replace(BASE64_DATA_URL_RE, "[embedded media omitted]");
  // Filter lines
  result = result
    .split("\n")
    .filter(line => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      if (MEDIA_PATH_RE.test(trimmed)) return false;
      if (looksLikeBinary(trimmed)) return false;
      return true;
    })
    .join("\n")
    .trim();
  // If nothing left, it was a media-only message
  return result || "[Media attachment]";
}

/** Annotate content: if media was stripped, add marker. */
export function sanitizeForSummary(content: string): string {
  const stripped = stripMediaPayloads(content);
  if (stripped === "[Media attachment]") return stripped;
  if (stripped.length < content.length * 0.5) return `${stripped} [with media attachment]`;
  return stripped;
}
