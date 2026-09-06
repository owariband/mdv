# MDV Container Format 0.1

Status: frozen implementation baseline for the 0.1 reference implementation.

This document is normative for the physical `.mdv` format. Product behavior and
the TypeScript API are described separately in `docs/design.md` and
`docs/technical_solution.md`.

The key words MUST, MUST NOT, REQUIRED, SHOULD, SHOULD NOT, and MAY are to be
interpreted as requirement levels.

## 1. Overview

An MDV file is a single ZIP archive containing two independent Markdown working
copies and their immutable commit histories:

```text
manifest.json
ref_tree/current.md
ref_tree/HEAD                                      optional
ref_tree/versions/<version-id>/meta.json           zero or more
ref_tree/versions/<version-id>/content.md          paired with meta.json
doc_tree/current.md
doc_tree/HEAD                                      optional
doc_tree/versions/<version-id>/meta.json           zero or more
doc_tree/versions/<version-id>/content.md           paired with meta.json
```

An archive MUST contain `manifest.json`, `ref_tree/current.md`, and
`doc_tree/current.md`. A `HEAD` entry MUST be absent when its tree has no current
committed version. Directory entries are not part of the logical format and
writers SHOULD omit them.

Readers MUST reject file entries outside the grammar above. Version directories
MUST contain exactly one `meta.json` and one `content.md`.

## 2. ZIP profile

- Writers MUST produce a single-disk ZIP archive and MUST NOT emit ZIP64.
- Readers MUST reject multi-disk, ZIP64 and encrypted archives.
- File entries MAY use Store (method 0) or Deflate (method 8).
- Entry names MUST be UTF-8, use `/`, and be Unicode NFC.
- Entry names MUST NOT be absolute, contain an empty path segment, `.`, `..`,
  `\\`, NUL, or a trailing `/` file name.
- Symlinks and other non-regular file entries MUST be rejected.
- Exact duplicate names, Unicode-normalized duplicates, and ASCII
  case-folded duplicates MUST be rejected.
- Readers MUST validate declared and actual uncompressed lengths. They SHOULD
  validate the ZIP CRC in addition to MDV content hashes.

ZIP timestamps, entry comments, entry ordering and compression choices have no
MDV semantics. A conforming reader MUST NOT use them to order versions.

Implementations MAY impose lower resource limits than the ZIP32 maxima. A limit
failure MUST be distinguishable from structural corruption.

## 3. Text and JSON encoding

All Markdown, JSON and `HEAD` entries MUST be well-formed UTF-8 without a byte
order mark. Markdown bytes are content: readers and writers MUST NOT normalize
line endings, whitespace, or Unicode.

JSON MUST conform to RFC 8259 and MUST NOT contain duplicate object member names.
Numbers used by this specification MUST be non-negative safe integers no greater
than `9007199254740991`.

Unknown JSON members are permitted for compatible extensions. A 0.1 reader MUST
ignore them for semantics and SHOULD report a warning. A writer that rewrites the
containing JSON object MUST preserve unknown members and their JSON values.

Schemas under `schemas/` validate individual JSON object shapes. They do not
replace the cross-entry and graph rules in this document.

## 4. Identifiers

`documentId` MUST match:

```text
^d_[0-9a-f]{32}$
```

Every Version ID MUST match:

```text
^v_[0-9a-f]{32}$
```

Writers MUST generate the 16-byte hexadecimal payload from a cryptographically
secure random source. IDs are opaque and do not encode time or ordering.

Every Version ID MUST be unique across both trees in one MDV file. The version
directory name and its `meta.json.id` MUST be identical.

## 5. Manifest

`manifest.json` has the schema `schemas/manifest.schema.json`. Its defined fields
are:

```json
{
  "format": "mdv",
  "formatVersion": "0.1",
  "documentId": "d_0123456789abcdef0123456789abcdef",
  "generation": 0,
  "markdownProfile": "gfm"
}
```

- `format` MUST equal `mdv`.
- `formatVersion` MUST equal `0.1`.
- `generation` starts at zero and MUST increase by exactly one for every
  successful save, commit, or checkout transaction.
