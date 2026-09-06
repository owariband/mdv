import type {
  ActorFileDto,
  DocumentVersionMetaFileDto,
  JsonObject,
  JsonValue,
  ManifestFileDto,
  VersionMetaFileDto,
} from './format-dto.js'
import { parseRfc3339 } from './rfc3339.js'

export type FormatFileKind = 'manifest' | 'reference-version' | 'document-version'

export interface FormatIssue {
  readonly path: string
  readonly message: string
}

export interface FormatWarning extends FormatIssue {
  readonly code: 'UNKNOWN_FIELD' | 'UNKNOWN_MARKDOWN_PROFILE'
}

export interface DecodedFormat<T> {
  readonly value: T
  readonly warnings: readonly FormatWarning[]
}

export class FormatDecodeError extends Error {
  readonly kind: FormatFileKind
  readonly issues: readonly FormatIssue[]

  constructor(kind: FormatFileKind, issues: readonly FormatIssue[]) {
    super(`Invalid MDV ${kind}: ${issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')}`)
    this.name = 'FormatDecodeError'
    this.kind = kind
    this.issues = Object.freeze([...issues])
  }
}

const DOCUMENT_ID = /^d_[0-9a-f]{32}$/
const VERSION_ID = /^v_[0-9a-f]{32}$/
const SHA256 = /^[0-9a-f]{64}$/
const MARKDOWN_PROFILE = /^[a-z0-9][a-z0-9._-]{0,63}$/
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

const MANIFEST_FIELDS = new Set([
  'format',
  'formatVersion',
  'documentId',
  'generation',
  'markdownProfile',
])
const VERSION_FIELDS = new Set([
  'schemaVersion',
  'id',
  'parent',
  'createdAt',
  'actor',
  'summary',
  'contentSha256',
  'contentBytes',
])
const DOCUMENT_VERSION_FIELDS = new Set([...VERSION_FIELDS, 'referenceVersion'])
const ACTOR_FIELDS = new Set(['type', 'id', 'name'])

export function decodeManifestValue(input: unknown): DecodedFormat<ManifestFileDto> {
  const issues: FormatIssue[] = []
  const warnings: FormatWarning[] = []
  const record = readObject(input, '$', issues)

  collectUnknownFields(record, MANIFEST_FIELDS, '$', warnings)
  const format = readString(record, 'format', '$', issues)
  const formatVersion = readString(record, 'formatVersion', '$', issues)
  const documentId = readPatternString(record, 'documentId', '$', DOCUMENT_ID, issues)
  const generation = readSafeInteger(record, 'generation', '$', 0, issues)
  const markdownProfile = readPatternString(record, 'markdownProfile', '$', MARKDOWN_PROFILE, issues)

  if (format !== 'mdv') {
    issues.push({ path: '$/format', message: 'must equal "mdv"' })
  }
  if (formatVersion !== '0.1') {
    issues.push({ path: '$/formatVersion', message: 'must equal "0.1"' })
  }
  if (markdownProfile !== '' && markdownProfile !== 'gfm') {
    warnings.push({
      code: 'UNKNOWN_MARKDOWN_PROFILE',
      path: '$/markdownProfile',
      message: `profile "${markdownProfile}" is not registered by MDV 0.1`,
    })
  }

  throwIfInvalid('manifest', issues)
  return Object.freeze({
    value: freezeJsonObject<ManifestFileDto>(record, {
      format: 'mdv',
      formatVersion: '0.1',
      documentId,
      generation,
      markdownProfile,
    }),
    warnings: Object.freeze(warnings),
  })
}

export function decodeReferenceVersionValue(input: unknown): DecodedFormat<VersionMetaFileDto> {
  return decodeVersionValue(input, 'reference-version', VERSION_FIELDS, false)
}

export function decodeDocumentVersionValue(
  input: unknown,
): DecodedFormat<DocumentVersionMetaFileDto> {
  return decodeVersionValue(input, 'document-version', DOCUMENT_VERSION_FIELDS, true)
}

function decodeVersionValue(
  input: unknown,
  kind: 'reference-version',
  knownFields: ReadonlySet<string>,
  document: false,
): DecodedFormat<VersionMetaFileDto>
function decodeVersionValue(
  input: unknown,
  kind: 'document-version',
  knownFields: ReadonlySet<string>,
  document: true,
): DecodedFormat<DocumentVersionMetaFileDto>
function decodeVersionValue(
  input: unknown,
  kind: 'reference-version' | 'document-version',
  knownFields: ReadonlySet<string>,
  document: boolean,
): DecodedFormat<VersionMetaFileDto | DocumentVersionMetaFileDto> {
  const issues: FormatIssue[] = []
  const warnings: FormatWarning[] = []
  const record = readObject(input, '$', issues)

  collectUnknownFields(record, knownFields, '$', warnings)
  const schemaVersion = readSafeInteger(record, 'schemaVersion', '$', 1, issues)
  const id = readPatternString(record, 'id', '$', VERSION_ID, issues)
  const parent = readNullablePatternString(record, 'parent', '$', VERSION_ID, issues)
  const createdAt = readPatternString(record, 'createdAt', '$', RFC3339, issues)
  const actor = decodeActor(record.actor, issues, warnings)
  const summary = readBoundedString(record, 'summary', '$', 1, 4096, issues, true)
  const contentSha256 = readPatternString(record, 'contentSha256', '$', SHA256, issues)
  const contentBytes = readSafeInteger(record, 'contentBytes', '$', 0, issues)

  if (schemaVersion !== 1) {
    issues.push({ path: '$/schemaVersion', message: 'must equal 1' })
  }
  if (createdAt !== '' && parseRfc3339(createdAt) === null) {
    issues.push({ path: '$/createdAt', message: 'must be a real RFC 3339 timestamp' })
  }

  let referenceVersion: string | null = null
  if (document) {
    referenceVersion = readNullablePatternString(
      record,
      'referenceVersion',
      '$',
      VERSION_ID,
      issues,
    )
  }

  throwIfInvalid(kind, issues)
  const base = {
    schemaVersion: 1 as const,
    id,
    parent,
    createdAt,
    actor,
    summary,
    contentSha256,
    contentBytes,
  }

  if (document) {
    return Object.freeze({
      value: freezeJsonObject<DocumentVersionMetaFileDto>(record, {
        ...base,
        referenceVersion,
      }),
      warnings: Object.freeze(warnings),
    })
  }

  return Object.freeze({
    value: freezeJsonObject<VersionMetaFileDto>(record, base),
    warnings: Object.freeze(warnings),
  })
}

