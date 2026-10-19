# System One judgments (retired)

**This subsystem no longer exists.** abmind used to optionally ask a narrow
"System One" model (local Laya sidecar or the Jev SaaS) to reorder recall
candidates. The owned recall pipeline removed it: recall uses no generative or
judgment model, and there is nothing to configure or run.

## What this means for you

- `SYSTEM1`, `SYSTEM1_*`, `JEV_*`, and `LAYA_*` variables are inert. Nothing
  reads them; leaving them in `~/.abmind/config/.env.memory` is harmless.
- `abmind status` no longer reports a judgment backend or sidecar state, and
  `abmind doctor` reports the subsystem as retired.
- The `abmind laya ...` command and the managed sidecar service are gone. If
  you previously installed a sidecar unit, remove it with your OS service
  manager; nothing in abmind talks to it.
- `scripts/laya-server.py` and `scripts/laya-update.sh` remain in the
  repository as historical artifacts only. Running them serves a model that
  no abmind build consumes.

Historical run artifacts may still carry a `judgment` field in receipt JSON
files. The receipt reader ignores unknown fields, and settlement never reads
such a field.
