# Laya sidecar (retired)

**The Laya sidecar is no longer part of abmind.** It existed only to serve the
optional System One judgment/rerank layer, which the owned recall pipeline
removed. abmind constructs no judgment provider, probes no sidecar, and ships
no `abmind laya` command.

Nothing on this page is an instruction to run anything.

## If you deployed it previously

- Remove the managed service unit with your OS service manager
  (`systemctl --user` on Linux, `launchd` on macOS) if one is still installed.
- `LAYA_URL` and the rest of the `SYSTEM1*`/`JEV*`/`LAYA*` variables are
  inert; delete them from `~/.abmind/config/.env.memory` or leave them.
- The virtualenv and model checkpoint under your home directory are unused by
  abmind and can be deleted at your discretion.

## Historical artifacts

`scripts/laya-server.py` and `scripts/laya-update.sh` remain in the repository
as historical artifacts to document how the retired sidecar worked. No abmind
component calls them. See [System One judgments (retired)](judgment.md).