function decodeActor(
  input: JsonValue | undefined,
  issues: FormatIssue[],
  warnings: FormatWarning[],
): ActorFileDto {
  const record = readObject(input, '$/actor', issues)
  collectUnknownFields(record, ACTOR_FIELDS, '$/actor', warnings)
  const type = readString(record, 'type', '$/actor', issues)

  if (type !== 'human' && type !== 'agent') {
    issues.push({ path: '$/actor/type', message: 'must equal "human" or "agent"' })
  }

  const id = readOptionalBoundedString(record, 'id', '$/actor', 1, 256, issues)
  const name = readOptionalBoundedString(record, 'name', '$/actor', 1, 256, issues)
  return freezeJsonObject<ActorFileDto>(record, {
    type: type === 'agent' ? 'agent' : 'human',
    ...(id === undefined ? {} : { id }),
    ...(name === undefined ? {} : { name }),
  })
}

function readObject(input: unknown, path: string, issues: FormatIssue[]): JsonObject {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    issues.push({ path, message: 'must be a JSON object' })
    return Object.create(null) as JsonObject
  }
  return input as JsonObject
}

function readString(
  record: JsonObject,
  key: string,
  path: string,
  issues: FormatIssue[],
): string {
  const value = record[key]
  if (typeof value !== 'string') {
    issues.push({ path: `${path}/${key}`, message: 'must be a string' })
    return ''
  }
  return value
}

function readPatternString(
  record: JsonObject,
  key: string,
  path: string,
  pattern: RegExp,
  issues: FormatIssue[],
): string {
  const value = readString(record, key, path, issues)
  if (value !== '' && !pattern.test(value)) {
    issues.push({ path: `${path}/${key}`, message: `must match ${pattern.source}` })
  }
  return value
}

function readNullablePatternString(
  record: JsonObject,
  key: string,
  path: string,
  pattern: RegExp,
  issues: FormatIssue[],
): string | null {
  const value = record[key]
  if (value === null) {
    return null
  }
  if (typeof value !== 'string') {
    issues.push({ path: `${path}/${key}`, message: 'must be a string or null' })
    return null
  }
  if (!pattern.test(value)) {
    issues.push({ path: `${path}/${key}`, message: `must match ${pattern.source}` })
  }
  return value
}

function readSafeInteger(
  record: JsonObject,
  key: string,
  path: string,
  minimum: number,
  issues: FormatIssue[],
): number {
  const value = record[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    issues.push({
      path: `${path}/${key}`,
      message: `must be a safe integer greater than or equal to ${minimum}`,
    })
    return minimum
  }
  return value
}

function readBoundedString(
  record: JsonObject,
  key: string,
  path: string,
  minLength: number,
  maxLength: number,
  issues: FormatIssue[],
  rejectBlank = false,
): string {
  const value = readString(record, key, path, issues)
  const measured = rejectBlank ? value.trim() : value
  if (measured.length < minLength || value.length > maxLength) {
    issues.push({
      path: `${path}/${key}`,
      message: `length must be between ${minLength} and ${maxLength}`,
    })
  }
  return value
}

function readOptionalBoundedString(
  record: JsonObject,
  key: string,
  path: string,
  minLength: number,
  maxLength: number,
  issues: FormatIssue[],
): string | undefined {
  if (record[key] === undefined) {
    return undefined
  }
  return readBoundedString(record, key, path, minLength, maxLength, issues)
}

function collectUnknownFields(
  record: JsonObject,
  knownFields: ReadonlySet<string>,
  path: string,
  warnings: FormatWarning[],
): void {
  for (const key of Object.keys(record)) {
    if (!knownFields.has(key)) {
      warnings.push({
        code: 'UNKNOWN_FIELD',
        path: `${path}/${key}`,
        message: 'field is not defined by MDV 0.1',
      })
    }
  }
}

function freezeJsonObject<T extends JsonObject>(record: JsonObject, known: JsonObject): T {
  const result = Object.create(null) as Record<string, JsonValue | undefined>
  for (const [key, value] of Object.entries(record)) {
    result[key] = value
  }
  for (const [key, value] of Object.entries(known)) {
    result[key] = value
  }
  return Object.freeze(result) as T
}

function throwIfInvalid(kind: FormatFileKind, issues: FormatIssue[]): void {
  if (issues.length > 0) {
    throw new FormatDecodeError(kind, issues)
  }
}
