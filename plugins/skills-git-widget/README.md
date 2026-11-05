# skills-git-widget

An OpenCode V2 TUI sidebar widget with two quiet sections:

- **Skills** — every skill used in the current session, de-duplicated and in first-seen order.
- **Git** — current branch, ahead/behind when an upstream exists, and staged, modified, untracked, and conflict counts.

It was built against **OpenCode 2.2.5** and the V2 plugin API. It has no runtime npm dependencies: the TUI resolves `@opencode/plugin/tui`, `solid-js`, and the JSX runtime, and Git is read with `node:child_process`.

## Register it

V2 keeps terminal settings in `~/.config/opencode/cli.json` (or `$XDG_CONFIG_HOME/opencode/cli.json`). There is **no project-local `cli.json`**. Add this plugin to the `plugins` array, preserving any existing entries:

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": [
    "/home/nelson/dev/active/opencode-forge/plugins/skills-git-widget"
  ]
}
```

Replace the path with the absolute path to this directory on your machine. `cli.json` accepts a local directory, an absolute path, or a `file://` URL. A `./plugins/...` path is resolved relative to the global config directory, not the repository, so an absolute path is the least surprising choice for this checkout.

OpenCode watches `cli.json` and reloads plugins after a valid edit. If a source edit is not picked up, run `/reload` or restart the TUI. The sidebar itself can be toggled with `Ctrl+X`, then `b` (`session.sidebar.toggle`).

`opencode.json` is the server/project config. A TUI-only plugin belongs in `cli.json`, which is why this plugin is registered there.

> This is not `tui.json`. That file is a V1 contract. V2 uses `cli.json` and `sidebar.content`, not `tui.json` and `sidebar_content`.

## What it shows

### Skills

The widget merges two sources, because one alone misses real usage:

1. Completed `skill` tool calls inside assistant messages. This is how model-invoked skills appear.
2. Explicit `skill` messages and live `session.skill.activated` events. This covers skills attached or activated directly.

The display name comes from the tool call metadata, the skill catalog, or the skill id, in that order. Entries are de-duplicated by skill id (case-insensitive) and ordered by first use. A later event can improve an id-only label to the real display name; it never reorders the list.

The initial scan walks the session's message cursor to completion for both assistant and skill messages, so usage from the start of a long session is not lost. When live resolution is inconclusive, the fallback rescans only the latest page. Each session's list is cached with `context.storage.memory`, so a plugin hot reload repaints instantly while the full scan repeats in the background. That cache is not durable across a TUI restart.

### Git

One read-only command supplies the whole snapshot:

```sh
git status --porcelain=v2 --branch --untracked-files=normal
```

The widget parses branch name, detached HEAD, upstream, ahead/behind (`# branch.ab`), and the XY index/worktree codes for staged and modified files. Untracked entries and unmerged entries are counted separately. It does not show added/deleted as separate counts; a staged deletion is still staged, and a worktree deletion is still modified.

The command runs with `GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0`, a 5 second timeout, and a 4 MB output cap. It refreshes every 3 seconds, and also reacts to `filesystem.changed` and `vcs.branch.updated` with a 250 ms debounce. Reads never overlap: if an event arrives during a read, one follow-up read is queued. An `AbortController` kills the child process when the slot unmounts or the session changes.

The widget checks the connected server's hostname before spawning Git. If the server is on another host, the directory is not visible to this shell, so it shows a quiet `git unavailable (remote workspace)` line and runs no local command. An inconclusive check keeps normal local behaviour.

Handled states:

| State | Display |
| --- | --- |
| Normal branch | branch name, `↑ahead ↓behind`, nonzero counts |
| No upstream | branch name and dim `no upstream` |
| Detached HEAD | `detached @<short oid>` |
| No repository | dim `not a git repository` |
| Remote server | dim `git unavailable (remote workspace)` |
| Git missing or unreadable | dim `git unavailable` |
| Read exceeded 5 seconds | dim `git timed out` |
| Clean tree | dim `clean` |
| No workspace directory | dim `no workspace directory` |

Malformed porcelain lines are ignored rather than throwing. If the branch header is missing entirely, the read is treated as unavailable.

## Layout and theme

The widget uses one `sidebar.content` claim with `append`, so it coexists with other sidebar plugins instead of replacing them. It reads semantic theme tokens (`text.base`, `text.muted`, `syntax.function`, warning/error feedback colors) and falls back defensively when a token is absent. No Nerd Font glyphs are required.

The combined Skills and Git sections share one session/location lifecycle. Splitting them into two slots would duplicate timers and subscriptions for no visual benefit.

## Development

Run the parser, merge, pagination, and Git integration tests:

```sh
bun test plugins/skills-git-widget/tests
```

The source separates testable logic from the slot component:

- `git.ts` — porcelain parser, command runner, error classification.
- `skills.ts` — message scanning, catalog mapping, de-duplication, first-seen ordering, cursor pagination.
- `cache.ts` — the ephemeral per-session skills cache.
- `tui.tsx` — Solid component, data loading, live events, rendering.

The test suite covers branch parsing, detached HEAD, unborn branches, no upstream, malformed output, both skill sources, catalog fallback, live activation, de-duplication, ordering, fallback-name upgrades, cursor pagination, repeated cursors, abort handling, and real `readGitStatus` error classification (not a repository, missing directory, timeout, abort). The Git tests use a fake `git` executable on `PATH` for the timeout and abort cases.

## Known limitations

- **Full history costs requests.** The initial load follows the message cursor to the end, so a very long session can mean several pages per source. The live path only reads recent pages; the full walk is once per mount/session.
- **Hot-reload cache is ephemeral.** `context.storage.memory` survives a plugin reload but not a TUI exit, by design. A durable `storage.store` would add disk writes for state that can be rebuilt.
- **Remote detection is a hostname comparison.** It catches the common case (TUI here, server elsewhere) without executing Git. Two machines sharing a hostname would be treated as local.
- **Tool-name resolution depends on the message cache.** `session.tool.success` does not include the tool name. The widget looks up the assistant message part by id; if it is not cached yet, it schedules a debounced recent-page rescan.
- **Git is polled.** Changes made outside OpenCode appear within about 3 seconds. In-app file and branch events normally make changes appear faster.
- **V2's VCS data has no counts or ahead/behind.** `data.location.vcs.info()` exposes only the branch, so shelling out to Git is intentional.
- **No stash count, no per-file list.** The sidebar is for orientation, not a replacement for a diff viewer.

## Prior art

The parser approach was informed by the MIT-licensed `opencode-git-status-v1` and `@rizal72/oc-git` projects. Skill event handling was informed by the MIT-licensed `opencode-skills-sidebar`. No code was copied verbatim; the implementation here is intentionally smaller and combines the two concerns in one sidebar claim.
