import type { SkillEntry } from "./skills.ts"

export type SkillMemory = {
  sessions: Record<string, SkillEntry[]>
}

export const MAX_CACHED_SESSIONS = 32

/** Read a cached session without exposing the stored objects to mutation. */
export function readSessionSkills(memory: SkillMemory, sessionID: string): SkillEntry[] {
  const entries = memory.sessions?.[sessionID]
  return Array.isArray(entries) ? entries.map((entry) => ({ ...entry })) : []
}

/**
 * Store one session and move it to the newest position. Only the most recent
 * sessions are kept; this is an ephemeral hot-reload cache, not a database.
 */
export function rememberSessionSkills(
  memory: SkillMemory,
  sessionID: string,
  entries: readonly SkillEntry[],
  limit: number = MAX_CACHED_SESSIONS,
): void {
  delete memory.sessions[sessionID]
  memory.sessions[sessionID] = entries.map((entry) => ({ ...entry }))

  const keys = Object.keys(memory.sessions)
  const excess = Math.max(0, keys.length - Math.max(1, limit))
  for (const key of keys.slice(0, excess)) delete memory.sessions[key]
}
