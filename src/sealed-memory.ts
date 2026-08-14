/**
 * sealed-memory.ts — canonical versioned sealed representation for
 * classification >= 3 extracted memories (#1660).
 *
 * A sealed row satisfies all of:
 *   classification >= 3, sealed_format_version = 1, encrypted = 1, the exact
 *   value lives only as decryptable ciphertext in content_original, a
 *   descriptive label lives in content_en, preserved_keyword holds only
 *   non-sensitive retrieval keywords, and embedding stays NULL for its whole
 *   life.
 *
 * This module is the only place that builds or bounds a sealed projection.
 * Every production writer that can raise classification to 3 must consume
 * createSealedProjection() before mutation; no caller may inline encryption
 * branches for sealed rows.
 */

import { encrypt, loadKey } from "./crypto.js";

export const SEALED_FORMAT_VERSION = 1 as const;

export const SEALED_MAX_VALUE_LENGTH = 16384;
export const SEALED_MAX_LABEL_LENGTH = 256;
export const SEALED_MAX_KEYWORD_LENGTH = 128;

export type SealedProjection = {
  readonly contentOriginal: string;
  readonly contentEn: string;
  readonly preservedKeyword: string | null;
  readonly encrypted: 1;
  readonly sealedFormatVersion: 1;
  readonly embedding: null;
};

/**
 * Build a bounded, encrypted sealed projection.
 *
 * Rejects empty value/label, an exact value copied into the label or keyword,
 * missing encryption key and oversized fields — before any SQL is built.
 * The label/keyword are never derived from the value; the caller supplies a
 * descriptive label for the owner to recognize.
 */
export function createSealedProjection(input: {
  readonly exactValue: string;
  readonly label: string;
  readonly keyword?: string;
}): SealedProjection {
  const exactValue = input.exactValue.trim();
  const label = input.label.trim();
  const keyword = input.keyword?.trim() || null;

  if (!exactValue) {
    throw new Error("sealed projection requires a non-empty exact value");
  }
  if (!label) {
    throw new Error("sealed projection requires a non-empty descriptive label");
  }
  if (exactValue.length > SEALED_MAX_VALUE_LENGTH) {
    throw new Error(`sealed exact value exceeds ${SEALED_MAX_VALUE_LENGTH} characters`);
  }
  if (label.length > SEALED_MAX_LABEL_LENGTH) {
    throw new Error(`sealed label exceeds ${SEALED_MAX_LABEL_LENGTH} characters`);
  }
  if (keyword && keyword.length > SEALED_MAX_KEYWORD_LENGTH) {
    throw new Error(`sealed keyword exceeds ${SEALED_MAX_KEYWORD_LENGTH} characters`);
  }

  const valueContainsLabel = label.length >= 4 && exactValue.includes(label);
  const labelContainsValue = exactValue.length >= 4 && (label.includes(exactValue) || (keyword !== null && keyword.includes(exactValue)));
  if (label === exactValue || valueContainsLabel || labelContainsValue) {
    throw new Error("sealed label/keyword must not contain or duplicate the exact value");
  }

  // loadKey() throws when no key is available; promotion must fail before SQL.
  loadKey();
  const encryptedValue = encrypt(exactValue);

  return {
    contentOriginal: encryptedValue,
    contentEn: label,
    preservedKeyword: keyword,
    encrypted: 1,
    sealedFormatVersion: 1,
    embedding: null,
  };
}
