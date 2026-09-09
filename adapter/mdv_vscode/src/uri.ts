import { posix } from 'node:path'
import * as vscode from 'vscode'
import type { ContentSpec, DocumentId } from '@mdv/core'

export interface MdvSource {
  readonly packageUri: vscode.Uri
  readonly documentId: DocumentId
  readonly content: ContentSpec
}

export function sourceUri(packageUri: vscode.Uri, documentId: DocumentId, content: ContentSpec): vscode.Uri {
  requireLocalPackage(packageUri)
  const revision = content.kind === 'version' ? content.version : 'working'
  return packageUri.with({
    scheme: 'mdv', authority: documentId, query: '', fragment: '',
    path: `${packageUri.path}.${content.tree}.${revision}.md`,
  })
}

export function parseSource(uri: vscode.Uri): MdvSource | undefined {
  if (uri.scheme !== 'mdv' || !/^d_[0-9a-f]{32}$/.test(uri.authority) || uri.query !== '') return undefined
  const match = /^(.*\.[mM][dD][vV])\.(reference|document)\.(working|v_[0-9a-f]{32})\.md$/.exec(uri.path)
  if (!match) return undefined
  const tree = match[2] as 'reference' | 'document'
  return {
    packageUri: uri.with({ scheme: 'file', authority: '', path: match[1]!, query: '', fragment: '' }),
    documentId: uri.authority as DocumentId,
    content: match[3] === 'working'
      ? { tree, kind: 'working-copy' }
      : { tree, kind: 'version', version: match[3] as `v_${string}` },
  }
}

export function requireSource(uri: vscode.Uri): MdvSource {
  const source = parseSource(uri)
  if (!source) throw vscode.FileSystemError.FileNotFound('Not an MDV Markdown source')
  return source
}

export function requireLocalPackage(uri: vscode.Uri): void {
  if (uri.scheme !== 'file' || uri.authority || !/\.mdv$/i.test(uri.path) || vscode.env.remoteName) {
    throw new Error('This preview release supports local desktop .mdv files only.')
  }
}

export function sourceKey(uri: vscode.Uri): string {
  return uri.with({ fragment: '' }).toString()
}

/** Keep the Markdown parent equal to the real package parent; relative links retain their meaning. */
export function imageResourceUri(source: vscode.Uri, href: string): vscode.Uri | undefined {
  const parsed = parseSource(source)
  if (!parsed || /^(?:https?:|data:|\/\/)/i.test(href)) return undefined
  let target: vscode.Uri
  if (/^file:/i.test(href)) {
    target = vscode.Uri.parse(href)
    if (target.authority) return undefined
  } else if (/^[a-z]:[\\/]/i.test(href)) {
    target = vscode.Uri.file(href)
  } else {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return undefined
    const link = vscode.Uri.parse(`mdv-link:${href}`)
    target = parsed.packageUri.with({
      path: link.path.startsWith('/') ? link.path : posix.resolve(posix.dirname(parsed.packageUri.path), link.path),
      query: link.query, fragment: link.fragment,
    })
  }
  const encode = (value: string) => Buffer.from(value).toString('base64url')
  return source.with({
    path: posix.join(posix.dirname(parsed.packageUri.path), '.mdv-preview',
      encode(parsed.packageUri.toString()), encode(target.with({ query: '', fragment: '' }).toString())),
    query: '', fragment: target.fragment,
  })
}

export function parseImageResource(uri: vscode.Uri): {
  readonly packageUri: vscode.Uri
  readonly documentId: DocumentId
  readonly target: vscode.Uri
} | undefined {
  if (uri.scheme !== 'mdv' || !/^d_[0-9a-f]{32}$/.test(uri.authority) || uri.path.length > 16_384) return undefined
  const match = /^(.*)\/\.mdv-preview\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)$/.exec(uri.path)
  if (!match) return undefined
  const packageUri = vscode.Uri.parse(Buffer.from(match[2]!, 'base64url').toString('utf8'))
  const target = vscode.Uri.parse(Buffer.from(match[3]!, 'base64url').toString('utf8'))
  requireLocalPackage(packageUri)
  if (target.scheme !== 'file' || target.authority || target.query || target.fragment
    || posix.dirname(packageUri.path) !== match[1]) return undefined
  return { packageUri, documentId: uri.authority as DocumentId, target }
}
