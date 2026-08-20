# Daemon Service

Run abmind's memory service as a native background daemon — supervised, auto-restarting, and alive across sessions. The daemon holds an exclusive owner lease, serves memory requests over a Unix socket, and is managed through a single `abmind service` command.

## Service name

The service unit is named `abmind-daemon` on both platforms.

## Commands

| Command | Description |
|---------|-------------|
| `abmind service install` | Install the service unit (systemd --user on Linux, launchd on macOS) |
| `abmind service uninstall` | Remove the service unit |
| `abmind service start` | Start the service |
| `abmind service stop` | Stop the service |
| `abmind service restart` | Restart the service |
| `abmind service status` | Show service status |

```bash
abmind service install
abmind service start
abmind service status
```

## Linux (systemd --user)

- Unit: `~/.config/systemd/user/abmind-daemon.service`
- Logs: `journalctl --user -u abmind-daemon`

The unit runs the daemon in foreground with `--wait-for-owner`, so it adopts ownership gracefully if a manually-started daemon exits, and restarts under supervision on failure.

### Starting at boot

systemd --user services stop when the user session ends unless lingering is enabled. To keep the daemon alive across reboots and logins:

```bash
sudo loginctl enable-linger $USER
```

`abmind service status` reports this as a remediation step when linger is off.

## macOS (launchd)

- Plist: a per-user LaunchAgent under `~/Library/LaunchAgents`
- Logs: `log show --predicate 'process == "abmind"'`

LaunchAgents start automatically at login; no extra configuration needed.

## How it works

- The daemon acquires the exclusive **owner lease** (single-writer guarantee — no two daemons can serve the same memory store)
- It initializes the memory manager and listens for V1 protocol requests on the Unix socket at `~/.abmind/run/abmind.sock`
- Shutdown order: reject new calls → drain → close listener → close DB → release lease

You should **not** run `abmind-daemon` directly — the `service` subcommand installs and drives it via the native supervisor. The internal entry point is `abmind daemon` for advanced use only.

## Troubleshooting

| Symptom | Check |
|---------|-------|
| Service not running after reboot | `loginctl show-user $USER` — `Linger` must be `yes` (see above) |
| Startup failures | `journalctl --user -u abmind-daemon` (Linux) or `log show --predicate 'process == "abmind"'` (macOS) |
| Lease conflict | A manually-started daemon or another instance holds the lease — stop it, then restart the service |
