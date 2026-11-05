import { describe, expect, test } from "bun:test"
import {
  activationEntry,
  buildSkillCatalog,
  collectMessagePages,
  mergeSkillEntries,
  scanActivatedSkills,
  scanAssistantSkills,
  toMs,
  type SkillMessage,
} from "../skills.ts"

const catalog = buildSkillCatalog([
  { id: "opencode", name: "OpenCode" },
  { id: "brainstorming", name: "brainstorming" },
])

function assistant(content: unknown[], at = 100): SkillMessage {
  return { type: "assistant", time: { created: at }, content: content as never }
}

describe("toMs", () => {
  test("accepts numbers, dates and parseable strings", () => {
    expect(toMs(123)).toBe(123)
    expect(toMs(new Date(456))).toBe(456)
    expect(toMs("2024-01-01T00:00:00.000Z")).toBe(1704067200000)
    expect(toMs(undefined)).toBeUndefined()
    expect(toMs("not a date")).toBeUndefined()
  })
})

describe("skill scanning", () => {
  test("reads a completed skill tool call and its display name", () => {
    const messages = [
      assistant([
        {
          type: "tool",
          name: "skill",
          id: "call_1",
          state: {
            status: "completed",
            input: { id: "opencode" },
            metadata: { name: "OpenCode" },
          },
          time: { completed: 120 },
        },
      ]),
    ]

    expect(scanAssistantSkills(messages, catalog)).toEqual([
      { key: "opencode", name: "OpenCode", at: 120 },
    ])
  })

  test("ignores unfinished and non-skill tool calls", () => {
    const messages = [
      assistant([
        {
          type: "tool",
          name: "skill",
          id: "call_1",
          state: { status: "running", input: { id: "opencode" } },
        },
        {
          type: "tool",
          name: "read",
          id: "call_2",
          state: { status: "completed", input: { id: "opencode" } },
        },
      ]),
    ]

    expect(scanAssistantSkills(messages, catalog)).toEqual([])
  })

  test("falls back to the catalog for a missing metadata name", () => {
    const messages = [
      assistant([
        {
          type: "tool",
          name: "skill",
          id: "call_1",
          state: { status: "completed", input: { id: "brainstorming" } },
        },
      ]),
    ]

    expect(scanAssistantSkills(messages, catalog)[0]?.name).toBe("brainstorming")
  })

  test("reads explicit skill messages", () => {
    const messages: SkillMessage[] = [
      { type: "skill", skill: "opencode", name: "OpenCode", time: { created: 50 } },
    ]
    expect(scanActivatedSkills(messages, catalog)).toEqual([
      { key: "opencode", name: "OpenCode", at: 50 },
    ])
  })

  test("turns a live activation into a row", () => {
    expect(activationEntry({ id: "opencode", name: "OpenCode" }, catalog, 10)).toEqual({
      key: "opencode",
      name: "OpenCode",
      at: 10,
    })
    expect(activationEntry(undefined, catalog)).toBeUndefined()
  })
})

describe("mergeSkillEntries", () => {
  test("dedupes by id, keeps first-seen order and does not mutate input", () => {
    const first = [{ key: "opencode", name: "OpenCode", at: 20 }]
    const second = [
      { key: "brainstorming", name: "brainstorming", at: 10 },
      { key: "opencode", name: "OpenCode", at: 30 },
    ]

    expect(mergeSkillEntries(first, second)).toEqual([
      { key: "brainstorming", name: "brainstorming", at: 10 },
      { key: "opencode", name: "OpenCode", at: 20 },
    ])
    expect(first).toEqual([{ key: "opencode", name: "OpenCode", at: 20 }])
  })

  test("upgrades an id used as a fallback name", () => {
    const first = [{ key: "opencode", name: "opencode", at: 10 }]
    const second = [{ key: "opencode", name: "OpenCode", at: 20 }]

    expect(mergeSkillEntries(first, second)[0]?.name).toBe("OpenCode")
  })

  test("keeps a real display name when a fallback arrives later", () => {
    const first = [{ key: "opencode", name: "OpenCode", at: 10 }]
    const second = [{ key: "opencode", name: "opencode", at: 20 }]

    expect(mergeSkillEntries(first, second)[0]?.name).toBe("OpenCode")
  })
})

describe("collectMessagePages", () => {
  test("walks every cursor page and concatenates it in order", async () => {
    const seen: Array<string | undefined> = []
    const all = await collectMessagePages(async (cursor) => {
      seen.push(cursor)
      if (!cursor) return { data: [1, 2], cursor: { next: "page-2" } }
      if (cursor === "page-2") return { data: [3], cursor: { next: null } }
      throw new Error(`unexpected cursor ${cursor}`)
    })

    expect(all).toEqual([1, 2, 3])
    expect(seen).toEqual([undefined, "page-2"])
  })

  test("stops instead of looping when the server repeats a cursor", async () => {
    let calls = 0
    const all = await collectMessagePages(async () => {
      calls += 1
      return { data: [calls], cursor: { next: "same-cursor" } }
    })

    expect(all).toEqual([1, 2])
    expect(calls).toBe(2)
  })

  test("does not fetch when already aborted", async () => {
    let calls = 0
    const controller = new AbortController()
    controller.abort()

    let failed = false
    try {
      await collectMessagePages(async () => {
        calls += 1
        return { data: [], cursor: { next: null } }
      }, controller.signal)
    } catch {
      failed = true
    }

    expect(failed).toBe(true)
    expect(calls).toBe(0)
  })
})
