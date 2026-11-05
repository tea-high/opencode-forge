/** @jsxImportSource @opentui/solid */
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { hostname } from "node:os"
import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack } from "solid-js"
import {
  readSessionSkills,
  rememberSessionSkills,
  type SkillMemory,
} from "./cache.ts"
import { isRemoteHostname, readGitStatus, type GitRead, type GitStatus } from "./git.ts"
import {
  activationEntry,
  buildSkillCatalog,
  collectMessagePages,
  mergeSkillEntries,
  scanActivatedSkills,
  scanAssistantSkills,
  toolPartEntry,
  type SkillEntry,
  type SkillMessage,
  type SkillMessagePart,
} from "./skills.ts"

const SKILL_PAGE_SIZE = 200
const SKILL_RECENT_SIZE = 200
const GIT_REFRESH_MS = 3_000
const GIT_EVENT_DEBOUNCE_MS = 250
const SKILL_RESCAN_DEBOUNCE_MS = 500
const SERVER_INFO_TIMEOUT_MS = 2_000
const MEMORY_KEY = "opencode-forge.skills-git-widget"

type PluginContext = ReturnType<typeof usePlugin>
type SkillsStatus = "loading" | "ready" | "error"
type GitView =
  | GitRead
  | { status: "loading" }
  | { status: "no-directory" }
  | { status: "remote" }

type Palette = {
  base: string | undefined
  dim: string | undefined
  accent: string | undefined
  warning: string | undefined
  danger: string | undefined
}

type GitCount = {
  glyph: string
  label: string
  count: number
  danger: boolean
}

function themeColor(context: PluginContext, ...paths: readonly string[][]): string | undefined {
  for (const path of paths) {
    let node: unknown = context.theme
    for (const key of path) {
      if (!node || typeof node !== "object") {
        node = undefined
        break
      }
      node = (node as Record<string, unknown>)[key]
    }
    if (typeof node === "string" && node) return node
  }
  return undefined
}

function paletteOf(context: PluginContext): Palette {
  const base = themeColor(context, ["text", "base"])
  const dim = themeColor(context, ["text", "muted"], ["text", "faint"]) ?? base
  const accent =
    themeColor(context, ["syntax", "function"], ["syntax", "variable"], ["text", "base"]) ?? base
  const warning =
    themeColor(
      context,
      ["text", "feedback", "warning", "base"],
      ["syntax", "type"],
      ["syntax", "number"],
    ) ?? accent
  const danger =
    themeColor(
      context,
      ["text", "feedback", "error", "base"],
      ["text", "feedback", "warning", "base"],
    ) ?? warning
  return { base, dim, accent, warning, danger }
}

function locationFor(context: PluginContext, sessionID: string) {
  try {
    return (
      context.data.session.get(sessionID)?.location ??
      context.location ??
      context.data.location.default()
    )
  } catch {
    return undefined
  }
}

function catalogFor(context: PluginContext, location: ReturnType<typeof locationFor>) {
  try {
    return buildSkillCatalog(context.data.location.skill.list(location) as unknown[])
  } catch (error) {
    console.error("[skills-git-widget] failed to read the skill catalog", error)
    return new Map<string, string>()
  }
}

function isAbortError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      ((error as { name?: unknown }).name === "AbortError" ||
        (error as { code?: unknown }).code === "ABORT_ERR"),
  )
}

