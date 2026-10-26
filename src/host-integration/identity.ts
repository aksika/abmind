import type { ExecutionIdentity, HostDiagnostic } from "./types.js";

const CONTROL_CHAR = /[\x00-\x1f\x7f-\x9f]/;

export function isValidIdentityField(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && !CONTROL_CHAR.test(trimmed);
}

export interface ValidatedIdentity {
  identity: ExecutionIdentity;
  diagnostics: readonly HostDiagnostic[];
}

export function validateIdentity(raw: ExecutionIdentity): ValidatedIdentity {
  const diagnostics: HostDiagnostic[] = [];
  const fields: Array<{ key: string; value: string }> = [
    { key: "principalId", value: raw.principalId },
    { key: "conversationId", value: raw.conversationId },
    { key: "executionId", value: raw.executionId },
    { key: "host", value: raw.host },
    { key: "origin", value: raw.origin },
    { key: "automaticWriteOwner", value: raw.automaticWriteOwner },
  ];

  for (const { key, value } of fields) {
    if (!value || !value.trim()) {
      diagnostics.push({
        operation: "validateIdentity",
        code: "EMPTY_IDENTITY_FIELD",
        message: `Identity field '${key}' is empty`,
      });
    } else if (CONTROL_CHAR.test(value)) {
      diagnostics.push({
        operation: "validateIdentity",
        code: "CONTROL_CHAR_IN_IDENTITY",
        message: `Identity field '${key}' contains control characters`,
      });
    }
  }

  if (raw.parentExecutionId !== undefined) {
    const trimmed = raw.parentExecutionId.trim();
    if (!trimmed) {
      diagnostics.push({
        operation: "validateIdentity",
        code: "EMPTY_PARENT_EXECUTION_ID",
        message: "Optional field 'parentExecutionId' is present but empty",
      });
    } else if (CONTROL_CHAR.test(raw.parentExecutionId)) {
      diagnostics.push({
        operation: "validateIdentity",
        code: "CONTROL_CHAR_IN_PARENT_EXECUTION_ID",
        message: "Optional field 'parentExecutionId' contains control characters",
      });
    }
  }

  // #1928 C7 (folded #1910): the session generation survives the normalizer.
  // Absent means the documented default 0 at use sites; a present value that
  // is not a non-negative safe integer is an invalid identity, never coerced.
  const generation = raw.generation;
  if (generation !== undefined && (!Number.isSafeInteger(generation) || generation < 0)) {
    diagnostics.push({
      operation: "validateIdentity",
      code: "INVALID_GENERATION",
      message: "Identity field 'generation' must be a non-negative integer",
    });
  }

  const identity: ExecutionIdentity = {
    principalId: raw.principalId.trim(),
    conversationId: raw.conversationId.trim(),
    executionId: raw.executionId.trim(),
    parentExecutionId: raw.parentExecutionId?.trim() || undefined,
    ...(generation !== undefined ? { generation } : {}),
    host: raw.host.trim(),
    origin: raw.origin.trim(),
    automaticWriteOwner: raw.automaticWriteOwner.trim(),
  };

  return { identity, diagnostics };
}

export function canAutoWrite(identity: ExecutionIdentity, writerId: string): boolean {
  return identity.automaticWriteOwner === writerId;
}

export function buildProvenance(identity: ExecutionIdentity, writerId: string, operation: string): string {
  return `${identity.host}:${writerId}:${operation}`;
}