- `markdownProfile` is a lower-case profile token of at most 64 characters.
  `gfm` is the only profile registered by this specification. Unknown valid
  tokens do not invalidate the archive but SHOULD produce a warning.

## 6. Working copies and HEAD

`ref_tree/current.md` and `doc_tree/current.md` are mutable Markdown working
copies. Updating a working copy does not create a version.

Each optional `HEAD` entry contains exactly one Version ID followed by one LF:

```text
v_0123456789abcdef0123456789abcdef\n
```

`ref_tree/HEAD` MUST point to a version in `ref_tree`; `doc_tree/HEAD` MUST point
to a version in `doc_tree`. HEAD does not need to point to a leaf. Checking out an
older version intentionally permits a later commit to create a branch.

When HEAD is absent, its working copy is dirty if and only if it is non-empty.
When HEAD exists, its working copy is dirty if and only if its raw SHA-256 differs
from the HEAD version content.

## 7. Version metadata

Reference metadata conforms to `schemas/reference-version.schema.json`.
Document metadata conforms to `schemas/document-version.schema.json`.

Shared defined fields are:

- `schemaVersion`: integer `1`.
- `id`: the Version ID matching the containing directory.
- `parent`: another Version ID in the same tree, or `null` for a root.
- `createdAt`: an RFC 3339 timestamp with `Z` or an explicit numeric offset.
- `actor.type`: `human` or `agent`.
- `actor.id` and `actor.name`: optional non-empty strings of at most 256
  characters.
- `summary`: a non-blank commit summary of at most 4096 characters.
- `contentSha256`: lower-case hexadecimal SHA-256 of the paired `content.md` raw
  bytes.
- `contentBytes`: the exact raw byte length of the paired `content.md`.

Document metadata additionally contains required `referenceVersion`. Its value
MUST be either a Version ID in `ref_tree` or JSON `null`. `null` explicitly means
that the Document Version has no Reference dependency.

Reference metadata does not contain forward or reverse Document binds. Reverse
bind indexes are derived by scanning Document metadata.

Version `content.md` is immutable. A writer MUST NOT replace an existing version
directory, metadata object, or content entry.

## 8. Graph invariants

The Reference and Document parent graphs are validated independently:

- every non-null parent MUST exist in the same tree;
- neither parent graph may contain a cycle;
- multiple children of one parent are valid;
- versions unreachable from the current HEAD are valid and MUST be retained.

Every non-null `referenceVersion` MUST resolve to a Reference Version. A Document
Version MUST NOT bind a working copy or a Document Version.

## 9. Initial archive

A newly created MDV archive has:

- `generation = 0`;
- two zero-byte working copies;
- no HEAD entries;
- no version entries.

Initialization MUST NOT create empty Reference or Document versions. A document
may permanently keep the Reference tree empty and commit Document Versions with
`referenceVersion: null`.

## 10. Reading and integrity

Opening an archive requires validation of ZIP structure, JSON shape, entry paths,
IDs, HEAD pointers, parents, binds and graph cycles. Historical Markdown content
MAY be decompressed lazily.

Before returning version content, a reader MUST verify `contentBytes` and
`contentSha256`. A full verification operation MUST verify every version body.
Both working copies MUST be checked for valid UTF-8 when opened or first read.

## 11. Writing

Successful save, commit, and checkout operations are whole-package transactions:

1. acquire an exclusive lock for the target MDV file;
2. reopen the latest archive while holding the lock;
3. compare the caller's expected generation;
4. apply one semantic operation;
5. write a complete temporary ZIP in the target directory;
6. validate the temporary archive;
7. durably flush it and atomically replace the target;
8. release the lock.

Writers MUST NOT modify the target ZIP in place. A generation mismatch MUST fail
without changing the target.

For reproducible output, writers SHOULD encode JSON with two-space indentation
and a final LF, set a fixed ZIP timestamp, and order entries by their UTF-8 entry
name bytes. Readers MUST NOT depend on these recommendations.

## 12. Relative resources

MDV 0.1 does not embed or version attachments. Relative links and images in any
Markdown body are resolved against the directory containing the `.mdv` file.
Moving the MDV file without its external resources may break those references.

