import { execFile } from "node:child_process"

/** The parts of `git status --porcelain=v2 --branch` this widget renders. */
export type GitStatus = {
  branch: string
  detached: boolean
  oid?: string
  upstream?: string
  ahead?: number
  behind?: number
  staged: number
  modified: number
  untracked: number
  conflicts: number
}

/** A completed read. Every failure mode is represented, so the UI never guesses. */
export type GitRead =
  | { status: "ok"; data: GitStatus }
  | { status: "no-repo" }
  | { status: "unavailable" }
  | { status: "timeout" }
  | { status: "aborted" }

export type GitReadOptions = {
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

/** True only when the server identifies a different host than this process. */
export function isRemoteHostname(
  serverHostname: string | undefined,
  localHostname: string,
): boolean {
  const server = serverHostname?.trim().toLowerCase()
  const local = localHostname.trim().toLowerCase()
  return Boolean(server && local && server !== local)
}

const STATUS_ARGS = [
  "status",
  "--porcelain=v2",
  "--branch",
  "--untracked-files=normal",
] as const

const DEFAULT_TIMEOUT_MS = 5_000
const MAX_BUFFER = 4 * 1024 * 1024

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function shortOid(oid: string | undefined): string {
  return oid && oid !== "(initial)" ? oid.slice(0, 7) : "?"
}

/**
 * Parse porcelain v2 status defensively. Unknown and malformed lines are
 * ignored; a missing branch header means this was not a usable status read.
 */
export function parseGitStatus(output: string): GitStatus | undefined {
  let head: string | undefined
  let oid: string | undefined
  let upstream: string | undefined
  let ahead: number | undefined
  let behind: number | undefined
  let staged = 0
  let modified = 0
  let untracked = 0
  let conflicts = 0
  let sawBranchHeader = false

  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trimEnd()
    if (!line) continue

    if (line.startsWith("# branch.head ")) {
      head = text(line.slice(14))
      sawBranchHeader = true
      continue
    }
    if (line.startsWith("# branch.oid ")) {
      oid = text(line.slice(13))
      continue
    }
    if (line.startsWith("# branch.upstream ")) {
      upstream = text(line.slice(18))
      continue
    }
    if (line.startsWith("# branch.ab ")) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(line)
      if (match) {
        ahead = Number(match[1])
        behind = Number(match[2])
      }
      continue
    }

    if (line.startsWith("? ")) {
      untracked += 1
      continue
    }
    if (line[0] === "u") {
      conflicts += 1
      continue
    }
    if (line[0] === "1" || line[0] === "2") {
      // Porcelain v2 record: "<kind> <XY> ...". X is the index state,
      // Y the worktree state. "." means unchanged.
      const x = line[2]
      const y = line[3]
      if (x && x !== ".") staged += 1
      if (y && y !== ".") modified += 1
    }
  }

  if (!sawBranchHeader && !oid) return undefined

  const detached = head === "(detached)"
  const branch = detached
    ? `detached @${shortOid(oid)}`
    : head && !head.startsWith("(")
      ? head
      : oid && oid !== "(initial)"
        ? `@${shortOid(oid)}`
        : "unborn"

  return {
    branch,
    detached,
    oid,
    upstream,
    ahead,
    behind,
    staged,
    modified,
    untracked,
    conflicts,
  }
}

function isMissing(error: { code?: string | number | null }): boolean {
  return error.code === "ENOENT" || error.code === "EACCES"
}

function isNotARepository(stderr: string): boolean {
  return /not a git repository|not a git repo/i.test(stderr)
}

/**
 * Run one read-only status command. Never rejects: the widget's only job is
 * to choose a quiet fallback line when git cannot answer.
 */
export function readGitStatus(
  directory: string,
  options: GitReadOptions = {},
): Promise<GitRead> {
  return new Promise((resolve) => {
    if (!directory) {
      resolve({ status: "unavailable" })
      return
    }

    execFile(
      "git",
      STATUS_ARGS,
      {
        cwd: directory,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
        signal: options.signal,
        env: {
          ...process.env,
          // A status read must not take optional index locks, prompt, or
          // translate porcelain records into a locale-specific shape.
          GIT_OPTIONAL_LOCKS: "0",
          GIT_TERMINAL_PROMPT: "0",
          LC_ALL: "C",
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          const stderrText = typeof stderr === "string" ? stderr : ""
          if (error.name === "AbortError" || error.code === "ABORT_ERR") {
            resolve({ status: "aborted" })
          } else if (error.killed || error.signal === "SIGTERM") {
            resolve({ status: "timeout" })
          } else if (isMissing(error)) {
            resolve({ status: "unavailable" })
          } else if (isNotARepository(stderrText)) {
            resolve({ status: "no-repo" })
          } else {
            resolve({ status: "unavailable" })
          }
          return
        }

        const parsed = parseGitStatus(stdout)
        resolve(parsed ? { status: "ok", data: parsed } : { status: "unavailable" })
      },
    )
  })
}
