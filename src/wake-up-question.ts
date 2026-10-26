/**
 * Storage-only marker used for assistant boot greetings that carry a durable
 * Dreamy question. The marker is useful for transcript/sleep correlation but
 * must never become provider-visible text.
 */
const WAKE_UP_QUESTION_MARKER_RE = /^\[WAKE-UP QUESTION id=[^\]\r\n]{1,128}\]\s*/;

/** Remove the storage marker while retaining the delivered greeting/question. */
export function stripWakeUpQuestionMarker(content: string): string {
  return content.replace(WAKE_UP_QUESTION_MARKER_RE, "");
}
