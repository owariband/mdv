import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import test from 'node:test'

import {
  DEFAULT_LINE_DIFF_LIMITS,
  DiffLimitExceededError,
  diffLines,
} from '../dist/core/diff.js'

test('returns an empty frozen result for identical input', () => {
  const result = diffLines('# Same\r\n', '# Same\r\n')

  assert.deepEqual(result, { hunks: [], unifiedText: '' })
  assert.ok(Object.isFrozen(result))
  assert.ok(Object.isFrozen(result.hunks))
})

test('diffs arbitrary Document-like inputs without tree-specific behavior', () => {
  const result = diffLines(
    '# Draft one\nunchanged\n',
    '# Draft two\nunchanged\n',
    { oldLabel: 'document:v_old', newLabel: 'document:v_new' },
  )

  assert.deepEqual(result.hunks, [{
    oldStart: 1,
    oldLines: 2,
    newStart: 1,
    newLines: 2,
    lines: [
      { kind: 'deletion', oldLine: 1, newLine: null, text: '# Draft one\n' },
      { kind: 'addition', oldLine: null, newLine: 1, text: '# Draft two\n' },
      { kind: 'context', oldLine: 2, newLine: 2, text: 'unchanged\n' },
    ],
  }])
  assert.equal(
    result.unifiedText,
    '--- document:v_old\n'
      + '+++ document:v_new\n'
      + '@@ -1,2 +1,2 @@\n'
      + '-# Draft one\n'
      + '+# Draft two\n'
      + ' unchanged\n',
  )
  assert.ok(Object.isFrozen(result.hunks[0]))
  assert.ok(Object.isFrozen(result.hunks[0].lines))
  assert.ok(result.hunks[0].lines.every(Object.isFrozen))
})

test('preserves CRLF, LF, whitespace, Unicode spelling, and EOF newline differences', () => {
  const result = diffLines(
    'title  \r\ncaf\u00e9\r\nlast',
    'title \nca\u0065\u0301\nlast\n',
  )

  assert.deepEqual(
    result.hunks[0].lines.map(({ kind, text }) => ({ kind, text })),
    [
      { kind: 'deletion', text: 'title  \r\n' },
      { kind: 'deletion', text: 'caf\u00e9\r\n' },
      { kind: 'deletion', text: 'last' },
      { kind: 'addition', text: 'title \n' },
      { kind: 'addition', text: 'ca\u0065\u0301\n' },
      { kind: 'addition', text: 'last\n' },
    ],
  )
  assert.match(result.unifiedText, /-title  \r\n/u)
  assert.match(result.unifiedText, /\+title \n/u)
  assert.match(result.unifiedText, /-last\n\\ No newline at end of file\n/u)
  assert.doesNotMatch(result.unifiedText, /\+last\n\\ No newline/u)
})

test('uses context lines to split and merge deterministic hunks', () => {
  const oldText = 'a\nb\nc\nd\ne\nf\ng\nh\n'
  const newText = 'a\nB\nc\nd\ne\nf\nG\nh\n'

  const split = diffLines(oldText, newText, { contextLines: 1 })
  assert.deepEqual(split.hunks.map((hunk) => ({
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
  })), [
    { oldStart: 1, oldLines: 3, newStart: 1, newLines: 3 },
    { oldStart: 6, oldLines: 3, newStart: 6, newLines: 3 },
  ])

  const merged = diffLines(oldText, newText, { contextLines: 2 })
  assert.equal(merged.hunks.length, 1)
  assert.equal(merged.hunks[0].oldStart, 1)
  assert.equal(merged.hunks[0].oldLines, 8)
  assert.deepEqual(merged, diffLines(oldText, newText, { contextLines: 2 }))
})

test('uses standard zero-length coordinates for an empty side', () => {
  const addition = diffLines('', 'first\n', { contextLines: 0 })
  assert.deepEqual(addition.hunks[0], {
    oldStart: 0,
    oldLines: 0,
    newStart: 1,
    newLines: 1,
    lines: [{ kind: 'addition', oldLine: null, newLine: 1, text: 'first\n' }],
  })
  assert.match(addition.unifiedText, /@@ -0,0 \+1 @@/u)

  const deletion = diffLines('first\n', '', { contextLines: 0 })
  assert.equal(deletion.hunks[0].newStart, 0)
  assert.equal(deletion.hunks[0].newLines, 0)
  assert.match(deletion.unifiedText, /@@ -1 \+0,0 @@/u)
})

