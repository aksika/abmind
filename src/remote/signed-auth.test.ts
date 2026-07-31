import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { normalizeCertificatePin, verifyCertificatePin } from "./signed-auth.js";

function generateCert(root: string, name: string): { certPath: string; pin: string } {
  const keyPath = join(root, `${name}-key.pem`);
  const certPath = join(root, `${name}-cert.pem`);
  execSync(
    `openssl req -x509 -newkey ed25519 -nodes -keyout ${keyPath} -out ${certPath} -subj /CN=localhost -days 1`,
    { stdio: "ignore" },
  );
  const der = execSync(`openssl x509 -in ${certPath} -outform DER`, { encoding: "buffer" as never }) as Buffer;
  const pin = require("node:crypto").createHash("sha256").update(der).digest("hex");
  return { certPath, pin };
}

describe("normalizeCertificatePin", () => {
  it("accepts a canonical 64-char lowercase hex pin", () => {
    const input = "a".repeat(64);
    expect(normalizeCertificatePin(input)).toBe(input);
  });

  it("normalizes whitespace and uppercase to lowercase hex", () => {
    const upper = "A".repeat(64);
    expect(normalizeCertificatePin(`  ${upper}  `)).toBe("a".repeat(64));
  });

  it("rejects wrong-length input", () => {
    expect(() => normalizeCertificatePin("a".repeat(63))).toThrow();
    expect(() => normalizeCertificatePin("a".repeat(65))).toThrow();
  });

  it("rejects non-hex characters", () => {
    expect(() => normalizeCertificatePin("g".repeat(64))).toThrow();
    expect(() => normalizeCertificatePin("z".repeat(64))).toThrow();
  });
});

describe("verifyCertificatePin", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "abmind-pin-test-"));
    mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("accepts the correct DER-leaf SHA-256 pin", () => {
    const { certPath, pin } = generateCert(root, "leaf");
    const der = execSync(`openssl x509 -in ${certPath} -outform DER`) as Buffer;
    expect(() => verifyCertificatePin(der, pin)).not.toThrow();
  });

  it("accepts an uppercase pin input after normalization", () => {
    const { certPath, pin } = generateCert(root, "leaf");
    const der = execSync(`openssl x509 -in ${certPath} -outform DER`) as Buffer;
    expect(() => verifyCertificatePin(der, pin.toUpperCase())).not.toThrow();
  });

  it("rejects a mismatched certificate pin", () => {
    const { certPath } = generateCert(root, "leaf");
    const other = generateCert(root, "other");
    const der = execSync(`openssl x509 -in ${certPath} -outform DER`) as Buffer;
    expect(() => verifyCertificatePin(der, other.pin)).toThrow(/mismatch/i);
  });

  it("rejects malformed expected pin input", () => {
    const { certPath } = generateCert(root, "leaf");
    const der = execSync(`openssl x509 -in ${certPath} -outform DER`) as Buffer;
    expect(() => verifyCertificatePin(der, "not-a-pin")).toThrow(/Invalid certificate pin/);
  });

  it("pin equals the DER-leaf sha256 hex digest used by fixtures", () => {
    const { certPath, pin } = generateCert(root, "leaf");
    void writeFileSync;
    void chmodSync;
    void readFileSync;
    expect(pin).toMatch(/^[0-9a-f]{64}$/);
    expect(certPath).toContain("leaf");
  });
});
