export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[]

export interface JsonObject {
  readonly [key: string]: JsonValue | undefined
}

export interface ActorFileDto extends JsonObject {
  readonly type: 'human' | 'agent'
  readonly id?: string
  readonly name?: string
}

export interface ManifestFileDto extends JsonObject {
  readonly format: 'mdv'
  readonly formatVersion: '0.1'
  readonly documentId: string
  readonly generation: number
  readonly markdownProfile: string
}

export interface VersionMetaFileDto extends JsonObject {
  readonly schemaVersion: 1
  readonly id: string
  readonly parent: string | null
  readonly createdAt: string
  readonly actor: ActorFileDto
  readonly summary: string
  readonly contentSha256: string
  readonly contentBytes: number
}

export interface DocumentVersionMetaFileDto extends VersionMetaFileDto {
  readonly referenceVersion: string | null
}

export interface LocatedVersionFileDto<T extends VersionMetaFileDto> {
  readonly directoryId: string
  readonly meta: T
}

export interface ArchiveIndexDto {
  readonly manifest: ManifestFileDto
  readonly referenceHead: string | null
  readonly documentHead: string | null
  readonly referenceVersions: readonly LocatedVersionFileDto<VersionMetaFileDto>[]
  readonly documentVersions: readonly LocatedVersionFileDto<DocumentVersionMetaFileDto>[]
}