test('handles an insertion or deletion before the first retained line', () => {
  const insertion = diffLines('kept\n', 'first\nkept\n', { contextLines: 1 })
  assert.deepEqual(insertion.hunks[0].lines, [
    { kind: 'addition', oldLine: null, newLine: 1, text: 'first\n' },
    { kind: 'context', oldLine: 1, newLine: 2, text: 'kept\n' },
  ])

  const deletion = diffLines('first\nkept\n', 'kept\n', { contextLines: 1 })
  assert.deepEqual(deletion.hunks[0].lines, [
    { kind: 'deletion', oldLine: 1, newLine: null, text: 'first\n' },
    { kind: 'context', oldLine: 2, newLine: 1, text: 'kept\n' },
  ])
})

test('enforces aggregate UTF-8 input bytes before diffing', () => {
  const oldText = '\u732b\n'
  const newText = '\u72d7\n'
  const exactBytes = Buffer.byteLength(oldText) + Buffer.byteLength(newText)

  assert.doesNotThrow(() => diffLines(oldText, newText, {
    limits: { maxInputBytes: exactBytes },
  }))
  assertDiffLimit(
    () => diffLines(oldText, newText, { limits: { maxInputBytes: exactBytes - 1 } }),
    'maxInputBytes',
    exactBytes - 1,
    exactBytes,
  )
})

test('enforces aggregate input lines', () => {
  assertDiffLimit(
    () => diffLines('a\nb\n', 'a\nB\n', { limits: { maxInputLines: 3 } }),
    'maxInputLines',
    3,
    4,
  )
})

test('bounds Myers exploration by edit length', () => {
  assert.doesNotThrow(() => diffLines('before\n', 'after\n', {
    limits: { maxEditLength: 2 },
  }))
  assertDiffLimit(
    () => diffLines('before\n', 'after\n', { limits: { maxEditLength: 1 } }),
    'maxEditLength',
    1,
    2,
  )
})

test('enforces hunk count without returning a partial result', () => {
  assertDiffLimit(
    () => diffLines(
      'a\nb\nc\nd\ne\n',
      'a\nB\nc\nD\ne\n',
      { contextLines: 0, limits: { maxHunks: 1 } },
    ),
    'maxHunks',
    1,
    2,
  )
})

test('enforces unified output UTF-8 bytes at the exact boundary', () => {
  const input = ['old\n', 'new \u732b\n']
  const expected = diffLines(...input)
  const outputBytes = Buffer.byteLength(expected.unifiedText)

  assert.equal(
    diffLines(...input, { limits: { maxOutputBytes: outputBytes } }).unifiedText,
    expected.unifiedText,
  )
  assert.throws(
    () => diffLines(...input, { limits: { maxOutputBytes: outputBytes - 1 } }),
    (error) => {
      assert.ok(error instanceof DiffLimitExceededError)
      assert.equal(error.limit, 'maxOutputBytes')
      assert.equal(error.maximum, outputBytes - 1)
      assert.ok(error.observed > error.maximum)
      return true
    },
  )
})

test('validates numeric options and unified labels', () => {
  assert.throws(() => diffLines('a', 'b', { contextLines: -1 }), RangeError)
  assert.throws(
    () => diffLines('a', 'b', { limits: { maxEditLength: 1.5 } }),
    RangeError,
  )
  assert.throws(() => diffLines('a', 'b', { oldLabel: 'old\nforged' }), TypeError)
  assert.throws(() => diffLines('a', 'b', { newLabel: 'new\0forged' }), TypeError)
})

test('publishes the reviewed default resource limits', () => {
  assert.deepEqual(DEFAULT_LINE_DIFF_LIMITS, {
    maxInputBytes: 8 * 1024 * 1024,
    maxInputLines: 200_000,
    maxEditLength: 2_048,
    maxHunks: 10_000,
    maxOutputBytes: 16 * 1024 * 1024,
  })
  assert.ok(Object.isFrozen(DEFAULT_LINE_DIFF_LIMITS))
})

function assertDiffLimit(action, limit, maximum, observed) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof DiffLimitExceededError)
    assert.equal(error.reason, 'diff-limit-exceeded')
    assert.equal(error.limit, limit)
    assert.equal(error.maximum, maximum)
    assert.equal(error.observed, observed)
    return true
  })
}
