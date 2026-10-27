import type { Extension } from '@codemirror/state'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { markdown } from '@codemirror/lang-markdown'
import { vfsPath } from '../vfs/types'
import { diagnosticsLinter, diagnosticGutter } from './diagnostics-extension'

/**
 * The single composition point for per-language editor extensions.
 * The language service (src/lang) appends its diagnostics wiring here —
 * keep every new per-language feature flowing through this function.
 */
export function languageExtensions(path: string): Extension[] {
  const ext = vfsPath.ext(path)
  const language: Extension | null =
    ext === 'ts' || ext === 'mts' || ext === 'cts'
      ? javascript({ typescript: true })
      : ext === 'tsx'
        ? javascript({ typescript: true, jsx: true })
        : ext === 'js' || ext === 'mjs' || ext === 'cjs'
          ? javascript()
          : ext === 'jsx'
            ? javascript({ jsx: true })
            : ext === 'json'
              ? json()
              : ext === 'css'
                ? css()
                : ext === 'html' || ext === 'htm'
                  ? html()
                  : ext === 'md' || ext === 'markdown'
                    ? markdown()
                    : null
  const extensions: Extension[] = []
  if (language) extensions.push(language)
  extensions.push(diagnosticsLinter(path), diagnosticGutter)
  return extensions
}
