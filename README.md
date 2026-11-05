# opencode-forge

A collection of OpenCode artifacts: plugins, skills, commands, and themes.

## Artifacts

### `plugins/skills-git-widget`

A TUI sidebar widget for OpenCode V2 with two sections:

- **Skills** — skills used in the current session, de-duplicated and ordered by first use.
- **Git** — branch, ahead/behind when an upstream exists, and staged, modified, untracked, and conflict counts.

It paginates the full session history, caches each session's skills across plugin reloads, aborts in-flight Git reads on unmount, and avoids local Git reads when the connected server is remote. It has no runtime npm dependencies. Register it in the global `~/.config/opencode/cli.json`; see [`plugins/skills-git-widget/README.md`](plugins/skills-git-widget/README.md) for behavior, edge cases, and limitations.

## Registering a V2 TUI plugin

V2 terminal configuration lives in `~/.config/opencode/cli.json` (or `$XDG_CONFIG_HOME/opencode/cli.json`). There is no project-local CLI config. Add the plugin path to the `plugins` array, preserving existing entries:

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": [
    "/home/nelson/dev/active/opencode-forge/plugins/skills-git-widget"
  ]
}
```

[`cli.json.example`](cli.json.example) shows the minimal entry.

`tui.json` is a V1 contract and is not used by V2. The V2 slot is `sidebar.content`; the V1 `sidebar_content` slot and `api.slots.register()` are not part of this plugin.
