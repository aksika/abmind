export const NATIVE_TARGET_CONTRACT = {
  contractHash: "native-v1-node22-better-sqlite3-12.11.1-sqlite-vec-0.1.9",
  nodeMajor: 22,
  packages: {
    "better-sqlite3": { version: "12.11.1", probeId: "sqlite-open-select-v1" },
    "sqlite-vec": { version: "0.1.9", probeId: "sqlite-vec-load-query-v1" },
  },
} as const;

export type NativeTargetPackage = keyof typeof NATIVE_TARGET_CONTRACT.packages;

export function nativeTargetVersion(pkg: NativeTargetPackage): string {
  return NATIVE_TARGET_CONTRACT.packages[pkg].version;
}

export function nativeTargetProbeId(pkg: NativeTargetPackage): string {
  return NATIVE_TARGET_CONTRACT.packages[pkg].probeId;
}

export const NATIVE_TARGET_NAMES: NativeTargetPackage[] = Object.keys(NATIVE_TARGET_CONTRACT.packages) as NativeTargetPackage[];

export function nativeTargetCanonicalJson(): string {
  return JSON.stringify(NATIVE_TARGET_CONTRACT, null, 2);
}
