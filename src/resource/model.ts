import { createHash } from 'node:crypto'

export type ResourceMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
export type ResourceErrorCode =
  | 'INVALID_RESOURCE' | 'NOT_FOUND' | 'LIMIT_EXCEEDED'
  | 'INTEGRITY_MISMATCH' | 'CONFLICT' | 'IO_ERROR'

export class ResourceError extends Error {
  constructor(
    readonly code: ResourceErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'ResourceError'
    this.details = Object.freeze({ ...details })
  }
}

export interface ResourceLocation {
  readonly documentId: string
  readonly relativePath: string
  readonly fileName: string
  readonly sha256: string
  readonly mediaType: ResourceMediaType
}

export interface PreparedResource {
  readonly location: ResourceLocation
  readonly bytes: Uint8Array
  readonly maxBytes: number
}

const EXTENSIONS = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
} as const)
const RESOURCE_PATH = /^(?:\.\/)?\.mdv-assets\/(d_[0-9a-f]{32})\/([0-9a-f]{64})\.(png|jpg|gif|webp)$/
export const DEFAULT_RESOURCE_MAX_BYTES = 32 * 1024 * 1024

export function resolveResourceLimit(options: { readonly maxBytes?: number } = {}): number {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Resource options must be an object')
  }
  const requestedMaxBytes = options.maxBytes
  const maxBytes = requestedMaxBytes === undefined ? DEFAULT_RESOURCE_MAX_BYTES : requestedMaxBytes
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError('maxBytes must be a positive safe integer')
  }
  return maxBytes
}

export function checkResourceSize(actualBytes: number, maxBytes: number): void {
  if (actualBytes > maxBytes) {
    throw new ResourceError('LIMIT_EXCEEDED', `Resource exceeds ${maxBytes} bytes`, {
      maxBytes, actualBytes,
    })
  }
}

export function parseResourcePath(documentId: string, relativePath: string): ResourceLocation {
  if (typeof relativePath !== 'string') {
    throw new TypeError('Managed resource path must be a string')
  }
  const match = RESOURCE_PATH.exec(relativePath)
  if (match === null || match[0] !== relativePath) {
    throw new ResourceError('INVALID_RESOURCE', 'Invalid managed resource path', {
      reason: 'invalid-path', relativePath,
    })
  }
  if (match[1] !== documentId) {
    throw new ResourceError('INVALID_RESOURCE', 'Resource belongs to another document', {
      reason: 'wrong-document', relativePath, expectedDocumentId: documentId,
    })
  }
  const sha256 = match[2]!
  const extension = match[3]!
  const mediaType = (Object.keys(EXTENSIONS) as ResourceMediaType[])
    .find((type) => EXTENSIONS[type] === extension)!
  const fileName = `${sha256}.${extension}`
  return Object.freeze({
    documentId, sha256, fileName, mediaType,
    relativePath: `./.mdv-assets/${documentId}/${fileName}`,
  })
}

export function prepareResource(
  documentId: string,
  input: { readonly bytes: Uint8Array; readonly mediaType?: string },
  maxBytes: number,
): PreparedResource {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Import resource input must be an object')
  }
  const inputBytes = input.bytes
  const declaredType = input.mediaType
  if (!(inputBytes instanceof Uint8Array)) {
    throw new TypeError('Resource bytes must be a Uint8Array')
  }
  if (declaredType !== undefined && typeof declaredType !== 'string') {
    throw new TypeError('Resource mediaType must be a string')
  }
  checkResourceSize(inputBytes.byteLength, maxBytes)
  const bytes = Uint8Array.from(inputBytes)
  const mediaType = identifyImage(bytes)
  if (declaredType !== undefined && declaredType !== mediaType) {
    throw new ResourceError('INVALID_RESOURCE', 'Declared MIME does not match image content', {
      reason: 'media-type-mismatch', declaredMediaType: declaredType, actualMediaType: mediaType,
    })
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  return Object.freeze({
    location: parseResourcePath(documentId, `./.mdv-assets/${documentId}/${sha256}.${EXTENSIONS[mediaType]}`),
    bytes,
    maxBytes,
  })
}

// Header identification only: decoding pixels and renderer security belong to the host.
export function identifyImage(bytes: Uint8Array): ResourceMediaType {
  const header = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (header.length >= 24
    && header.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    && header.readUInt32BE(8) === 13
    && header.toString('latin1', 12, 16) === 'IHDR'
    && header.readUInt32BE(16) > 0 && header.readUInt32BE(20) > 0) {
    return 'image/png'
  }
  if (header.length >= 4 && header[0] === 0xff && header[1] === 0xd8
    && header[2] === 0xff && header[3] !== 0 && header[3] !== 0xff) {
    return 'image/jpeg'
  }
  if (header.length >= 10 && ['GIF87a', 'GIF89a'].includes(header.toString('latin1', 0, 6))
    && header.readUInt16LE(6) > 0 && header.readUInt16LE(8) > 0) {
    return 'image/gif'
  }
  if (header.length >= 20 && header.toString('latin1', 0, 4) === 'RIFF'
    && header.toString('latin1', 8, 12) === 'WEBP'
    && header.readUInt32LE(4) === header.length - 8
    && ['VP8 ', 'VP8L', 'VP8X'].includes(header.toString('latin1', 12, 16))) {
    return 'image/webp'
  }
  throw new ResourceError('INVALID_RESOURCE', 'Unsupported or incomplete image header', {
    reason: 'unsupported-media',
  })
}

export function validateResourceContent(bytes: Uint8Array, resource: ResourceLocation): void {
  const actualSha256 = createHash('sha256').update(bytes).digest('hex')
  if (actualSha256 !== resource.sha256) {
    throw new ResourceError('INTEGRITY_MISMATCH', 'Resource hash does not match its path', {
      relativePath: resource.relativePath,
      expectedSha256: resource.sha256, actualSha256,
    })
  }
  let mediaType: ResourceMediaType
  try {
    mediaType = identifyImage(bytes)
  } catch (cause) {
    throw new ResourceError('INTEGRITY_MISMATCH', 'Managed resource is not a supported image', {
      relativePath: resource.relativePath, reason: 'unsupported-media',
    }, cause)
  }
  if (mediaType !== resource.mediaType) {
    throw new ResourceError('INTEGRITY_MISMATCH', 'Resource extension does not match its content', {
      relativePath: resource.relativePath, reason: 'media-type-mismatch',
      expectedMediaType: resource.mediaType, actualMediaType: mediaType,
    })
  }
}
