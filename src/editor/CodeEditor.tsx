import { useEffect, useMemo, useRef } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { oneDark } from '@codemirror/theme-one-dark'
import { EditorView } from '@codemirror/view'
import type { ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { diagnosticsStore } from '../diagnostics-store'
import { languageExtensions } from './lang-extensions'

export interface CodeEditorProps {
  path: string
  value: string
  active: boolean
  /** 1-based line to cursor + scroll to; consumed once per change */
  revealLine?: number
  onRevealed?: () => void
  onChange: (next: string) => void
}

/**
 * One CodeMirror instance per open tab, kept mounted (hidden with CSS) so
 * cursor, scroll and undo history survive tab switches. The extensions array
 * is rebuilt when the diagnostics version changes, which re-runs the lint
 * source — see diagnostics-extension.ts.
 */
export default function CodeEditor({ path, value, active, revealLine, onRevealed, onChange }: CodeEditorProps) {
  const ref = useRef<ReactCodeMirrorRef>(null)
  const { version: diagVersion } = diagnosticsStore.get()

  const extensions = useMemo(() => [...languageExtensions(path), oneDark], [path, diagVersion])

  useEffect(() => {
    const view: EditorView | null = ref.current?.view ?? null
    if (!view) return
    if (active) {
      view.requestMeasure()
      view.focus()
    }
  }, [active])

  useEffect(() => {
    const view: EditorView | null = ref.current?.view ?? null
    if (!view || revealLine === undefined) return
    const line = Math.min(Math.max(1, revealLine), view.state.doc.lines)
    const pos = view.state.doc.line(line).from
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: 'center' }),
    })
    view.focus()
    onRevealed?.()
  }, [revealLine])

  return (
    <div className={`editor-instance ${active ? '' : 'hidden-editor'}`}>
      <CodeMirror
        ref={ref}
        value={value}
        height="100%"
        theme="none"
        extensions={extensions}
        basicSetup={{
          lineNumbers: true,
          highlightActiveLine: true,
          highlightActiveLineGutter: true,
          bracketMatching: true,
          closeBrackets: true,
          autocompletion: true,
          foldGutter: true,
        }}
        onChange={onChange}
      />
    </div>
  )
}
