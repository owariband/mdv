import { TextDecoder } from 'node:util'

import { ArchiveError } from './errors.js'

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export function parseJsonEntry(
  bytes: Uint8Array,
  entry: string,
  maxDepth: number,
  invalidCode: 'INVALID_MANIFEST' | 'INVALID_VERSION' = 'INVALID_MANIFEST',
): unknown {
  let text: string
  try {
    text = UTF8_DECODER.decode(bytes)
  } catch (cause) {
    throw new ArchiveError('INVALID_UTF8', `Entry ${entry} is not valid UTF-8`, { entry, cause })
  }

  if (text.charCodeAt(0) === 0xfeff) {
    throw new ArchiveError(invalidCode, `Entry ${entry} must not contain a UTF-8 BOM`, {
      entry,
    })
  }

  try {
    new JsonSyntaxScanner(text, maxDepth).scan()
    return JSON.parse(text) as unknown
  } catch (cause) {
    if (cause instanceof ArchiveError) {
      throw cause
    }
    const message = cause instanceof Error ? cause.message : String(cause)
    throw new ArchiveError(invalidCode, `Entry ${entry} is not valid JSON: ${message}`, {
      entry,
      cause,
    })
  }
}

class JsonSyntaxScanner {
  private offset = 0

  constructor(
    private readonly text: string,
    private readonly maxDepth: number,
  ) {}

  scan(): void {
    this.skipWhitespace()
    this.parseValue(0)
    this.skipWhitespace()
    if (this.offset !== this.text.length) {
      this.fail('unexpected content after the root value')
    }
  }

  private parseValue(depth: number): void {
    const token = this.text[this.offset]
    if (token === '{') {
      this.parseObject(depth + 1)
      return
    }
    if (token === '[') {
      this.parseArray(depth + 1)
      return
    }
    if (token === '"') {
      this.parseString()
      return
    }
    if (token === '-' || isDigit(token)) {
      this.parseNumber()
      return
    }
    if (this.consumeLiteral('true') || this.consumeLiteral('false') || this.consumeLiteral('null')) {
      return
    }
    this.fail('expected a JSON value')
  }

  private parseObject(depth: number): void {
    this.checkDepth(depth)
    this.offset += 1
    this.skipWhitespace()
    if (this.consume('}')) {
      return
    }

    const keys = new Set<string>()
    while (true) {
      if (this.text[this.offset] !== '"') {
        this.fail('expected an object member name')
      }
      const key = this.parseString()
      if (keys.has(key)) {
        this.fail(`duplicate object member ${JSON.stringify(key)}`)
      }
      keys.add(key)
      this.skipWhitespace()
      if (!this.consume(':')) {
        this.fail('expected a colon after an object member name')
      }
      this.skipWhitespace()
      this.parseValue(depth)
      this.skipWhitespace()
      if (this.consume('}')) {
        return
      }
      if (!this.consume(',')) {
        this.fail('expected a comma or closing brace')
      }
      this.skipWhitespace()
    }
  }

  private parseArray(depth: number): void {
    this.checkDepth(depth)
    this.offset += 1
    this.skipWhitespace()
    if (this.consume(']')) {
      return
    }

    while (true) {
      this.parseValue(depth)
      this.skipWhitespace()
      if (this.consume(']')) {
        return
      }
      if (!this.consume(',')) {
        this.fail('expected a comma or closing bracket')
      }
      this.skipWhitespace()
    }
  }

  private parseString(): string {
    const start = this.offset
    this.offset += 1

    while (this.offset < this.text.length) {
      const character = this.text[this.offset]
      if (character === '"') {
        this.offset += 1
        return JSON.parse(this.text.slice(start, this.offset)) as string
      }
      if (character === '\\') {
        this.offset += 1
        const escape = this.text[this.offset]
        if (escape === 'u') {
          const hex = this.text.slice(this.offset + 1, this.offset + 5)
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            this.fail('invalid Unicode escape')
          }
          this.offset += 5
          continue
        }
        if (escape === undefined || !'"\\/bfnrt'.includes(escape)) {
          this.fail('invalid string escape')
        }
        this.offset += 1
        continue
      }
      if (character === undefined || character.charCodeAt(0) < 0x20) {
        this.fail('unescaped control character in string')
      }
      this.offset += 1
    }

    this.fail('unterminated string')
  }

  private parseNumber(): void {
    const remaining = this.text.slice(this.offset)
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(remaining)
    if (match === null) {
      this.fail('invalid number')
    }
    this.offset += match[0].length
  }

  private consumeLiteral(literal: string): boolean {
    if (!this.text.startsWith(literal, this.offset)) {
      return false
    }
    this.offset += literal.length
    return true
  }

  private consume(character: string): boolean {
    if (this.text[this.offset] !== character) {
      return false
    }
    this.offset += 1
    return true
  }

  private skipWhitespace(): void {
    while (
      this.text[this.offset] === ' '
      || this.text[this.offset] === '\n'
      || this.text[this.offset] === '\r'
      || this.text[this.offset] === '\t'
    ) {
      this.offset += 1
    }
  }

  private checkDepth(depth: number): void {
    if (depth > this.maxDepth) {
      throw new ArchiveError('LIMIT_EXCEEDED', `JSON nesting exceeds ${this.maxDepth}`)
    }
  }

  private fail(message: string): never {
    throw new SyntaxError(`${message} at character ${this.offset}`)
  }
}

function isDigit(character: string | undefined): boolean {
  return character !== undefined && character >= '0' && character <= '9'
}
