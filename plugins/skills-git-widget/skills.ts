/** A skill with the timestamp of its first use in this session. */
export type SkillEntry = {
  key: string
  name: string
  at: number
}

/**
 * Minimal structural views of the V2 message payloads. Keeping this module
 * free of SDK imports makes the scanning rules testable on their own.
 */
export type SkillMessagePart = {
  type?: string
  name?: string
  id?: string
  state?: {
    status?: string
    input?: unknown
    metadata?: unknown
  }
  time?: {
    created?: unknown
    ran?: unknown
    completed?: unknown
  }
}

export type SkillMessage = {
  type?: string
  time?: {
    created?: unknown
  }
  content?: readonly SkillMessagePart[]
  skill?: unknown
  name?: unknown
}

export type MessagePage<Value> = {
  readonly data: readonly Value[]
  readonly cursor?: { readonly next?: string | null } | null
}

/**
 * Walk an opaque server cursor until it ends. A cursor that points at itself
 * or one already seen stops the walk, so a broken server cannot hang the TUI.
 */
export async function collectMessagePages<Value>(
  fetchPage: (cursor?: string) => Promise<MessagePage<Value>>,
  signal?: AbortSignal,
): Promise<Value[]> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError")

  const values: Value[] = []
  const seen = new Set<string>()
  let cursor: string | undefined

  while (true) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError")

    const page = await fetchPage(cursor)
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError")
    values.push(...page.data)

    const next = page.cursor?.next ?? undefined
    if (!next) break
    if (next === cursor || seen.has(next)) break
    seen.add(next)
    cursor = next
  }

  return values
}

export function toMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.getTime()
  if (typeof value === "string" && value) {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return parsed
  }
  return undefined
}

export function skillKey(value: string): string {
  return value.trim().toLowerCase()
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined
}

/** Map skill ids to their display names. The catalog is optional. */
export function buildSkillCatalog(
  skills: readonly unknown[] | undefined,
): Map<string, string> {
  const catalog = new Map<string, string>()
  for (const item of skills ?? []) {
    const record = objectValue(item)
    if (!record) continue
    const id = stringValue(record.id)
    const name = stringValue(record.name)
    if (id && name) catalog.set(skillKey(id), name)
  }
  return catalog
}

function entry(
  id: string | undefined,
  name: string | undefined,
  at: number,
  catalog: ReadonlyMap<string, string>,
): SkillEntry | undefined {
  const identifier = id ?? name
  if (!identifier) return undefined

  const label = name ?? (id ? catalog.get(skillKey(id)) : undefined) ?? id
  if (!label) return undefined

  return {
    key: skillKey(identifier),
    name: label,
    at: Number.isFinite(at) ? at : Date.now(),
  }
}

/** Read one completed `skill` tool call from an assistant message part. */
export function toolPartEntry(
  part: SkillMessagePart | undefined,
  catalog: ReadonlyMap<string, string>,
  fallbackAt: number,
): SkillEntry | undefined {
  if (!part || part.type !== "tool" || part.name !== "skill") return undefined
  if (part.state?.status !== "completed") return undefined

  const input = objectValue(part.state.input)
  const metadata = objectValue(part.state.metadata)
  const id = stringValue(input?.id)
  const name = stringValue(metadata?.name)
  const at =
    toMs(part.time?.completed) ??
    toMs(part.time?.ran) ??
    toMs(part.time?.created) ??
    fallbackAt

  return entry(id, name, at, catalog)
}

/** Scan completed skill tool calls from assistant messages. */
export function scanAssistantSkills(
  messages: readonly SkillMessage[] | undefined,
  catalog: ReadonlyMap<string, string>,
  fallbackAt: number = Date.now(),
): SkillEntry[] {
  const entries: SkillEntry[] = []
  for (const message of messages ?? []) {
    if (!message || message.type !== "assistant" || !Array.isArray(message.content)) continue
    const messageAt = toMs(message.time?.created) ?? fallbackAt
    for (const part of message.content) {
      const next = toolPartEntry(part, catalog, messageAt)
      if (next) entries.push(next)
    }
  }
  return entries
}

/** Scan explicit skill messages (attached/activated skills) from the session. */
export function scanActivatedSkills(
  messages: readonly SkillMessage[] | undefined,
  catalog: ReadonlyMap<string, string>,
  fallbackAt: number = Date.now(),
): SkillEntry[] {
  const entries: SkillEntry[] = []
  for (const message of messages ?? []) {
    if (!message || message.type !== "skill") continue
    const id = stringValue(message.skill)
    const name = stringValue(message.name)
    const at = toMs(message.time?.created) ?? fallbackAt
    const next = entry(id, name, at, catalog)
    if (next) entries.push(next)
  }
  return entries
}

/** Turn a live `session.skill.activated` payload into a row. */
export function activationEntry(
  data: { id?: unknown; name?: unknown } | undefined,
  catalog: ReadonlyMap<string, string>,
  at: number = Date.now(),
): SkillEntry | undefined {
  if (!data) return undefined
  return entry(stringValue(data.id), stringValue(data.name), at, catalog)
}

/**
 * Merge rows by skill id, keep the earliest timestamp as first-seen, and
 * preserve first-seen order. A later row can improve a fallback label
 * (an id used as its own name) but cannot replace a real display name.
 */
export function mergeSkillEntries(
  ...groups: ReadonlyArray<readonly SkillEntry[]>
): SkillEntry[] {
  const sorted = groups
    .flat()
    .filter(
      (item) =>
        item &&
        typeof item.key === "string" &&
        item.key.length > 0 &&
        typeof item.name === "string" &&
        item.name.length > 0 &&
        Number.isFinite(item.at),
    )
    .sort((a, b) => a.at - b.at)

  const chosen = new Map<string, SkillEntry>()
  const order: string[] = []

  for (const item of sorted) {
    const existing = chosen.get(item.key)
    if (!existing) {
      chosen.set(item.key, { ...item })
      order.push(item.key)
      continue
    }

    // A fallback label is exactly the id we keyed on. Comparing lowercased
    // strings is not enough: "OpenCode" normalizes to the id "opencode" but
    // is a real display name, not a fallback.
    const existingIsFallback = existing.name === existing.key
    const incomingIsFallback = item.name === item.key
    if (existingIsFallback && !incomingIsFallback) existing.name = item.name
    if (item.at < existing.at) existing.at = item.at
  }

  return order.map((key) => {
    const found = chosen.get(key)
    return found ? { ...found } : { key, name: key, at: 0 }
  })
}
