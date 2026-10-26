"""abmind declared config surface — rendered by the generic dashboard panel.

Pure-data module: import only ``plugins.memory.config_schema`` here, never the
provider (the web server loads this file by path). Keys match the
``memory.abmind`` block read by the provider plus its ``ABMIND_*`` env
overrides. Storage is flat JSON under the provider block; secrets are absent
by design (remote credentials live in abmind's own client config, never here).
"""

from plugins.memory.config_schema import (
    KIND_NUMBER,
    KIND_SELECT,
    KIND_TEXT,
    STORAGE_FLAT_JSON,
    ProviderConfigSchema,
    ProviderField,
    ProviderFieldOption,
)


def _field(key, label, kind, description, **kw):
    return ProviderField(key=key, label=label, kind=kind, description=description,
                         group="Connection", **kw)


CONFIG_SCHEMA = ProviderConfigSchema(
    name="abmind",
    label="abmind",
    storage=STORAGE_FLAT_JSON,
    docs_url="https://github.com/aksika/abmind",
    fields=(
        _field("mode", "Mode", KIND_SELECT, "Local Unix socket or remote signed WSS profile.",
               default="local", env_fallbacks=("ABMIND_MODE",),
               options=(ProviderFieldOption("local", "Local"),
                        ProviderFieldOption("remote", "Remote")),
               inline=True),
        _field("socket_path", "Socket path", KIND_TEXT, "Local daemon socket path.",
               default="~/.abmind/run/abmind.sock", env_fallbacks=("ABMIND_SOCKET",),
               inline=True),
        _field("remote_profile", "Remote profile", KIND_TEXT,
               "Remote profile name from abmind client config (remote mode).",
               default="", env_fallbacks=("ABMIND_REMOTE_PROFILE",)),
        _field("principal", "Principal", KIND_TEXT,
               "abmind principal to act as (defaults to the Hermes user id). "
               "Must be enabled in the daemon (--lifecycle-write-owners) for capture.",
               default="", env_fallbacks=("ABMIND_PRINCIPAL",), inline=True),
        _field("recall_limit", "Recall limit", KIND_NUMBER, "Max recall hits per turn.",
               default="5", env_fallbacks=("ABMIND_RECALL_LIMIT",)),
        _field("recall_max_chars", "Recall max chars", KIND_NUMBER,
               "Max injected recall chars per turn.",
               default="2000", env_fallbacks=("ABMIND_RECALL_MAX_CHARS",)),
        _field("fallback", "CLI fallback", KIND_SELECT,
               "Explicit opt-in legacy CLI fallback when the bridge is down. Off by default.",
               default="off", env_fallbacks=("ABMIND_FALLBACK",),
               options=(ProviderFieldOption("off", "Off"),
                        ProviderFieldOption("cli", "CLI"))),
    ),
)
