import type MarkdownIt from 'markdown-it'
import * as vscode from 'vscode'
import { imageResourceUri, parseSource } from './uri.js'

/** Extend the existing Markdown renderer only to resolve MDV image resources. */
export function extendMarkdownIt(markdown: MarkdownIt): MarkdownIt {
  const previous = markdown.renderer.rules.image
  markdown.renderer.rules.image = (tokens, index, options, env: unknown, renderer) => {
    const context = env as {
      currentDocument?: vscode.Uri
      resourceProvider?: { asWebviewUri(uri: vscode.Uri): vscode.Uri }
    } | undefined
    const token = tokens[index]!
    if (context?.currentDocument && parseSource(context.currentDocument) && context.resourceProvider) {
      const original = token.attrGet('data-src') ?? token.attrGet('src')
      if (original) {
        try {
          const resource = imageResourceUri(context.currentDocument, original)
          if (resource) token.attrSet('src', context.resourceProvider.asWebviewUri(resource).toString())
        } catch { token.attrSet('src', '') }
      }
    }
    return previous ? previous(tokens, index, options, env, renderer) : renderer.renderToken(tokens, index, options)
  }
  return markdown
}
