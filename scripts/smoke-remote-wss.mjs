#!/usr/bin/env node

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID, createHash, generateKeyPairSync } from "node:crypto";
import { createServer, connect as tcpConnect } from "node:net";
import { spawn, execSync } from "node:child_process";

const ROOT = resolve(import.meta.dirname, "..");
const DAEMON_TIMEOUT = 20000;
const PORT = 0;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function findFreePort() {
  return new Promise((resolve_, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => { const p = srv.address().port; srv.close(() => resolve_(p)); });
    srv.on("error", reject);
  });
}

async function main() {
  const keepTmp = process.env.KEEP_TMP === "1";
  const tmp = mkdtempSync(join(tmpdir(), "abmind-wss-smoke-"));
  chmodSync(tmp, 0o700);
  const remoteDir = join(tmp, "remote");
  mkdirSync(remoteDir, { recursive: true });
  chmodSync(remoteDir, 0o700);

  console.log("\n=== WSS Protocol Smoke ===");
  console.log("  working dir:", tmp);

  // 1. Generate TLS cert
  const keyPath = join(tmp, "tls-key.pem");
  const certPath = join(tmp, "tls-cert.pem");
  execSync(
    "openssl req -x509 -newkey ed25519 -nodes -keyout " + keyPath + " -out " + certPath +
    " -subj /CN=localhost -days 1 -addext subjectAltName=DNS:localhost,IP:127.0.0.1",
    { stdio: "ignore", shell: true }
  );
  chmodSync(keyPath, 0o600);
  chmodSync(certPath, 0o600);

  const fingerprint = execSync(
    "openssl x509 -in " + certPath + " -outform DER | openssl dgst -sha256",
    { encoding: "utf-8", shell: true }
  ).replace(/^.*= /, "").trim();
  console.log("  TLS fingerprint:", fingerprint.slice(0, 16) + "...");

  // 2. Generate peer keys
  function genPeer(name) {
    const kp = generateKeyPairSync("ed25519");
    const pubPem = kp.publicKey.export({ type: "spki", format: "pem" }).toString().trim();
    const kpPath = join(tmp, name + "-ed25519.pem");
    writeFileSync(kpPath, kp.privateKey.export({ type: "pkcs8", format: "pem" }));
    chmodSync(kpPath, 0o600);
    return { pubPem, keyPath: kpPath, peerId: name };
  }
  const peer1 = genPeer("smoke-peer");
  const zeroGrant = genPeer("zero-grant");
  const noCascade = genPeer("no-cascade");

  // 3. Find free port
  const port = await findFreePort();
  console.log("  WSS port:", port);

  // 4. Write config (0o600 restricted)
  function writeRestricted(p, data) { writeFileSync(p, data); chmodSync(p, 0o600); }
  writeRestricted(join(remoteDir, "endpoint.json"), JSON.stringify({
    enabled: true, host: "127.0.0.1", port,
    tlsCertPath: certPath, tlsKeyPath: keyPath,
  }));
  writeRestricted(join(remoteDir, "enrollments.json"), JSON.stringify([
    { peerId: peer1.peerId, verifyKey: peer1.pubPem, enrolledAt: new Date().toISOString() },
    { peerId: zeroGrant.peerId, verifyKey: zeroGrant.pubPem, enrolledAt: new Date().toISOString() },
    { peerId: noCascade.peerId, verifyKey: noCascade.pubPem, enrolledAt: new Date().toISOString() },
  ]));
  writeRestricted(join(remoteDir, "grants.json"), JSON.stringify([
    {
      peerId: peer1.peerId, principalId: "smoke-principal",
      domains: ["system", "operational", "private"],
      methods: [
        "system.negotiate", "system.status",
        "operational.recall", "operational.submitDraft",
        "private.recordMessage", "private.instantStore",
        "private.cascadeDelete", "private.recall",
        "private.getRecentConversation",
      ],
      capabilities: [],
    },
    {
      peerId: noCascade.peerId, principalId: "no-cascade-principal",
      domains: ["system", "private"],
      methods: [
        "system.negotiate", "system.status",
        "private.recordMessage", "private.getRecentConversation",
      ],
      capabilities: [],
    },
  ]));
  writeRestricted(join(remoteDir, "client-profiles.json"), JSON.stringify([
    {
      name: "smoke-peer", url: "wss://127.0.0.1:" + port,
      peerId: peer1.peerId, signingKeyPath: peer1.keyPath, serverCertSha256: fingerprint,
    },
    {
      name: "no-cascade", url: "wss://127.0.0.1:" + port,
      peerId: noCascade.peerId, signingKeyPath: noCascade.keyPath, serverCertSha256: fingerprint,
    },
  ]));
  console.log("  config files written");

  // 5. Start daemon
  const daemonPath = resolve(ROOT, "dist/cli/abmind-daemon.js");
  if (!existsSync(daemonPath)) {
    console.error("FAIL: build first — dist/cli/abmind-daemon.js not found");
    if (!keepTmp) rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  }

  console.log("  starting daemon...");
  const daemon = spawn(process.execPath, [daemonPath, "--foreground"], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      ABMIND_HOME: tmp,
      ABMIND_REMOTE_DIR: remoteDir,
      EMBEDDING_ENABLED: "false",
      NODE_ENV: "production",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });

  let daemonLogs = "";
  daemon.stdout.on("data", d => { daemonLogs += d.toString(); });
  daemon.stderr.on("data", d => { daemonLogs += d.toString(); });

  // Wait for WSS endpoint to be ready
  let ready = false;
  const deadline = Date.now() + DAEMON_TIMEOUT;
  while (Date.now() < deadline) {
    if (daemonLogs.includes("WSS endpoint started")) { ready = true; break; }
    if (daemon.exitCode !== null) break;
    await sleep(300);
  }

  if (!ready) {
    console.error("FAIL: daemon did not start WSS");
    console.error("logs:", daemonLogs.slice(-2000));
    daemon.kill("SIGKILL");
    if (!keepTmp) rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  }
  console.log("  daemon WSS endpoint ready");

  // 6. Run client smoke tests
  const testScript = [
    'const { WebSocket } = require("ws");',
    'const { randomUUID } = require("crypto");',
    'const { readFileSync } = require("fs");',
    'const PORT = ' + port + ';',
    'const FP = ' + JSON.stringify(fingerprint) + ';',
    'const PKEY = ' + JSON.stringify(readFileSync(peer1.keyPath, "utf-8")) + ';',
    'const ZKEY = ' + JSON.stringify(readFileSync(zeroGrant.keyPath, "utf-8")) + ';',
    'const PID = "smoke-peer";',
    'const ZID = "zero-grant";',
    '',
    'function ed25519sign(priv, data) {',
    '  return require("crypto").sign(null, Buffer.from(data, "utf-8"), priv).toString("base64");',
    '}',
    'function ts() { return String(Math.floor(Date.now() / 1000)); }',
    'function makeHello(priv, pid, challenge, connectionId) {',
    '  const t = ts();',
    '  const canon = "abmind-wss-hello-v1\\n1\\n" + pid + "\\n" + connectionId + "\\n" + challenge + "\\n" + t;',
    '  const sig = ed25519sign(priv, canon);',
    '  return JSON.stringify({type:"hello",version:1,peerId:pid,connectionId:connectionId,challenge,timestamp:t,signature:sig});',
    '}',
    'function makeReq(priv, pid, body, nonce) {',
    '  const t = ts();',
    '  const id = randomUUID();',
    '  const n = nonce || randomUUID().replace(/-/g, "");',
    '  const bodyHash = require("crypto").createHash("sha256").update(body,"utf-8").digest("hex");',
    '  const canon = "abmind-wss-request-v1\\n1\\n" + pid + "\\n" + id + "\\nabmind.request.v1\\n/abmind.request.v1\\n" + t + "\\n" + n + "\\n" + bodyHash;',
    '  const sig = ed25519sign(priv, canon);',
    '  return JSON.stringify({type:"request",version:1,id,method:"abmind.request.v1",body,auth:{peerId:pid,ts:t,nonce:n,sig:sig}});',
    '}',
    '',
    'let fails = 0;',
    'function check(label, ok, detail) {',
    '  if (ok) { console.log("  PASS: " + label); }',
    '  else { console.log("  FAIL: " + label + (detail?" - "+detail:"")); fails++; }',
    '}',
    '',
    'async function connect(url) {',
    '  return new Promise((res, rej) => {',
    '    const ws = new WebSocket(url, {rejectUnauthorized:false});',
    '    ws.on("open", () => res(ws)); ws.on("error", rej);',
    '    setTimeout(() => rej(new Error("timeout")), 10000);',
    '  });',
    '}',
    'async function recv(ws) {',
    '  return new Promise((res, rej) => {',
    '    ws.once("message", d => res(JSON.parse(d.toString())));',
    '    ws.once("error", rej);',
    '    setTimeout(() => rej(new Error("timeout")), 10000);',
    '  });',
    '}',
    '',
    '(async () => {',
    '  try {',
    '    const url = "wss://127.0.0.1:" + PORT;',
    '',
    '    // Test 1: Connect and authenticate',
    '    const ws1 = await connect(url);',
    '    const ch1 = await recv(ws1);',
    '    check("server sends challenge", ch1.type === "challenge");',
    '    ws1.send(makeHello(PKEY, PID, ch1.challenge, ch1.connectionId));',
    '    const ha1 = await recv(ws1);',
    '    check("hello accepted", ha1.type === "hello_ack");',
    '',
    '    // Test 2: Negotiate',
    '    ws1.send(makeReq(PKEY, PID, JSON.stringify({version:1,requestId:randomUUID(),method:"system.negotiate",payload:{}})));',
    '    const n1 = await recv(ws1);',
    '    check("negotiate returns response", n1.type === "response");',
    '    const nb = n1.body ? JSON.parse(n1.body) : {};',
    '    const methods = (nb.result && nb.result.methods) || [];',

    '    check("negotiate has methods", methods.length > 0);',
    '    check("operational.recall in methods", methods.includes("operational.recall"));',
    '    ws1.close();',
    '',
    '    // Test 3: Zero-grant peer is denied all methods',
    '    const ws2 = await connect(url);',
    '    const ch2 = await recv(ws2);',
    '    ws2.send(makeHello(ZKEY, ZID, ch2.challenge, ch2.connectionId));',
    '    await recv(ws2);',
    '    ws2.send(makeReq(ZKEY, ZID, JSON.stringify({version:1,requestId:randomUUID(),method:"system.status",payload:{}})));',
    '    const d1 = await recv(ws2);',
    '    check("zero-grant request denied", d1.body && (JSON.parse(d1.body).error || (JSON.parse(d1.body).result && JSON.parse(d1.body).result.error)));',
    '    ws2.close();',
    '',
    '    // Test 4: Replay nonce rejected',
    '    const ws3 = await connect(url);',
    '    const ch3 = await recv(ws3);',
    '    ws3.send(makeHello(PKEY, PID, ch3.challenge, ch3.connectionId));',
    '    await recv(ws3);',
    '    const replayNonce = randomUUID().replace(/-/g, "");',
    '    const reqBody = JSON.stringify({version:1,requestId:randomUUID(),method:"system.status",payload:{}});',
    '    ws3.send(makeReq(PKEY, PID, reqBody, replayNonce));',
    '    await recv(ws3);',
    '    ws3.send(makeReq(PKEY, PID, reqBody, replayNonce));',
    '    const rr = await recv(ws3);',
    '    check("replay nonce rejected", rr.body && (JSON.parse(rr.body).error || (JSON.parse(rr.body).result && JSON.parse(rr.body).result.error)));',
    '    ws3.close();',
    '',
    '  } catch (e) { console.error("CLIENT ERROR:", e.message); fails++; }',
    '  process.exit(fails > 0 ? 1 : 0);',
    '})();',
  ].join("\n");

  const testProc = spawn(process.execPath, ["-e", testScript], {
    stdio: ["inherit", "inherit", "inherit"],
    env: Object.assign({}, process.env, { NODE_PATH: resolve(ROOT, "node_modules") }),
  });

  const testCode = await new Promise(r => { testProc.on("exit", r); });

  // 6b. Typed signed-WSS cascade phase (#1511) — public client through the
  // signed endpoint, outbox inside the disposable smoke root.
  const outboxDir = join(tmp, "outbox");
  mkdirSync(outboxDir, { recursive: true });
  chmodSync(outboxDir, 0o700);
  const outboxFile = join(outboxDir, "smoke-peer.json");
  const ncOutboxFile = join(outboxDir, "no-cascade.json");

  const typedScript = [
    'const PORT = ' + port + ';',
    'const FP = ' + JSON.stringify(fingerprint) + ';',
    'const PID = "smoke-peer";',
    'const NCID = "no-cascade";',
    'const PKEY_PATH = ' + JSON.stringify(peer1.keyPath) + ';',
    'const NCKEY_PATH = ' + JSON.stringify(noCascade.keyPath) + ';',
    'const OUTBOX_PATH = ' + JSON.stringify(outboxFile) + ';',
    'const NCOUTBOX_PATH = ' + JSON.stringify(ncOutboxFile) + ';',
    'const ROOT = ' + JSON.stringify(ROOT) + ';',
    'const { pathToFileURL } = require("url");',
    '',
    'function check(label, ok, detail) {',
    '  if (ok) { console.log("  PASS: " + label); }',
    '  else { console.log("  FAIL: " + label + (detail?" - "+detail:"")); fails++; }',
    '}',
    '',
    'let fails = 0;',
    '',
    '(async () => {',
    '  try {',
    '    const { SignedWssTransport } = await import(pathToFileURL(ROOT + "/dist/src/remote/signed-wss-transport.js").href);',
    '    const { AbmindClient } = await import(pathToFileURL(ROOT + "/dist/src/abmind-client.js").href);',
    '    const { RequestOutbox } = await import(pathToFileURL(ROOT + "/dist/src/remote/request-outbox.js").href);',
    '',
    '    const url = "wss://127.0.0.1:" + PORT;',
    '    const principal = "smoke-principal";',
    '    const marker = "cascade-wss-" + Date.now();',
    '',
    '    const outbox = new RequestOutbox(PID, OUTBOX_PATH);',
    '    const transport = new SignedWssTransport({ name: PID, url, peerId: PID, signingKeyPath: PKEY_PATH, serverCertSha256: FP }, outbox);',
    '    const client = new AbmindClient(transport);',
    '    const caps = await client.negotiate();',
    '    check("signed negotiate advertises private.cascadeDelete", caps.methods.includes("private.cascadeDelete"));',
    '    check("signed negotiate advertises private.recordMessage", caps.methods.includes("private.recordMessage"));',
    '',
    '    const m1 = await client.privateMemory.recordMessage({ userId: principal, sessionId: "s-wss", role: "user", content: "cascade wss source " + marker + "-1", timestamp: Date.now() }, "wss-record-1");',
    '    const m2 = await client.privateMemory.recordMessage({ userId: principal, sessionId: "s-wss", role: "user", content: "cascade wss source " + marker + "-2", timestamp: Date.now() }, "wss-record-2");',
    '    check("signed recordMessage returns ids", typeof m1.id === "number" && typeof m2.id === "number");',
    '',
    '    const stored = await client.privateMemory.instantStore({',
    '      userId: principal,',
    '      contentEn: "Cascade WSS linked memory " + marker,',
    '      contentOriginal: "Cascade WSS linked memory " + marker,',
    '      memoryType: "fact",',
    '      emotionScore: 0.5,',
    '      sourceMessageIds: String(m1.id),',
    '      createdBy: "wss-smoke",',
    '    }, "wss-store-linked");',
    '    check("signed instantStore links source", stored.stored === true && typeof stored.memoryId === "number");',
    '',
    '    const key = "wss-cascade-key";',
    '    const payload = { userId: principal, messageIds: [m1.id] };',
    '    const deleted = await client.privateMemory.cascadeDelete(payload, key);',
    '    check("signed cascade exact counts", deleted.messagesRemoved === 1 && deleted.linkedMemoriesRemoved === 1 && deleted.embeddingsRemoved === 0, JSON.stringify(deleted));',
    '',
    '    const conv = await client.privateMemory.getRecentConversation({ userId: principal, since: 0, limit: 100 });',
    '    const marker1 = marker + "-1";',
    '    const marker2 = marker + "-2";',
    '    check("signed cascade durable absence", !conv.some(m => m.content.includes(marker1)) && conv.some(m => m.content.includes(marker2)));',
    '',
    '    const replay = await client.privateMemory.cascadeDelete(payload, key);',
    '    check("signed exact-key replay returns original result", JSON.stringify(replay) === JSON.stringify(deleted));',
    '',
    '    let conflict = false;',
    '    try {',
    '      await client.privateMemory.cascadeDelete({ userId: principal, messageIds: [m1.id, m2.id] }, key);',
    '    } catch (err) {',
    '      conflict = err && err.code === "idempotency_conflict";',
    '    }',
    '    check("signed changed-payload reuse conflicts", conflict);',
    '',
    '    const fresh = await client.privateMemory.cascadeDelete(payload, "wss-cascade-key-2");',
    '    check("signed fresh-key retry returns zeros", fresh.messagesRemoved === 0 && fresh.linkedMemoriesRemoved === 0 && fresh.embeddingsRemoved === 0, JSON.stringify(fresh));',
    '',
    '    await client.close();',
    '',
    '    // Peer without a cascade grant: no advertisement, no invocation.',
    '    const ncOutbox = new RequestOutbox(NCID, NCOUTBOX_PATH);',
    '    const ncTransport = new SignedWssTransport({ name: NCID, url, peerId: NCID, signingKeyPath: NCKEY_PATH, serverCertSha256: FP }, ncOutbox);',
    '    const ncClient = new AbmindClient(ncTransport);',
    '    const ncCaps = await ncClient.negotiate();',
    '    check("no-cascade peer does not advertise private.cascadeDelete", !ncCaps.methods.includes("private.cascadeDelete"));',
    '    let denied = false;',
    '    try {',
    '      await ncClient.callRaw("private.cascadeDelete", { userId: "no-cascade-principal", messageIds: [1] }, "wss-nc-key");',
    '    } catch (err) {',
    '      denied = err !== null && err !== undefined;',
    '    }',
    '    check("no-cascade peer cannot invoke private.cascadeDelete", denied);',
    '    await ncClient.close();',
    '  } catch (e) { console.error("CLIENT ERROR:", e); fails++; }',
    '  process.exit(fails > 0 ? 1 : 0);',
    '})();',
  ].join("\n");

  const typedProc = spawn(process.execPath, ["-e", typedScript], {
    stdio: ["inherit", "inherit", "inherit"],
    env: Object.assign({}, process.env, { NODE_PATH: resolve(ROOT, "node_modules") }),
  });

  const typedCode = await new Promise(r => { typedProc.on("exit", r); });

  // 7. Clean shutdown
  console.log("  shutting down daemon...");
  daemon.kill("SIGTERM");
  const exited = await new Promise(r => {
    const to = setTimeout(() => r(false), 5000);
    daemon.on("exit", code => { clearTimeout(to); r(code); });
  });
  if (exited === false) { daemon.kill("SIGKILL"); console.log("  WARN: daemon SIGKILL needed"); }

  // 8. Report
  console.log("\n=== Results ===");
  if (testCode === 0 && typedCode === 0) {
    console.log("  ALL TWO-PROCESS SMOKE TESTS PASSED");
  } else {
    console.log("  SOME TESTS FAILED (see above)");
    if (testCode !== 0) console.log("  raw-wire phase exit code: " + testCode);
    if (typedCode !== 0) console.log("  signed cascade phase exit code: " + typedCode);
  }

  if (!keepTmp) { rmSync(tmp, { recursive: true, force: true }); console.log("  temp dir cleaned up"); }
  process.exit(testCode === 0 && typedCode === 0 ? 0 : 1);
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
