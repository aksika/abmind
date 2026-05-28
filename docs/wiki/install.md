# Installation

See the full [installation guide](https://github.com/aksika/abmind/blob/dev/docs/install.md) on GitHub.

## Quick install

### npm (recommended)

```bash
npm install -g abmind
abmind install
```

### From source

```bash
git clone git@github.com:aksika/abmind.git
cd abmind
npm install && npm run build
node dist/cli/abmind.js install
abmind update
```

## Host integration

Install into your AI tool with one command:

```bash
abmind install-host kiro      # Kiro CLI
abmind install-host claude    # Claude Code
abmind install-host gemini    # Gemini CLI
abmind install-host codex     # OpenAI Codex CLI
```

### Hermes-Agent

Hermes uses a plugin directory instead of `install-host`:

```bash
cp -r <abmind-repo>/hermes-plugin/abmind ~/.hermes/plugins/abmind/
# Then in ~/.hermes/config.yaml:
#   memory:
#     provider: abmind
```

This sets up lifecycle hooks, MCP server registration, and context files. Safe to re-run. Uninstall with `--uninstall`.

## Requirements

- Node.js 22+
- Optional: ollama (for vector embeddings in hybrid search mode)
