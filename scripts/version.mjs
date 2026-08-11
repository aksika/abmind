import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(root, "..", "package.json"), "utf-8"));
if (typeof pkg.version !== "string" || !pkg.version) {
  throw new Error(`package.json.version is missing or not a string: ${JSON.stringify(pkg.version)}`);
}
writeFileSync(resolve(root, "..", "src", "_version.ts"), `export const ABMIND_VERSION = ${JSON.stringify(pkg.version)};\n`);