function Widget(props: { sessionID: string }) {
  const context = usePlugin()
  const palette = createMemo(() => paletteOf(context))

  const [memory, updateMemory] = context.storage.memory<SkillMemory>(MEMORY_KEY, {
    initial: { sessions: {} },
  })
  const [skills, setSkills] = createSignal<SkillEntry[]>([])
  const [skillsStatus, setSkillsStatus] = createSignal<SkillsStatus>("loading")
  const [git, setGit] = createSignal<GitView>({ status: "loading" })

  const persist = (sessionID: string, entries: readonly SkillEntry[]) => {
    updateMemory((draft) => rememberSessionSkills(draft, sessionID, entries))
  }

  // — Skills ————————————————————————————————————————————————————————
  // Two sources, one list: explicit skilling creates a skill message, while
  // the model's `skill` tool call only leaves a completed tool part inside an
  // assistant message. Both count as use; neither source alone is complete.
  createEffect(() => {
    const sessionID = props.sessionID
    const location = locationFor(context, sessionID)
    let disposed = false
    let fullStarted = false
    let recentRunning = false
    let recentQueued = false
    let rescanTimer: ReturnType<typeof setTimeout> | undefined
    const controllers = new Set<AbortController>()

    const seeded = untrack(() => readSessionSkills(memory, sessionID))
    setSkills(seeded)
    setSkillsStatus(seeded.length > 0 ? "ready" : "loading")

    const apply = (entries: readonly SkillEntry[]) => {
      const next = mergeSkillEntries(skills(), entries)
      setSkills(next)
      persist(sessionID, next)
    }

    const fetchPage = (
      type: "assistant" | "skill",
      order: "asc" | "desc",
      cursor: string | undefined,
      signal: AbortSignal,
      limit = SKILL_PAGE_SIZE,
    ) =>
      context.client.message.list(
        {
          sessionID,
          type,
          limit,
          ...(cursor ? { cursor } : { order }),
        },
        { signal },
      )

    const load = async (kind: "full" | "recent") => {
      const controller = new AbortController()
      controllers.add(controller)
      try {
        const assistantRequest =
          kind === "full"
            ? collectMessagePages(
                (cursor) => fetchPage("assistant", "asc", cursor, controller.signal),
                controller.signal,
              )
            : fetchPage(
                "assistant",
                "desc",
                undefined,
                controller.signal,
                SKILL_RECENT_SIZE,
              ).then((page) => page.data)
        const activatedRequest =
          kind === "full"
            ? collectMessagePages(
                (cursor) => fetchPage("skill", "asc", cursor, controller.signal),
                controller.signal,
              )
            : fetchPage(
                "skill",
                "desc",
                undefined,
                controller.signal,
                SKILL_RECENT_SIZE,
              ).then((page) => page.data)

        const [assistant, activated] = await Promise.allSettled([
          assistantRequest,
          activatedRequest,
        ])
        if (disposed) return

        if (assistant.status === "rejected" && !isAbortError(assistant.reason)) {
          console.error("[skills-git-widget] failed to load assistant messages", assistant.reason)
        }
        if (activated.status === "rejected" && !isAbortError(activated.reason)) {
          console.error("[skills-git-widget] failed to load skill messages", activated.reason)
        }
        if (assistant.status === "rejected" && activated.status === "rejected") {
          if (skills().length === 0) setSkillsStatus("error")
          return
        }

        const catalog = catalogFor(context, location)
        const found = mergeSkillEntries(
          scanAssistantSkills(
            assistant.status === "fulfilled"
              ? (assistant.value as unknown as readonly SkillMessage[])
              : [],
            catalog,
            Date.now(),
          ),
          scanActivatedSkills(
            activated.status === "fulfilled"
              ? (activated.value as unknown as readonly SkillMessage[])
              : [],
            catalog,
            Date.now(),
          ),
        )
        apply(found)
        setSkillsStatus("ready")
      } catch (error) {
        if (disposed || isAbortError(error)) return
        console.error("[skills-git-widget] failed to load skills", error)
        if (skills().length === 0) setSkillsStatus("error")
      } finally {
        controllers.delete(controller)
      }
    }

    const loadFull = () => {
      if (fullStarted) return
      fullStarted = true
      void load("full")
    }

    const loadRecent = async () => {
      if (recentRunning) {
        recentQueued = true
        return
      }
      recentRunning = true
      try {
        await load("recent")
      } finally {
        recentRunning = false
        if (recentQueued && !disposed) {
          recentQueued = false
          void loadRecent()
        }
      }
    }

    const scheduleRescan = () => {
      if (disposed) return
      if (rescanTimer) clearTimeout(rescanTimer)
      rescanTimer = setTimeout(() => {
        rescanTimer = undefined
        void loadRecent()
      }, SKILL_RESCAN_DEBOUNCE_MS)
    }

    const stop = context.data.listen(({ details }) => {
      if (disposed) return

      if (details.type === "session.skill.activated") {
        const data = details.data as {
          sessionID?: unknown
          id?: unknown
          name?: unknown
        }
        if (data.sessionID !== sessionID) return
        const next = activationEntry(data, catalogFor(context, location))
        if (next) apply([next])
        return
      }

      if (details.type === "session.idle") {
        const data = details.data as { sessionID?: unknown }
        if (data.sessionID === sessionID) scheduleRescan()
        return
      }

      if (details.type !== "session.tool.success") return

      const data = details.data as {
        sessionID?: unknown
        assistantMessageID?: unknown
        id?: unknown
      }
      if (data.sessionID !== sessionID) return
      if (typeof data.assistantMessageID !== "string" || typeof data.id !== "string") {
        scheduleRescan()
        return
      }

      const message = context.data.session.message.get(sessionID, data.assistantMessageID)
      const content = (message as { content?: unknown } | undefined)?.content
      if (!Array.isArray(content)) {
        scheduleRescan()
        return
      }

      const part = (content as SkillMessagePart[]).find(
        (candidate) => candidate && candidate.type === "tool" && candidate.id === data.id,
      )
      if (!part) {
        scheduleRescan()
        return
      }
      if (part.name !== "skill") return

      const next = toolPartEntry(part, catalogFor(context, location), Date.now())
      if (next) apply([next])
      else scheduleRescan()
    })

    onCleanup(() => {
      disposed = true
      if (rescanTimer) clearTimeout(rescanTimer)
      for (const controller of controllers) controller.abort()
      controllers.clear()
      stop()
    })

    loadFull()
  })

  // — Git ————————————————————————————————————————————————————————————
  // The V2 VCS API exposes a branch but not file counts or ahead/behind, so
  // this block shells out to one read-only porcelain call. A timer covers
  // changes made outside OpenCode; file and branch events make the common
  // in-app changes appear immediately.
  createEffect(() => {
    const sessionID = props.sessionID
    const directory = locationFor(context, sessionID)?.directory
    let disposed = false
    let reading = false
    let queued = false
    let timer: ReturnType<typeof setInterval> | undefined
    let debounce: ReturnType<typeof setTimeout> | undefined
    let active: AbortController | undefined
    let stopEvents: (() => void) | undefined

    setGit({ status: "loading" })

    if (!directory) {
      setGit({ status: "no-directory" })
      onCleanup(() => {
        disposed = true
      })
      return
    }

    const run = () => {
      if (disposed) return
      if (reading) {
        queued = true
        return
      }

      reading = true
      const controller = new AbortController()
      active = controller
      void readGitStatus(directory, { signal: controller.signal })
        .then((next) => {
          reading = false
          if (active === controller) active = undefined
          if (disposed || next.status === "aborted") return
          setGit(next)
          if (queued) {
            queued = false
            run()
          }
        })
        .catch((error) => {
          reading = false
          if (active === controller) active = undefined
          if (disposed) return
          console.error("[skills-git-widget] failed to read git status", error)
          setGit({ status: "unavailable" })
          if (queued) {
            queued = false
            run()
          }
        })
    }

    const schedule = () => {
      if (disposed) return
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => {
        debounce = undefined
        run()
      }, GIT_EVENT_DEBOUNCE_MS)
    }

    const start = () => {
      if (disposed) return
      run()
      timer = setInterval(run, GIT_REFRESH_MS)
      stopEvents = context.data.listen(({ details }) => {
        if (details.type !== "filesystem.changed" && details.type !== "vcs.branch.updated") {
          return
        }
        const eventDirectory = (details as { location?: { directory?: unknown } }).location
          ?.directory
        if (typeof eventDirectory === "string" && eventDirectory !== directory) return
        schedule()
      })
    }

    onCleanup(() => {
      disposed = true
      active?.abort()
      if (timer) clearInterval(timer)
      if (debounce) clearTimeout(debounce)
      stopEvents?.()
    })

    // A remote server's working tree is not visible to this local shell.
    // Compare hostnames before spawning git; on an inconclusive check, keep
    // the normal local behaviour rather than hiding the widget.
    void (async () => {
      const identity = new AbortController()
      active = identity
      const timeout = setTimeout(() => identity.abort(), SERVER_INFO_TIMEOUT_MS)
      let remote = false
      try {
        const info = await context.client.server.info({ signal: identity.signal })
        remote = isRemoteHostname(info.hostname, hostname())
      } catch (error) {
        if (!disposed && !isAbortError(error)) {
          console.error("[skills-git-widget] failed to identify the server", error)
        }
      } finally {
        clearTimeout(timeout)
        if (active === identity) active = undefined
      }

      if (disposed) return
      if (remote) {
        setGit({ status: "remote" })
        return
      }
      start()
    })()
  })

  const gitData = createMemo<GitStatus | undefined>(() => {
    const state = git()
    return state.status === "ok" ? state.data : undefined
  })

  const gitMessage = createMemo(() => {
    const state = git()
    switch (state.status) {
      case "loading":
        return "checking..."
      case "no-directory":
        return "no workspace directory"
      case "remote":
        return "git unavailable (remote workspace)"
      case "no-repo":
        return "not a git repository"
      case "timeout":
        return "git timed out"
      case "unavailable":
        return "git unavailable"
      default:
        return undefined
    }
  })

  const gitCounts = createMemo<GitCount[]>(() => {
    const data = gitData()
    if (!data) return []
    const rows: GitCount[] = [
      { glyph: "+", label: "staged", count: data.staged, danger: false },
      { glyph: "~", label: "modified", count: data.modified, danger: false },
      { glyph: "?", label: "untracked", count: data.untracked, danger: false },
      { glyph: "!", label: "conflicts", count: data.conflicts, danger: true },
    ]
    return rows.filter((row) => row.count > 0)
  })

  const skillMessage = createMemo(() => {
    if (skills().length > 0) return undefined
    switch (skillsStatus()) {
      case "loading":
        return "loading..."
      case "error":
        return "skills unavailable"
      default:
        return "no skills used yet"
    }
  })

  return (
    <box flexDirection="column" gap={1} minWidth={0}>
      <box flexDirection="column" minWidth={0}>
        <text fg={palette().base}>
          <b>Skills</b>
          <Show when={skills().length > 0}>
            <span style={{ fg: palette().dim }}> {skills().length}</span>
          </Show>
        </text>
        <Show when={skillMessage()}>
          {(message) => <text fg={palette().dim}>{message()}</text>}
        </Show>
        <For each={skills()}>
          {(skill) => (
            <box flexDirection="row" gap={1} minWidth={0}>
              <text flexShrink={0} fg={palette().dim}>
                ·
              </text>
              <text
                fg={palette().base}
                wrapMode="none"
                truncate
                flexGrow={1}
                flexShrink={1}
                minWidth={0}
              >
                {skill.name}
              </text>
            </box>
          )}
        </For>
      </box>

      <box flexDirection="column" minWidth={0}>
        <text fg={palette().base}>
          <b>Git</b>
        </text>
        <Show when={gitMessage()}>
          {(message) => <text fg={palette().dim}>{message()}</text>}
        </Show>
        <Show when={gitData()}>
          {(data) => (
            <box flexDirection="column" minWidth={0}>
              <text fg={palette().accent} wrapMode="none" truncate>
                {data().branch}
              </text>
              <Show
                when={data().upstream}
                fallback={
                  <text fg={palette().dim}>
                    no upstream
                  </text>
                }
              >
                <Show
                  when={data().ahead !== undefined && data().behind !== undefined}
                  fallback={<text fg={palette().dim}>no comparison</text>}
                >
                  <text>
                    <span style={{ fg: (data().ahead ?? 0) > 0 ? palette().base : palette().dim }}>
                      ↑{data().ahead ?? 0}
                    </span>
                    <span style={{ fg: palette().dim }}> </span>
                    <span
                      style={{ fg: (data().behind ?? 0) > 0 ? palette().warning : palette().dim }}
                    >
                      ↓{data().behind ?? 0}
                    </span>
                  </text>
                </Show>
              </Show>
              <Show when={gitCounts().length > 0} fallback={<text fg={palette().dim}>clean</text>}>
                <For each={gitCounts()}>
                  {(item) => (
                    <text>
                      <span style={{ fg: item.danger ? palette().danger : palette().warning }}>
                        {item.glyph}
                        {item.count}
                      </span>
                      <span style={{ fg: palette().dim }}> {item.label}</span>
                    </text>
                  )}
                </For>
              </Show>
            </box>
          )}
        </Show>
      </box>
    </box>
  )
}

export default Plugin.define({
  id: "opencode-forge.skills-git-widget",
  setup(context) {
    return context.ui.slot({
      append: "sidebar.content",
      render: (slot) => <Widget sessionID={slot.sessionID} />,
    })
  },
})
