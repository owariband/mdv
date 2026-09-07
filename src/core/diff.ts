import { Buffer } from 'node:buffer'

export interface LineDiffLimits {
  readonly maxInputBytes: number
  readonly maxInputLines: number
  readonly maxEditLength: number
  readonly maxHunks: number
  readonly maxOutputBytes: number
}

export interface LineDiffOptions {
  readonly contextLines?: number
  readonly limits?: Partial<LineDiffLimits>
  readonly oldLabel?: string
  readonly newLabel?: string
}

export type LineDiffLine =
  | {
      readonly kind: 'context'
      readonly oldLine: number
      readonly newLine: number
      readonly text: string
    }
  | {
      readonly kind: 'deletion'
      readonly oldLine: number
      readonly newLine: null
      readonly text: string
    }
  | {
      readonly kind: 'addition'
      readonly oldLine: null
      readonly newLine: number
      readonly text: string
    }

export interface LineDiffHunk {
  readonly oldStart: number
  readonly oldLines: number
  readonly newStart: number
  readonly newLines: number
  readonly lines: readonly LineDiffLine[]
}

export interface LineDiffResult {
  readonly hunks: readonly LineDiffHunk[]
  readonly unifiedText: string
}

export const DEFAULT_LINE_DIFF_LIMITS: Readonly<LineDiffLimits> = Object.freeze({
  maxInputBytes: 8 * 1024 * 1024,
  maxInputLines: 200_000,
  maxEditLength: 2_048,
  maxHunks: 10_000,
  maxOutputBytes: 16 * 1024 * 1024,
})

export class DiffLimitExceededError extends Error {
  readonly reason = 'diff-limit-exceeded' as const
  readonly limit: keyof LineDiffLimits
  readonly maximum: number
  readonly observed: number

  constructor(limit: keyof LineDiffLimits, maximum: number, observed: number) {
    super(`Diff ${limit} limit exceeded: maximum ${maximum}, observed ${observed}`)
    this.name = 'DiffLimitExceededError'
    this.limit = limit
    this.maximum = maximum
    this.observed = observed
  }
}

interface EqualOperation {
  readonly kind: 'context'
  readonly text: string
}

interface DeleteOperation {
  readonly kind: 'deletion'
  readonly text: string
}

interface InsertOperation {
  readonly kind: 'addition'
  readonly text: string
}

type DiffOperation = EqualOperation | DeleteOperation | InsertOperation

interface HunkRange {
  readonly start: number
  readonly end: number
}

const EMPTY_RESULT: LineDiffResult = Object.freeze({
  hunks: Object.freeze([]),
  unifiedText: '',
})

export function diffLines(
  oldText: string,
  newText: string,
  options: LineDiffOptions = {},
): LineDiffResult {
  if (typeof oldText !== 'string' || typeof newText !== 'string') {
    throw new TypeError('diffLines expects oldText and newText to be strings')
  }

  const contextLines = nonNegativeSafeInteger(options.contextLines ?? 3, 'contextLines')
  const limits = normalizeLimits(options.limits)
  const inputBytes = Buffer.byteLength(oldText, 'utf8') + Buffer.byteLength(newText, 'utf8')
  enforceLimit('maxInputBytes', limits.maxInputBytes, inputBytes)

  const oldLines = tokenizeLines(oldText)
  const newLines = tokenizeLines(newText)
  enforceLimit('maxInputLines', limits.maxInputLines, oldLines.length + newLines.length)

  if (oldText === newText) {
    return EMPTY_RESULT
  }

  const operations = calculateOperations(oldLines, newLines, limits.maxEditLength)
  const numbered = numberOperations(operations)
  const ranges = selectHunkRanges(numbered.lines, contextLines, limits.maxHunks)
  const hunks = ranges.map((range) => createHunk(range, numbered))
  const unifiedText = renderUnifiedText(
    hunks,
    validateLabel(options.oldLabel ?? 'old', 'oldLabel'),
    validateLabel(options.newLabel ?? 'new', 'newLabel'),
    limits.maxOutputBytes,
  )

  return Object.freeze({
    hunks: Object.freeze(hunks),
    unifiedText,
  })
}

