#!/usr/bin/env node
/**
 * abmind install [--upgrade] [--force] — first-time setup of ~/.abmind.
 *
 * Seeds config, memory core files, encryption key. CLI wrappers are
 * managed by abtars deploy (writes to ~/.local/bin/).
 */

import { mkdir, stat } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyManifest, packagePaths, readManifest, writeManifest } from '../src/deploy-lib/index.js';

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** True for any fs entry, incl. dangling symlinks (unlike exists() which follows). */
async function existsAny(p: string): Promise<boolean> {
  try {
    const { lstat } = await import('node:fs/promises');
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function isFlatLayout(home: string): Promise<boolean> {
  // abmind never had a releases/ layout pre-158. "Flat" for abmind means
  // an existing ~/.abmind/ without manifest.json. No dist/ shipped to the
  // runtime root previously — abmind always ran from the repo or npm install.
  const hasManifest = await exists(join(home, 'manifest.json'));
  const hasHome = await exists(home);
  return hasHome && !hasManifest;
}

async function createSkeleton(home: string, dryRun: boolean): Promise<void> {
  const dirs = [
    join(home, 'config'),
    join(home, 'memory'),
    join(home, 'secret'),
    join(home, 'prompts', 'sleep'),
  ];
  if (dryRun) {
    process.stdout.write(`[dry-run] mkdir -p:\n  ${dirs.join('\n  ')}\n`);
    return;
  }
  for (const d of dirs) await mkdir(d, { recursive: true });
}



/** Seed/refresh deploy-shipped files into $ABMIND_HOME/memory/core/. */
function seedCoreFiles(repoRoot: string, home: string, agentName: string): void {
  const dst = join(home, 'memory', 'core');
  mkdirSync(dst, { recursive: true });
  // SOUL.md: personalize with agentName on first install
  const soulDst = join(dst, 'SOUL.md');
  if (!existsSync(soulDst)) {
    const soulSrc = join(repoRoot, 'templates', 'memory', 'core', 'SOUL.md');
    if (existsSync(soulSrc)) {
      let content = readFileSync(soulSrc, 'utf-8');
      content = content.replaceAll('<agentName>', agentName);
      writeFileSync(soulDst, content, { mode: 0o600 });
    }
  }
}







/** #1160: Auto-discover username + agentName from abtars config if installed first. */
function discoverFromAbtars(): { username?: string; agentName?: string } {
  const abtarsHome = join(homedir(), ".abtars");
  const result: { username?: string; agentName?: string } = {};
  try {
    const users = JSON.parse(readFileSync(join(abtarsHome, "config", "users.json"), "utf-8"));
    const master = users.users?.find((u: any) => u.role === "master");
    if (master?.userId) result.username = master.userId;
  } catch {}
  try {
    const peers = JSON.parse(readFileSync(join(abtarsHome, "config", "peers.json"), "utf-8"));
    if (peers.self?.name) result.agentName = peers.self.name;
  } catch {}
  return result;
}

function parseFlags(argv: readonly string[]): { upgrade: boolean; force: boolean; dryRun: boolean; nonInteractive: boolean; passphrase?: string; username?: string; agentName?: string } {
  let passphrase: string | undefined;
  const ppIdx = argv.indexOf('--passphrase');
  if (ppIdx >= 0 && argv[ppIdx + 1]) passphrase = argv[ppIdx + 1];
  let username: string | undefined;
  const unIdx = argv.indexOf('--username');
  if (unIdx >= 0 && argv[unIdx + 1]) username = argv[unIdx + 1];
  let agentName: string | undefined;
  const anIdx = argv.indexOf('--agent-name');
  if (anIdx >= 0 && argv[anIdx + 1]) agentName = argv[anIdx + 1];
  return {
    upgrade: argv.includes('--upgrade'),
    force: argv.includes('--force'),
    dryRun: argv.includes('--dry-run'),
    nonInteractive: argv.includes('--non-interactive'),
    passphrase,
    username,
    agentName,
  };
}

async function run(): Promise<number> {
  const installStart = Date.now();
  const opts = parseFlags(process.argv.slice(2));
  const paths = packagePaths('abmind');
  const home = paths.home;
  const repoRoot = dirname(fileURLToPath(import.meta.url)).replace(/[/\\]dist[/\\]cli$/, '').replace(/[/\\]cli$/, '');

  const homeExists = await exists(home);
  const flat = homeExists ? await isFlatLayout(home) : false;
  const manifest = homeExists ? await readManifest(paths.manifest) : null;

  const { printBanner } = await import("./banner.js");
  await printBanner("install");

  if (homeExists && !flat && manifest && !opts.force && !opts.upgrade) {
    process.stderr.write(
      `~/.abmind already installed at version ${manifest.version || '(unset)'}.\n` +
        `Use 'abmind update' to upgrade, or --force to re-seed missing config.\n`,
    );
    return 2;
  }

  await createSkeleton(home, opts.dryRun);
  process.stdout.write(`✓ skeleton at ${home}\n`);

  // Reconcile templates → runtime tree (seed config + overwrite prompts)
  if (!opts.dryRun) {
    const { reconcile } = await import('../src/reconcile.js');
    reconcile(join(repoRoot, 'templates'), home);
    process.stdout.write(`✓ reconciled templates\n`);
  }

  // Agent name (#725, #1160: discover from abtars if installed)
  const discovered = discoverFromAbtars();
  let agentNameValue = opts.agentName ?? discovered.agentName ?? 'Agent';
  if (!opts.nonInteractive && !opts.agentName && !discovered.agentName) {
    const { createInterface } = await import('node:readline');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    agentNameValue = await new Promise<string>(resolve => {
      rl.question('Agent name (e.g. KP, Molty, HomeBot): ', answer => { rl.close(); resolve(answer.trim() || 'Agent'); });
    });
  }

  if (!opts.dryRun) seedCoreFiles(repoRoot, home, agentNameValue);

  // Re-read manifest: if migration (future) wrote one, don't clobber it.
  const manifestAfter = await readManifest(paths.manifest);
  if (manifestAfter === null && !opts.dryRun) {
    const pkgJson = JSON.parse((await import('node:fs')).readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 'utf-8'));
    await writeManifest(paths.manifest, {
      ...emptyManifest('abmind', hostname()),
      version: pkgJson.version ?? '',
      preMigrationBackup: flat ? join(dirname(home), '.abmind.pre-158.bak') : null,
    });
    process.stdout.write(`✓ manifest initialized at ${paths.manifest}\n`);
  }

  // ── Onboard steps (#716) ──

  if (!opts.dryRun) {
    // Step 0: Write ABMIND_HOME to abtars .env if present and non-default
    const abtarsEnv = join(process.env['HOME'] ?? '', '.abtars', 'config', '.env');
    if (home !== join(process.env['HOME'] ?? '', '.abmind') && existsSync(abtarsEnv)) {
      const { readFileSync, appendFileSync } = await import('node:fs');
      const envContent = readFileSync(abtarsEnv, 'utf-8');
      if (!envContent.includes('ABMIND_HOME')) {
        appendFileSync(abtarsEnv, `\nABMIND_HOME=${home}\n`);
        process.stdout.write(`✓ wrote ABMIND_HOME to abtars .env\n`);
      }
    }

    // Step 1: Native deps → ~/.local/lib/ (shared with abtars)
    const libDir = join(process.env['HOME'] ?? homedir(), '.local', 'lib');
    await mkdir(libDir, { recursive: true });
    if (!existsSync(join(libDir, 'node_modules', 'better-sqlite3'))) {
      process.stdout.write(`→ Installing native deps (better-sqlite3, sqlite-vec)...\n`);
      const { execSync } = await import('node:child_process');
      try {
        if (!existsSync(join(libDir, 'package.json'))) {
          execSync('npm init -y', { cwd: libDir, stdio: 'pipe' });
        }
        execSync('npm install better-sqlite3 sqlite-vec --loglevel=error', { cwd: libDir, stdio: 'pipe', timeout: 120_000 });
        process.stdout.write(`✓ native deps installed\n`);
      } catch (err) {
        process.stderr.write(`⚠ native deps failed: ${err instanceof Error ? err.message : String(err)}\n`);
        process.stderr.write(`  Try manually: cd ${libDir} && npm install better-sqlite3\n`);
      }
    } else {
      process.stdout.write(`✓ native deps already present\n`);
    }

    // Step 2: Ollama embedding check
    try {
      const res = await fetch('http://localhost:11434/api/tags');
      if (res.ok) {
        const data = await res.json() as { models?: Array<{ name: string }> };
        const hasNomic = data.models?.some(m => m.name.includes('nomic-embed-text'));
        if (!hasNomic) {
          process.stdout.write(`→ Pulling nomic-embed-text for embeddings...\n`);
          await fetch('http://localhost:11434/api/pull', { method: 'POST', body: JSON.stringify({ name: 'nomic-embed-text' }) });
        }
        process.stdout.write(`✓ embedding model available\n`);
        const envMemory = join(paths.config, '.env.memory');
        if (existsSync(envMemory)) {
          const { readFileSync, writeFileSync: wf } = await import('node:fs');
          let content = readFileSync(envMemory, 'utf-8');
          if (!content.includes('EMBEDDING_ENABLED=true')) {
            content = content.replace(/^#?\s*EMBEDDING_ENABLED=.*/m, 'EMBEDDING_ENABLED=true');
            if (!content.includes('EMBEDDING_ENABLED')) content += '\nEMBEDDING_ENABLED=true\n';
            wf(envMemory, content);
          }
        }
      } else {
        process.stdout.write(`⚠ ollama not reachable — embeddings disabled (FTS+trigram still work)\n`);
      }
    } catch {
      process.stdout.write(`⚠ ollama not running — embeddings disabled (FTS+trigram still work)\n`);
    }

    // Step 3: Encryption passphrase
    let encryptionKey: Buffer | null = null;
    let encryptionUser: string | undefined;
    const keyFilePath = join(home, 'secret', 'abmind.key');
    if (existsSync(keyFilePath)) {
      // Key already exists (restored from backup or previous install) — preserve it
      const crypto = await import('../src/crypto.js');
      encryptionKey = crypto.loadKeyFromFile(keyFilePath);
      crypto.writeKeyVerify(encryptionKey);
      process.stdout.write(`✓ existing encryption key preserved\n`);
    } else if (opts.passphrase || !opts.nonInteractive) {
      try {
        // Ask for user name (used as encryption salt — portable across agents)
        // #1160: discover from abtars config first
        if (!opts.nonInteractive && !discovered.username) {
          const { createInterface } = await import('node:readline');
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          encryptionUser = await new Promise<string>(resolve => {
            rl.question('Your name (used for encryption, e.g. aksika): ', answer => { rl.close(); resolve(answer.trim()); });
          });
        }
        if (!encryptionUser) encryptionUser = opts.username ?? discovered.username ?? process.env['USER'] ?? 'default';

        let passphrase = opts.passphrase;
        if (!passphrase && !opts.nonInteractive) {
          const { createInterface } = await import('node:readline');
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          passphrase = await new Promise<string>(resolve => {
            rl.question('Encryption passphrase (protects secrets at rest, empty to skip): ', answer => { rl.close(); resolve(answer.trim()); });
          });
        }
        if (passphrase) {
          const crypto = await import('../src/crypto.js');
          encryptionKey = crypto.deriveFromPassphrase(passphrase, encryptionUser);
          crypto.writeKeyVerify(encryptionKey);
          // Write key file so bridge can decrypt from systemd (no keyring/D-Bus needed)
          const keyFilePath = join(home, 'secret', 'abmind.key');
          await mkdir(join(home, 'secret'), { recursive: true });
          const { writeFileSync: wfk } = await import('node:fs');
          wfk(keyFilePath, encryptionKey.toString('hex'), { mode: 0o600 });
          process.stdout.write(`✓ encryption key derived\n`);
          try { const kr = await import('../src/keyring.js'); kr.writeToKeyring(passphrase); process.stdout.write(`✓ key stored in OS keyring\n`); } catch { /* optional */ }
        } else {
          process.stdout.write(`⚠ no passphrase — secrets not encrypted at rest\n`);
        }
      } catch (err) {
        process.stderr.write(`⚠ encryption setup failed: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }

    // Store encryptionUser in manifest
    if (encryptionUser && !opts.dryRun) {
      const m = await readManifest(paths.manifest);
      if (m) { (m as any).encryptionUser = encryptionUser; (m as any).agentName = agentNameValue; await writeManifest(paths.manifest, m); }
    }

    // Step 4: Initialize memory DB
    try {
      const { MemoryManager } = await import('../src/memory-manager.js');
      const { loadMemoryConfig } = await import('../src/memory-config.js');
      const memory = new MemoryManager(loadMemoryConfig());
      await memory.initialize({ skipEmbeddingCheck: true });
      memory.close();
      process.stdout.write(`✓ memory.db initialized\n`);
    } catch (err) {
      process.stderr.write(`⚠ memory DB init failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }

    // Step 6: Seed user_profile.md (#717)
    const profilePath = join(home, 'memory', 'core', 'user_profile.md');
    if (!existsSync(profilePath)) {
      const { readFileSync, writeFileSync: wf } = await import('node:fs');
      await mkdir(dirname(profilePath), { recursive: true });
      const tplPath = join(repoRoot, 'templates', 'memory', 'core', 'user_profile.md');
      if (existsSync(tplPath)) {
        wf(profilePath, readFileSync(tplPath, 'utf-8'), { mode: 0o600 });
      } else {
        wf(profilePath, `# User Profile\n\nWrite observations about the user here.\n`, { mode: 0o600 });
      }
      process.stdout.write(`✓ user_profile.md seeded\n`);
    }
  }

  // Symlink for abtars ESM resolution (#722)
  if (!opts.dryRun) {
    const { homedir } = await import('node:os');
    const { symlinkSync, lstatSync, readlinkSync } = await import('node:fs');
    const abtarsCurrent = join(homedir(), '.abtars', 'current');
    if (existsSync(abtarsCurrent)) {
      const nmDir = join(abtarsCurrent, 'node_modules');
      mkdirSync(nmDir, { recursive: true });
      const globalModules = join(dirname(process.execPath), '..', 'lib', 'node_modules');
      const abmindPkg = join(globalModules, 'abmind');
      const abmindTarget = join(nmDir, 'abmind');
      if (existsSync(abmindPkg) && !existsSync(abmindTarget)) {
        try { symlinkSync(abmindPkg, abmindTarget); process.stdout.write(`✓ abtars symlink: ${abmindTarget} → ${abmindPkg}\n`); }
        catch { /* best effort */ }
      }
      const bsq3 = join(home, 'lib', 'node_modules', 'better-sqlite3');
      const bsq3Target = join(nmDir, 'better-sqlite3');
      if (existsSync(bsq3) && !existsSync(bsq3Target)) {
        try { symlinkSync(bsq3, bsq3Target); } catch { /* best effort */ }
      }
    }
  }

  // Install log (#722 — detailed)
  const { appendFileSync } = await import('node:fs');
  const { homedir: hd } = await import('node:os');
  const abtarsSymlink = join(hd(), '.abtars', 'current', 'node_modules', 'abmind');
  const soulFile = join(home, 'memory', 'core', 'SOUL.md');
  const soulOk = existsSync(soulFile) && !(await import('node:fs')).readFileSync(soulFile, 'utf-8').includes('<agentName>');
  const elapsed = Math.round((Date.now() - installStart) / 1000);
  const logLines = [
    `\n=== abmind install ${new Date().toISOString().slice(0, 16)} ===`,
    `✓ node: ${process.version}`,
    `✓ platform: ${process.platform}/${process.arch}`,
    `✓ home: ${home}`,
    `✓ version: ${(await readManifest(paths.manifest))?.version ?? '?'}`,
    `✓ agent name: ${agentNameValue}`,
    `✓ SOUL.md: ${soulOk ? 'seeded (personalized)' : existsSync(soulFile) ? '⚠ placeholder — re-run with --force' : 'missing'}`,
    `✓ user_profile.md: ${existsSync(join(home, 'memory', 'core', 'user_profile.md')) ? 'seeded' : 'missing'}`,
    `✓ core templates: ${existsSync(join(home, 'memory', 'core', 'memory-tools.md')) ? 'seeded' : 'missing'}`,
    `✓ sleep prompts: ${existsSync(join(home, 'prompts')) ? 'seeded' : 'missing'}`,
    `✓ native deps: ${existsSync(join(home, 'lib', 'node_modules', 'better-sqlite3')) ? 'better-sqlite3 ✓' : 'better-sqlite3 ✗'}, ${existsSync(join(home, 'lib', 'node_modules', 'sqlite-vec')) ? 'sqlite-vec ✓' : 'sqlite-vec ✗'}`,
    `✓ ollama: ${existsSync('/usr/local/bin/ollama') || existsSync('/opt/homebrew/bin/ollama') ? 'found' : 'not found'}`,
    `✓ embedding: nomic-embed-text`,
    `✓ encryption: ${existsSync(join(home, 'secret', 'abmind.key')) ? 'key file ✓' : 'no key (plaintext mode)'}`,
    `✓ key.verify: ${existsSync(join(home, 'secret', 'key.verify')) ? '✓' : '✗'}`,
    `✓ memory.db: ${existsSync(join(home, 'memory', 'memory.db')) ? 'initialized' : 'missing'}`,
    existsSync(abtarsSymlink) ? `✓ abtars symlink: ${abtarsSymlink}` : (existsSync(join(hd(), '.abtars')) ? '⚠ abtars found but symlink missing' : '⏭ abtars not installed (standalone mode)'),
    `✓ duration: ${elapsed}s`,
  ];
  try { appendFileSync(join(home, 'install.log'), logLines.join('\n') + '\n'); } catch { /* best effort */ }

  process.stdout.write(`\nabmind install complete.\n`);
  return 0;
}

const exitCode = await run();
process.exit(exitCode);
