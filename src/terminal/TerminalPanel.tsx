import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { platform } from '../platform'
import { createShell, type Shell } from '../shell/shell'
import { vfsPath } from '../vfs/types'

const MAX_HISTORY = 200
const BASH_ROOT = '/workspace'

/**
 * Line-oriented shell front-end: prompt, editing keys, history, and cd
 * tracking. just-bash executes whole lines; there is no PTY, so programs
 * that need raw tty mode won't behave interactively — fine for the MVP.
 */
export default function TerminalPanel() {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    let disposed = false
    let raf = 0
    let teardown: (() => void) | null = null

    const attach = () => {
      if (disposed) return
      const rect = host.getBoundingClientRect()
      // xterm's renderer crashes if open() runs against a zero-size host
      // (lazy mount inside a flex panel can be one frame early)
      if (rect.width === 0 || rect.height === 0) {
        raf = requestAnimationFrame(attach)
        return
      }
      runTerminal(host)
    }
    raf = requestAnimationFrame(attach)

    function runTerminal(host: HTMLDivElement) {
      const { vfs, bus } = platform()
      const shell: Shell = createShell(vfs)

    const term = new Terminal({
      fontFamily: "'Cascadia Code', 'JetBrains Mono', Consolas, ui-monospace, monospace",
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      theme: {
        background: '#1e1e1e',
        foreground: '#cccccc',
        cursor: '#cccccc',
        selectionBackground: '#264f78',
      },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(host)
    fit.fit()

    let cwd = '/'
    let line = ''
    let history: string[] = []
    let histIdx = -1
    let running = false

    const promptText = () => `\x1b[36m~${cwd === '/' ? '' : cwd}\x1b[0m $ `
    const printPrompt = () => term.write(promptText())

    const resolveCd = (target: string): string => {
      if (target === '' || target === '~') return '/'
      const base = target.startsWith('/') ? target : `${cwd === '/' ? '' : cwd}/${target}`
      return vfsPath.normalize(base)
    }

    const runLine = async (cmd: string) => {
      const trimmed = cmd.trim()
      if (trimmed) {
        history.push(trimmed)
        if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY)
      }
      histIdx = -1

      if (!trimmed) {
        term.write('\r\n')
        printPrompt()
        return
      }

      const tokens = trimmed.split(/\s+/)
      if (tokens[0] === 'cd') {
        const target = resolveCd(tokens[1] ?? '~')
        if (vfs.isDir(target)) {
          cwd = target
          bus.emit('terminal:cwd', { cwd })
          term.write('\r\n')
        } else {
          term.write(`\r\n\x1b[31mbash: cd: ${tokens[1]}: No such file or directory\x1b[0m\r\n`)
        }
        printPrompt()
        return
      }

      if (trimmed === 'clear') {
        term.clear()
        printPrompt()
        return
      }

      running = true
      try {
        const bashCwd = `${BASH_ROOT}${cwd === '/' ? '' : cwd}`
        const result = await shell.exec(trimmed, bashCwd)
        if (result.stdout) {
          term.write(result.stdout)
          if (!result.stdout.endsWith('\n')) term.write('\r\n')
        }
        if (result.stderr) {
          term.write(`\x1b[31m${result.stderr}\x1b[0m`)
          if (!result.stderr.endsWith('\n')) term.write('\r\n')
        }
        if (!result.stdout && !result.stderr && result.exitCode !== 0) {
          term.write(`\x1b[90m(exit ${result.exitCode})\x1b[0m\r\n`)
        }
      } catch (err) {
        term.write(`\x1b[31mshell error: ${err instanceof Error ? err.message : String(err)}\x1b[0m\r\n`)
      } finally {
        running = false
        printPrompt()
      }
    }

    const redrawLine = (next: string) => {
      line = next
      term.write(`\r\x1b[K${promptText()}${line}`)
    }

    term.onData((data) => {
      if (running) return
      for (let i = 0; i < data.length; i++) {
        const ch = data[i]
        // Arrow keys and similar escapes arrive as ESC [ letter
        if (ch === '\x1b' && data[i + 1] === '[') {
          const letter = data[i + 2]
          i += 2
          if (letter === 'A') {
            if (history.length === 0) continue
            histIdx = histIdx === -1 ? history.length - 1 : Math.max(0, histIdx - 1)
            redrawLine(history[histIdx])
          } else if (letter === 'B') {
            if (histIdx === -1) continue
            histIdx = histIdx + 1
            if (histIdx >= history.length) {
              histIdx = -1
              redrawLine('')
            } else {
              redrawLine(history[histIdx])
            }
          } else if (letter === 'C' || letter === 'D') {
            // horizontal cursor movement is not tracked in line mode
          } else if (letter === 'H' || letter === 'F') {
            redrawLine(letter === 'H' ? '' : line)
          }
          continue
        }
        if (ch === '\r' || ch === '\n') {
          const cmd = line
          line = ''
          term.write('\r\n')
          void runLine(cmd)
          continue
        }
        if (ch === '\x7f') {
          if (line.length > 0) {
            line = line.slice(0, -1)
            term.write('\b \b')
          }
          continue
        }
        if (ch === '\x03') {
          term.write('^C\r\n')
          line = ''
          printPrompt()
          continue
        }
        if (ch === '\x0c') {
          term.clear()
          redrawLine(line)
          continue
        }
        if (ch === '\x15') {
          redrawLine('')
          continue
        }
        if (ch === '\t') {
          continue // no completion yet — Phase 5
        }
        if (ch >= ' ') {
          line += ch
          term.write(ch)
        }
      }
    })

    term.write(
      '\x1b[90mCell shell — just-bash on the Cell VFS. Try: ls, cat src/index.ts, echo hi > note.txt\x1b[0m\r\n\r\n',
    )
    printPrompt()
    bus.emit('terminal:cwd', { cwd })

    const observer = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {
        // fit throws if the host is display:none — harmless
      }
    })
    observer.observe(host)

    teardown = () => {
      observer.disconnect()
      term.dispose()
    }
    }

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      teardown?.()
    }
  }, [])

  return <div ref={hostRef} className="terminal-host" />
}
