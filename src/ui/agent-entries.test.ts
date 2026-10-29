import { describe, expect, it } from 'vitest'
import { groupItems, mergeToolResults, splitHtmlBlocks } from './agent-entries'
import type { ChatEntry } from './agent-store'

let nextId = 0
const entry = (kind: ChatEntry['kind'], text: string, name?: string): ChatEntry => ({ id: ++nextId, kind, text, ...(name ? { name } : {}) })

describe('splitHtmlBlocks', () => {
  it('splits markdown and html fences', () => {
    const parts = splitHtmlBlocks('before\n```html\n<div>hi</div>\n```\nafter')
    expect(parts.map((p) => p.kind)).toEqual(['md', 'html', 'md'])
    expect(parts[1].text).toBe('<div>hi</div>')
  })

  it('backticks inside the HTML do not truncate the block', () => {
    const parts = splitHtmlBlocks('```html\n<script>const s = \\`\\`\\`;</script>\n```')
    expect(parts).toEqual([{ kind: 'html', text: '<script>const s = \\`\\`\\`;</script>' }])
  })

  it('case-insensitive fence and unmatched fence stay safe', () => {
    expect(splitHtmlBlocks('```HTML\n<p>x</p>')[0].kind).toBe('html')
    expect(splitHtmlBlocks('plain text, no fences')).toEqual([{ kind: 'md', text: 'plain text, no fences' }])
  })
})

describe('mergeToolResults + groupItems', () => {
  it('folds a result into the preceding tool entry', () => {
    const merged = mergeToolResults([entry('tool', 'bash ls', 'bash'), entry('result', 'file.txt', 'bash')])
    expect(merged).toHaveLength(1)
    expect(merged[0].resultText).toBe('file.txt')
  })

  it('groups consecutive tools into one block', () => {
    const items = groupItems([
      entry('tool', 'bash a', 'bash'),
      entry('result', 'ok', 'bash'),
      entry('tool', 'read /x', 'read'),
      entry('assistant', 'done'),
    ])
    expect(items.map((item) => item.kind)).toEqual(['tools', 'single'])
    if (items[0].kind === 'tools') expect(items[0].entries).toHaveLength(2)
  })

  it('a result with no preceding tool stays a single entry', () => {
    const items = groupItems([entry('result', 'orphan')])
    expect(items[0].kind).toBe('single')
  })
})
