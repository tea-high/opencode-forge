import { describe, expect, test } from "bun:test"
import { readSessionSkills, rememberSessionSkills, type SkillMemory } from "../cache.ts"

describe("session skill cache", () => {
  test("returns a copy of a session's entries and nothing for an unknown session", () => {
    const memory: SkillMemory = {
      sessions: {
        one: [{ key: "opencode", name: "OpenCode", at: 10 }],
      },
    }

    const found = readSessionSkills(memory, "one")
    expect(found).toEqual([{ key: "opencode", name: "OpenCode", at: 10 }])
    found[0]!.name = "changed"
    expect(memory.sessions.one[0]!.name).toBe("OpenCode")
    expect(readSessionSkills(memory, "two")).toEqual([])
  })

  test("writes a copy and keeps the most recent sessions up to the limit", () => {
    const memory: SkillMemory = { sessions: {} }
    const entries = [{ key: "opencode", name: "OpenCode", at: 10 }]

    rememberSessionSkills(memory, "one", entries, 2)
    rememberSessionSkills(memory, "two", entries, 2)
    rememberSessionSkills(memory, "three", entries, 2)

    expect(Object.keys(memory.sessions)).toEqual(["two", "three"])

    entries[0]!.name = "changed"
    expect(memory.sessions.three[0]!.name).toBe("OpenCode")
  })
})
