declare const documentIdBrand: unique symbol
declare const versionIdBrand: unique symbol
declare const generationBrand: unique symbol

export type DocumentId = string & { readonly [documentIdBrand]: true }
export type VersionId = string & { readonly [versionIdBrand]: true }
export type Generation = number & { readonly [generationBrand]: true }

const DOCUMENT_ID = /^d_[0-9a-f]{32}$/
const VERSION_ID = /^v_[0-9a-f]{32}$/

export function isDocumentId(value: string): boolean {
  return DOCUMENT_ID.test(value)
}

export function isVersionId(value: string): boolean {
  return VERSION_ID.test(value)
}

export function isGeneration(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

export function brandDocumentId(value: string): DocumentId {
  return value as DocumentId
}

export function brandVersionId(value: string): VersionId {
  return value as VersionId
}

export function brandGeneration(value: number): Generation {
  return value as Generation
}

