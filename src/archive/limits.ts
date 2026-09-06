export interface ReadLimits {
  readonly maxEntries: number
  readonly maxEntryBytes: number
  readonly maxTotalUncompressedBytes: number
  readonly maxCompressionRatio: number
  readonly maxVersions: number
  readonly maxJsonBytes: number
  readonly maxJsonDepth: number
}

export const DEFAULT_READ_LIMITS: ReadLimits = Object.freeze({
  maxEntries: 30_010,
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalUncompressedBytes: 512 * 1024 * 1024,
  maxCompressionRatio: 100,
  maxVersions: 10_000,
  maxJsonBytes: 1024 * 1024,
  maxJsonDepth: 32,
})

export function resolveReadLimits(overrides: Partial<ReadLimits> = {}): ReadLimits {
  const resolved = { ...DEFAULT_READ_LIMITS, ...overrides }
  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError(`${name} must be a finite number greater than zero`)
    }
  }
  return Object.freeze(resolved)
}
