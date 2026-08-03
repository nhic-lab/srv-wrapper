import type { ServerRecord } from '../shared/types.js'

/**
 * Given a target server id and its proposed (not-yet-persisted) jumpChain,
 * resolves the fully-expanded ordered hop path — recursively following each
 * hop's own stored jumpChain — and returns it as an array of server ids
 * ordered first-hop-to-connect-to first, target last.
 *
 * Throws if:
 *  - any referenced id doesn't exist in the registry (via `lookup`)
 *  - the target's own id, or any id, appears more than once in the fully
 *    expanded path (including the trivial case of a server referencing
 *    itself, directly or indirectly)
 */
export function resolveJumpPath(
  targetId: string,
  proposedChain: string[],
  lookup: (id: string) => ServerRecord | undefined
): string[] {
  const path: string[] = []
  const seen = new Set<string>([targetId])

  const expandHop = (id: string) => {
    if (seen.has(id)) {
      throw new Error(`jump chain cycle detected: "${id}" would be reached more than once`)
    }
    seen.add(id)
    const record = lookup(id)
    if (!record) {
      throw new Error(`jump chain references unknown server id "${id}"`)
    }
    for (const subHopId of record.jumpChain ?? []) {
      expandHop(subHopId)
    }
    path.push(id)
  }

  for (const hopId of proposedChain) {
    expandHop(hopId)
  }

  path.push(targetId)
  return path
}