function normalizeLimits(overrides: Partial<LineDiffLimits> | undefined): LineDiffLimits {
  return {
    maxInputBytes: nonNegativeSafeInteger(
      overrides?.maxInputBytes ?? DEFAULT_LINE_DIFF_LIMITS.maxInputBytes,
      'limits.maxInputBytes',
    ),
    maxInputLines: nonNegativeSafeInteger(
      overrides?.maxInputLines ?? DEFAULT_LINE_DIFF_LIMITS.maxInputLines,
      'limits.maxInputLines',
    ),
    maxEditLength: nonNegativeSafeInteger(
      overrides?.maxEditLength ?? DEFAULT_LINE_DIFF_LIMITS.maxEditLength,
      'limits.maxEditLength',
    ),
    maxHunks: nonNegativeSafeInteger(
      overrides?.maxHunks ?? DEFAULT_LINE_DIFF_LIMITS.maxHunks,
      'limits.maxHunks',
    ),
    maxOutputBytes: nonNegativeSafeInteger(
      overrides?.maxOutputBytes ?? DEFAULT_LINE_DIFF_LIMITS.maxOutputBytes,
      'limits.maxOutputBytes',
    ),
  }
}

function nonNegativeSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`)
  }
  return value
}

function validateLabel(value: string, name: string): string {
  if (typeof value !== 'string') {
    throw new TypeError(`${name} must be a string`)
  }
  if (/[\r\n\0]/u.test(value)) {
    throw new TypeError(`${name} cannot contain CR, LF, or NUL`)
  }
  return value
}

function enforceLimit(
  limit: keyof LineDiffLimits,
  maximum: number,
  observed: number,
): void {
  if (observed > maximum) {
    throw new DiffLimitExceededError(limit, maximum, observed)
  }
}

function tokenizeLines(text: string): readonly string[] {
  if (text.length === 0) {
    return []
  }

  const lines: string[] = []
  let start = 0
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code === 0x0a) {
      lines.push(text.slice(start, index + 1))
      start = index + 1
      continue
    }
    if (code === 0x0d) {
      if (text.charCodeAt(index + 1) === 0x0a) {
        index += 1
      }
      lines.push(text.slice(start, index + 1))
      start = index + 1
    }
  }
  if (start < text.length) {
    lines.push(text.slice(start))
  }
  return lines
}

function calculateOperations(
  oldLines: readonly string[],
  newLines: readonly string[],
  maxEditLength: number,
): readonly DiffOperation[] {
  let prefixLength = 0
  const sharedLength = Math.min(oldLines.length, newLines.length)
  while (
    prefixLength < sharedLength
    && oldLines[prefixLength] === newLines[prefixLength]
  ) {
    prefixLength += 1
  }

  let oldEnd = oldLines.length
  let newEnd = newLines.length
  while (
    oldEnd > prefixLength
    && newEnd > prefixLength
    && oldLines[oldEnd - 1] === newLines[newEnd - 1]
  ) {
    oldEnd -= 1
    newEnd -= 1
  }

  const oldMiddle = oldLines.slice(prefixLength, oldEnd)
  const newMiddle = newLines.slice(prefixLength, newEnd)
  const operations: DiffOperation[] = []

  for (let index = 0; index < prefixLength; index += 1) {
    operations.push({ kind: 'context', text: oldLines[index] as string })
  }
  operations.push(...myersOperations(oldMiddle, newMiddle, maxEditLength))
  for (let index = oldEnd; index < oldLines.length; index += 1) {
    operations.push({ kind: 'context', text: oldLines[index] as string })
  }

  return operations
}

function myersOperations(
  oldLines: readonly string[],
  newLines: readonly string[],
  maxEditLength: number,
): readonly DiffOperation[] {
  if (oldLines.length === 0) {
    enforceLimit('maxEditLength', maxEditLength, newLines.length)
    return newLines.map((text) => ({ kind: 'addition', text }))
  }
  if (newLines.length === 0) {
    enforceLimit('maxEditLength', maxEditLength, oldLines.length)
    return oldLines.map((text) => ({ kind: 'deletion', text }))
  }

  const lengthDifference = Math.abs(oldLines.length - newLines.length)
  enforceLimit('maxEditLength', maxEditLength, lengthDifference)

  const searchLimit = Math.min(maxEditLength, oldLines.length + newLines.length)
  const offset = searchLimit + 1
  const diagonal = new Int32Array((searchLimit * 2) + 3)
  diagonal.fill(-1)
  diagonal[offset + 1] = 0
  const trace: Int32Array[] = []

  for (let editLength = 0; editLength <= searchLimit; editLength += 1) {
    trace.push(diagonal.slice())
    for (let k = -editLength; k <= editLength; k += 2) {
      const index = offset + k
      let oldIndex: number
      if (
        k === -editLength
        || (
          k !== editLength
          && (diagonal[index - 1] as number) < (diagonal[index + 1] as number)
        )
      ) {
        oldIndex = diagonal[index + 1] as number
      } else {
        oldIndex = (diagonal[index - 1] as number) + 1
      }
      let newIndex = oldIndex - k

      while (
        oldIndex < oldLines.length
        && newIndex < newLines.length
        && oldLines[oldIndex] === newLines[newIndex]
      ) {
        oldIndex += 1
        newIndex += 1
      }
      diagonal[index] = oldIndex

      if (oldIndex >= oldLines.length && newIndex >= newLines.length) {
        return backtrackOperations(oldLines, newLines, trace, editLength, offset)
      }
    }
  }

  throw new DiffLimitExceededError(
    'maxEditLength',
    maxEditLength,
    maxEditLength + 1,
  )
}

function backtrackOperations(
  oldLines: readonly string[],
  newLines: readonly string[],
  trace: readonly Int32Array[],
  distance: number,
  offset: number,
): readonly DiffOperation[] {
  let oldIndex = oldLines.length
  let newIndex = newLines.length
  const reversed: DiffOperation[] = []

  for (let editLength = distance; editLength > 0; editLength -= 1) {
    const diagonal = trace[editLength] as Int32Array
    const k = oldIndex - newIndex
    const previousK = (
      k === -editLength
      || (
        k !== editLength
        && (diagonal[offset + k - 1] as number) < (diagonal[offset + k + 1] as number)
      )
    )
      ? k + 1
      : k - 1
    const previousOld = diagonal[offset + previousK] as number
    const previousNew = previousOld - previousK

    while (oldIndex > previousOld && newIndex > previousNew) {
      oldIndex -= 1
      newIndex -= 1
      reversed.push({ kind: 'context', text: oldLines[oldIndex] as string })
    }

    if (oldIndex === previousOld) {
      newIndex -= 1
      reversed.push({ kind: 'addition', text: newLines[newIndex] as string })
    } else {
      oldIndex -= 1
      reversed.push({ kind: 'deletion', text: oldLines[oldIndex] as string })
    }

    oldIndex = previousOld
    newIndex = previousNew
  }

  while (oldIndex > 0 && newIndex > 0) {
    oldIndex -= 1
    newIndex -= 1
    if (oldLines[oldIndex] !== newLines[newIndex]) {
      throw new Error('Invalid Myers backtrack state')
    }
    reversed.push({ kind: 'context', text: oldLines[oldIndex] as string })
  }
  if (oldIndex !== 0 || newIndex !== 0) {
    throw new Error('Invalid Myers backtrack origin')
  }

  return reversed.reverse()
}

function numberOperations(operations: readonly DiffOperation[]): {
  readonly lines: readonly LineDiffLine[]
  readonly oldBefore: readonly number[]
  readonly newBefore: readonly number[]
} {
  const lines: LineDiffLine[] = []
  const oldBefore: number[] = []
  const newBefore: number[] = []
  let oldLine = 1
  let newLine = 1

  for (const operation of operations) {
    oldBefore.push(oldLine)
    newBefore.push(newLine)
    if (operation.kind === 'context') {
      lines.push(Object.freeze({
        kind: 'context',
        oldLine,
        newLine,
        text: operation.text,
      }))
      oldLine += 1
      newLine += 1
    } else if (operation.kind === 'deletion') {
      lines.push(Object.freeze({
        kind: 'deletion',
        oldLine,
        newLine: null,
        text: operation.text,
      }))
      oldLine += 1
    } else {
      lines.push(Object.freeze({
        kind: 'addition',
        oldLine: null,
        newLine,
        text: operation.text,
      }))
      newLine += 1
    }
  }

  return { lines, oldBefore, newBefore }
}

function selectHunkRanges(
  lines: readonly LineDiffLine[],
  contextLines: number,
  maxHunks: number,
): readonly HunkRange[] {
  const ranges: HunkRange[] = []

  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]?.kind === 'context') {
      continue
    }

    const start = Math.max(0, index - contextLines)
    const end = Math.min(lines.length, index + contextLines + 1)
    const previous = ranges[ranges.length - 1]
    if (previous !== undefined && start <= previous.end) {
      ranges[ranges.length - 1] = { start: previous.start, end: Math.max(previous.end, end) }
      continue
    }

    ranges.push({ start, end })
    enforceLimit('maxHunks', maxHunks, ranges.length)
  }

  return ranges
}

function createHunk(
  range: HunkRange,
  numbered: {
    readonly lines: readonly LineDiffLine[]
    readonly oldBefore: readonly number[]
    readonly newBefore: readonly number[]
  },
): LineDiffHunk {
  const lines = numbered.lines.slice(range.start, range.end)
  const oldLines = lines.reduce(
    (count, line) => count + (line.kind === 'addition' ? 0 : 1),
    0,
  )
  const newLines = lines.reduce(
    (count, line) => count + (line.kind === 'deletion' ? 0 : 1),
    0,
  )
  const oldPosition = numbered.oldBefore[range.start] as number
  const newPosition = numbered.newBefore[range.start] as number

  return Object.freeze({
    oldStart: oldLines === 0 ? Math.max(0, oldPosition - 1) : oldPosition,
    oldLines,
    newStart: newLines === 0 ? Math.max(0, newPosition - 1) : newPosition,
    newLines,
    lines: Object.freeze(lines),
  })
}

function renderUnifiedText(
  hunks: readonly LineDiffHunk[],
  oldLabel: string,
  newLabel: string,
  maxOutputBytes: number,
): string {
  const chunks: string[] = []
  let outputBytes = 0
  const append = (chunk: string): void => {
    outputBytes += Buffer.byteLength(chunk, 'utf8')
    enforceLimit('maxOutputBytes', maxOutputBytes, outputBytes)
    chunks.push(chunk)
  }

  append(`--- ${oldLabel}\n`)
  append(`+++ ${newLabel}\n`)
  for (const hunk of hunks) {
    append(
      `@@ -${formatRange(hunk.oldStart, hunk.oldLines)}`
      + ` +${formatRange(hunk.newStart, hunk.newLines)} @@\n`,
    )
    for (const line of hunk.lines) {
      const prefix = line.kind === 'context' ? ' ' : line.kind === 'deletion' ? '-' : '+'
      append(prefix + line.text)
      if (!hasLineEnding(line.text)) {
        append('\n\\ No newline at end of file\n')
      }
    }
  }
  return chunks.join('')
}

function formatRange(start: number, lineCount: number): string {
  return lineCount === 1 ? `${start}` : `${start},${lineCount}`
}

function hasLineEnding(line: string): boolean {
  return line.endsWith('\n') || line.endsWith('\r')
}
