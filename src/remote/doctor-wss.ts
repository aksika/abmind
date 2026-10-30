import type { DoctorCheckResult } from "../abmind-protocol.js";
import { loadEndpointConfig, loadEnrollments, loadGrantsWithDrops } from "./remote-config.js";
import { probeWssChallenge } from "./signed-wss-endpoint.js";

/**
 * #1948: WSS endpoint checks for `abmind doctor`.
 *
 * Read-only: never edits grants.json and needs no other node. Returns no
 * checks when the endpoint is disabled. One WARN per dropped method or
 * entry, ERROR when grants.json still cannot load, and a loopback probe
 * that waits for one `challenge` frame then closes without logging in.
 */
export async function checkWssEndpoint(): Promise<DoctorCheckResult[]> {
  let endpoint;
  try {
    endpoint = loadEndpointConfig();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return [{ id: "wss-endpoint", name: "wss endpoint", status: "skip", message: msg }];
  }
  if (!endpoint.enabled) return [];

  const results: DoctorCheckResult[] = [];
  try {
    const { drops } = loadGrantsWithDrops(loadEnrollments());
    if (drops.length === 0) {
      results.push({ id: "wss-grants", name: "wss grants", status: "ok", message: "all grants load cleanly" });
    } else {
      for (const d of drops) {
        const detail = d.method ? `dropped method ${d.method}` : d.reason;
        results.push({ id: "wss-grants", name: "wss grants", status: "warn", message: `peerId=${d.peerId}: ${detail}` });
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ id: "wss-grants", name: "wss grants", status: "error", message: msg });
  }

  const loopbackHost = ["0.0.0.0", "::", "*", ""].includes(endpoint.host) ? "127.0.0.1" : endpoint.host;
  try {
    const answered = await probeWssChallenge(loopbackHost, endpoint.port);
    results.push(answered
      ? { id: "wss-loopback", name: "wss loopback", status: "ok", message: "endpoint answered with a challenge frame" }
      : { id: "wss-loopback", name: "wss loopback", status: "warn", message: "endpoint enabled but no challenge answer on loopback" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ id: "wss-loopback", name: "wss loopback", status: "warn", message: msg });
  }
  return results;
}
