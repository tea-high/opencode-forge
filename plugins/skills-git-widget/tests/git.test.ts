import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { parseGitStatus, readGitStatus, isRemoteHostname } from "../git.ts"

const STATUS = [
  "# branch.oid 1234567890abcdef",
  "# branch.head main",
  "# branch.upstream origin/main",
  "# branch.ab +2 -3",
  "1 .M N... 100644 100644 100644 abc def src/modified.ts",
  "1 A. N... 100644 100644 100644 abc def src/staged.ts",
  "2 R. N... 100644 100644 100644 abc def src/renamed.ts\tsrc/old.ts",
  "u UU N... 100644 100644 100644 100644 aaa bbb ccc src/conflict.ts",
  "? notes.md",
  "garbage that must be ignored",
].join("\n")

describe("parseGitStatus", () => {
  test("parses branch, upstream, ahead/behind and counts", () => {
    expect(parseGitStatus(STATUS)).toEqual({
      branch: "main",
      detached: false,
      oid: "1234567890abcdef",
      upstream: "origin/main",
      ahead: 2,
      behind: 3,
      staged: 2,
      modified: 1,
      untracked: 1,
      conflicts: 1,
    })
  })

  test("uses a short oid for a detached head", () => {
    const parsed = parseGitStatus(
      ["# branch.oid 1234567890abcdef", "# branch.head (detached)"].join("\n"),
    )
    expect(parsed?.branch).toBe("detached @1234567")
    expect(parsed?.detached).toBe(true)
  })

  test("leaves comparison fields absent without an upstream", () => {
    const parsed = parseGitStatus(["# branch.oid 1234567890abcdef", "# branch.head main"].join("\n"))
    expect(parsed?.branch).toBe("main")
    expect(parsed?.upstream).toBeUndefined()
    expect(parsed?.ahead).toBeUndefined()
    expect(parsed?.behind).toBeUndefined()
  })

  test("handles an unborn branch", () => {
    const parsed = parseGitStatus(
      ["# branch.oid (initial)", "# branch.head main"].join("\r\n"),
    )
    expect(parsed?.branch).toBe("main")
    expect(parsed?.oid).toBe("(initial)")
  })

  test("falls back to the oid when the branch name is missing", () => {
    const parsed = parseGitStatus("# branch.oid 1234567890abcdef")
    expect(parsed?.branch).toBe("@1234567")
  })

  test("returns undefined when there is no usable header", () => {
    expect(parseGitStatus("")).toBeUndefined()
    expect(parseGitStatus("? file\n1 .M N... path")).toBeUndefined()
  })
})

function fakeGit(script: string) {
  const root = mkdtempSync(join(tmpdir(), "forge-git-"))
  const bin = join(root, "bin")
  mkdirSync(bin)
  const executable = join(bin, "git")
  writeFileSync(executable, `#!/bin/sh\n${script}\n`)
  chmodSync(executable, 0o755)
  return { root, bin }
}

function withPath<T>(bin: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.PATH
  process.env.PATH = `${bin}:${previous ?? ""}`
  return run().finally(() => {
    process.env.PATH = previous
  })
}

describe("isRemoteHostname", () => {
  test("detects a server running on another host", () => {
    expect(isRemoteHostname("workstation", "laptop")).toBe(true)
    expect(isRemoteHostname("Workstation", "workstation")).toBe(false)
    expect(isRemoteHostname(undefined, "laptop")).toBe(false)
  })
})

describe("readGitStatus", () => {
  test("reports a directory that is not a repository", async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-no-repo-"))
    try {
      expect(await readGitStatus(root)).toEqual({ status: "no-repo" })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("reports a missing working directory as unavailable", async () => {
    const missing = join(tmpdir(), `forge-missing-${Date.now()}-${Math.random()}`)
    expect(await readGitStatus(missing)).toEqual({ status: "unavailable" })
  })

  test("kills and classifies a slow command as a timeout", async () => {
    const fake = fakeGit("exec sleep 1")
    try {
      await withPath(fake.bin, async () => {
        expect(await readGitStatus(fake.root, { timeoutMs: 50 })).toEqual({ status: "timeout" })
      })
    } finally {
      rmSync(fake.root, { recursive: true, force: true })
    }
  })

  test("classifies a read aborted by its caller", async () => {
    const fake = fakeGit("exec sleep 1")
    try {
      await withPath(fake.bin, async () => {
        const controller = new AbortController()
        setTimeout(() => controller.abort(), 50)
        expect(await readGitStatus(fake.root, { signal: controller.signal })).toEqual({
          status: "aborted",
        })
      })
    } finally {
      rmSync(fake.root, { recursive: true, force: true })
    }
  })
})
