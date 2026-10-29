/**
 * File references in assistant text. The agent links artifacts with
 * [label](cell-file:/abs/path); bare absolute/relative paths and
 * inline-code filenames that resolve to real files are linkified too.
 * Everything unresolved stays plain markdown.
 */

export type FileRefPart =
  | { kind: 'md'; text: string }
  | { kind: 'file'; path: string; label: string }

const FILE_EXTENSIONS = 'png|jpe?g|gif|webp|svg|bmp|ico|html?|txt|md|markdown|json|csv|tsv|pdf|py|jsx?|tsx?|css'

/**
 * candidates, in priority order:
 *  1. [label](cell-file:path) — explicit agent-made link
 *  2. /abs/path.ext or ~/path.ext
 *  3. relative/path.ext (contains a slash)
 *  4. `bare-name.ext` in inline code
 * resolve() maps a candidate to a real absolute path or null; only
 * resolved candidates become links (candidate 1 always links — the
 * agent asserted the file exists; preview reports if it is gone).
 */
const CANDIDATE = new RegExp(
  `\\[([^\\]\\n]{1,80})\\]\\(cell-file:([^)\\s]+)\\)` +
  `|(\\/(?:home|tmp)\\/[^\\s()'"<>\\[\\]]+?\\.(?:${FILE_EXTENSIONS}))\\b` +
  `|(~\\/[^\\s()'"<>\\[\\]]+?\\.(?:${FILE_EXTENSIONS}))\\b` +
  `|((?:[\\w.-]+\\/)+[\\w.-]+\\.(?:${FILE_EXTENSIONS}))\\b` +
  `|\\x60([^\\x60\\n/]+\\.(?:${FILE_EXTENSIONS}))\\x60`,
  'gi',
)

export function splitFileRefs(text: string, resolve: (candidate: string) => string | null): FileRefPart[] {
  const parts: FileRefPart[] = []
  let last = 0
  for (const match of text.matchAll(CANDIDATE)) {
    const index = match.index ?? 0
    const [whole, linkLabel, linkPath, absPath, tildePath, relPath, codeName] = match
    let candidate: string | null = null
    let label: string | null = null
    let explicit = false
    if (linkPath !== undefined) {
      candidate = linkPath
      label = linkLabel
      explicit = true
    } else if (absPath !== undefined) candidate = absPath
    else if (tildePath !== undefined) candidate = tildePath
    else if (relPath !== undefined) candidate = relPath
    else if (codeName !== undefined) candidate = codeName
    if (candidate === null) continue
    const resolved = explicit ? candidate : resolve(candidate)
    if (resolved === null) continue
    if (index > last) parts.push({ kind: 'md', text: text.slice(last, index) })
    parts.push({ kind: 'file', path: resolved, label: label ?? resolved.split('/').pop() ?? resolved })
    last = index + whole.length
  }
  if (last < text.length) parts.push({ kind: 'md', text: text.slice(last) })
  return parts.length > 0 ? parts : [{ kind: 'md', text }]
}

export function fileKind(path: string): 'image' | 'html' | 'text' | 'other' {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext)) return 'image'
  if (ext === 'html' || ext === 'htm') return 'html'
  if (['txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'py', 'js', 'ts', 'tsx', 'jsx', 'css'].includes(ext)) return 'text'
  return 'other'
}
