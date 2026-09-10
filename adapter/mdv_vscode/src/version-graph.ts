import type { VersionSummary } from '@owariband/mdv'

export interface VersionNode {
  readonly version: VersionSummary
  readonly row: number
  readonly lane: number
}

/** Newest leaves first, but always children before parents, even with non-monotonic timestamps. */
export function layoutVersions(versions: readonly VersionSummary[]): VersionNode[] {
  const byId = new Map(versions.map((version) => [version.id, version]))
  const children = new Map(versions.map((version) => [version.id, 0]))
  for (const version of versions) if (version.parent) children.set(version.parent, children.get(version.parent)! + 1)
  const ready = versions.filter((version) => children.get(version.id) === 0)
  const newestFirst = (a: VersionSummary, b: VersionSummary) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id)
  ready.sort(newestFirst)
  const lanes: (string | null)[] = []
  const nodes: VersionNode[] = []
  while (ready.length) {
    const version = ready.shift()!
    let lane = lanes.indexOf(version.id)
    if (lane < 0) {
      lane = lanes.indexOf(null)
      if (lane < 0) lane = lanes.length
    }
    nodes.push({ version, row: nodes.length, lane })
    lanes[lane] = version.parent && !lanes.includes(version.parent) ? version.parent : null
    if (version.parent) {
      const remaining = children.get(version.parent)! - 1
      children.set(version.parent, remaining)
      if (remaining === 0) {
        const parent = byId.get(version.parent)!
        const index = ready.findIndex((entry) => newestFirst(parent, entry) < 0)
        ready.splice(index < 0 ? ready.length : index, 0, parent)
      }
    }
  }
  return nodes
}
