import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { platform } from '../platform'
import { createShell, type Shell } from '../shell/shell'
import type { ToolCall } from '../shell/commands/agent-tools'
import { SYS_PREFIXES } from '../shell/vfs-fs'
import { vfsPath } from '../vfs/types'

const MAX_HISTORY = 200
const HOME = '/home/user'

/** Prompt label: '~' for home, relative path below it, absolute otherwise. */
function cwdLabel(cwd: string): string {
  if (cwd === HOME) return '~'
  if (cwd.startsWith(`${HOME}/`)) return `~${cwd.slice(HOME.length)}`
  return cwd
}

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

    const term = new Terminal({
      fontFamily: "'Cascadia Code', 'JetBrains Mono', Consolas, ui-monospace, monospace",
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 10000,
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

    // --- agent approval gate -------------------------------------------------
    // `cell agent` in this terminal pauses on every 'ask' tool call and
    // asks HERE, as a line prompt, so Enter is the confirmation (one stray
    // keystroke cannot approve). Approvals queue FIFO; jobs do not come
    // through this handler (their job_start was already gated).
    let liveSuspended = false
    let approvalAnswer = ''
    const approvalQueue: { summary: string; resolve: (allowed: boolean) => void }[] = []
    const summarizeCall = (call: ToolCall): string => {
      if (call.name === 'bash' || call.name === 'job_start') return String(call.input.command ?? '')
      if (call.name === 'write') return `${call.input.path} — ${String(call.input.content ?? '').slice(0, 200)}`
      if (call.name === 'edit') return `${call.input.path} — replace ${String(call.input.oldText ?? '').slice(0, 80)}…`
      if (call.input.path !== undefined) return String(call.input.path)
      return JSON.stringify(call.input).slice(0, 140)
    }
    const showApproval = () => {
      const head = approvalQueue[0]
      if (!head) return
      liveSuspended = true
      approvalAnswer = ''
      typeahead = ''
      term.write(`\r\x1b[K\x1b[33mApprove ${head.summary}? [y/N] \x1b[0m`)
    }
    const settleApproval = (allowed: boolean) => {
      const head = approvalQueue.shift()
      head?.resolve(allowed)
      if (approvalQueue.length > 0) showApproval()
      else {
        liveSuspended = false
        if (running) term.write('\r\n')
        else redrawLine(line)
      }
    }
    const askApproval = (call: ToolCall): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        approvalQueue.push({ summary: `${call.name} ${summarizeCall(call)}`, resolve })
        if (approvalQueue.length === 1) showApproval()
      })

    const shell: Shell = createShell(vfs, { approve: askApproval })

    let cwd = HOME
    let line = ''
    let history: string[] = []
    let histIdx = -1
    let running = false
    let typeahead = ''

    const promptText = () => `\x1b[36m${cwdLabel(cwd)}\x1b[0m $ `
    const printPrompt = () => term.write(promptText())
    /**
     * xterm is a raw terminal: a bare LF moves down but keeps the column,
     * which staircases the output. A PTY would translate (ONLCR); we are the
     * PTY, so normalize every newline-bearing write to CRLF.
     */
    const writeOut = (s: string) => {
      if (!s) return
      const norm = s.replace(/\r?\n/g, '\r\n')
      term.write(norm)
      if (!norm.endsWith('\r\n')) term.write('\r\n')
    }
    const writeErr = (s: string) => writeOut(`\x1b[31m${s.replace(/\r?\n/g, '\r\n')}\x1b[0m`)

    const resolveCd = (target: string): string => {
      if (target === '' || target === '~') return HOME
      if (target === '/') return '/'
      const base = target.startsWith('/') ? target : target.startsWith('~/') ? `${HOME}/${target.slice(2)}` : `${cwd}/${target}`
      return vfsPath.normalize(base)
    }

    // heredoc continuation (PS2): `cat > f <<EOF` collects lines until the
    // delimiter, then runs the whole thing as one script — like a real
    // terminal, where each interactive line is parsed in order
    let heredoc: { delim: string; head: string; lines: string[] } | null = null
    let previousCwd: string | null = null

    let runChain: Promise<void> = Promise.resolve()
    const runLine = (cmd: string, fromHeredoc = false): Promise<void> => {
      const task = runChain.then(() => runLineInner(cmd, fromHeredoc))
      runChain = task.catch(() => {})
      return task
    }
    const runLineInner = async (cmd: string, fromHeredoc = false) => {
      if (heredoc !== null) {
        if (cmd.trim() === heredoc.delim) {
          // keep the head exactly as typed: a quoted delimiter (<<'EOF')
          // means NO expansion in the body, and stripping the quotes
          // corrupted $ in written files. just-bash parses quoted
          // heredocs fine (bash-audit pins it); close with the delimiter.
          const script = [heredoc.head, ...heredoc.lines, heredoc.delim].join('\n')
          heredoc = null
          await runLineInner(script, true)
        } else {
          heredoc.lines.push(cmd)
          term.write('\r\n')
          printPrompt()
        }
        return
      }
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
      // only a BARE cd is intercepted — `cd x && build` must run in the shell
      if (tokens[0] === 'cd' && !/(&|\|\||;)/.test(trimmed)) {
        // quote-aware target: cd "my dir" works like a real shell
        let target = '~'
        const rest = trimmed.slice(2).trim()
        if (rest !== '') {
          if (rest.length >= 2 && rest.startsWith('"') && rest.endsWith('"')) {
            target = rest.slice(1, -1).replace(/\\(.)/g, '$1')
          } else if (rest.length >= 2 && rest.startsWith("'") && rest.endsWith("'")) {
            target = rest.slice(1, -1)
          } else {
            target = rest.split(/\s+/)[0]
          }
        }
        if (target === '-') {
          const previous = previousCwd
          if (previous === null) {
            writeErr('bash: cd: OLDPWD not set\n')
            printPrompt()
            return
          }
          previousCwd = cwd
          cwd = previous
          bus.emit('terminal:cwd', { cwd })
          term.write(`\r\n${cwdLabel(cwd)}\r\n`)
          printPrompt()
          return
        }
        const resolved = resolveCd(target)
        if (vfs.isDir(resolved)) {
          previousCwd = cwd
          cwd = resolved
          bus.emit('terminal:cwd', { cwd })
          term.write('\r\n')
        } else {
          writeErr(`bash: cd: ${target}: No such file or directory\n`)
        }
        printPrompt()
        return
      }

      if (trimmed === 'clear') {
        term.clear()
        printPrompt()
        return
      }

      // a heredoc-assembled script contains its own <<DELIM — only fresh
      // interactive lines may open a new one
      // strip quoted segments first — `echo "use <<EOF here"` must not wedge
      // the terminal in heredoc mode
      const heredocMatch = fromHeredoc
        ? null
        : /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(trimmed.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, (m) => ' '.repeat(m.length)))
      if (heredocMatch !== null && !heredocMatch[0].includes('<<<')) {
        heredoc = { delim: heredocMatch[2], head: cmd, lines: [] }
        term.write('\r\n')
        printPrompt()
        return
      }

      running = true
      // Long commands (git clone, npm install, python analysis) used to sit
      // silent until they finished. Now the terminal keeps one live line:
      // real progress phases from the command when it reports them, else a
      // spinner with the elapsed time. The line is cleared before any real
      // output, so scrollback and row-based tooling never see it.
      const startedAt = Date.now()
      const shortCmd = trimmed.length > 48 ? `${trimmed.slice(0, 47)}…` : trimmed
      const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
      let frame = 0
      let liveLabel: string | null = null
      let liveShown = false
      let finished = false
      const renderLive = () => {
        if (liveSuspended) return
        const elapsed = Math.floor((Date.now() - startedAt) / 1000)
        term.write(`\r\x1b[K\x1b[90m${frames[frame++ % frames.length]} ${liveLabel ?? `running ${shortCmd}`} (${elapsed}s)\x1b[0m`)
        liveShown = true
      }
      const liveTimer = window.setInterval(() => {
        if (!finished && Date.now() - startedAt >= 1500) renderLive()
      }, 250)
      const clearLive = () => {
        finished = true
        window.clearInterval(liveTimer)
        if (liveShown) {
          term.write('\r\x1b[K')
          liveShown = false
        }
      }
      try {
        const result = await shell.exec(trimmed, cwd, (line) => {
          if (finished) return
          liveLabel = line
          renderLive()
        }, /(^|&&|\|\||;)\s*cell\s+agent\b/.test(trimmed) ? { timeoutMs: 600_000 } : undefined)
        clearLive()
        // compound commands can move the shell (cd x && build): the dump
        // epilogue reports the final cwd — sync the prompt from it
        if (result.cwd !== undefined && result.cwd !== cwd && (vfs.isDir(result.cwd) || SYS_PREFIXES.some((prefix) => result.cwd === prefix || result.cwd!.startsWith(`${prefix}/`)))) {
          previousCwd = cwd
          cwd = result.cwd
          bus.emit('terminal:cwd', { cwd })
        }
        if (result.stdout) writeOut(result.stdout)
        if (result.stderr) writeErr(result.stderr)
        if (!result.stdout && !result.stderr && result.exitCode !== 0) {
          term.write(`\x1b[90m(exit ${result.exitCode})\x1b[0m\r\n`)
        }
      } catch (err) {
        clearLive()
        writeErr(`shell error: ${err instanceof Error ? err.message : String(err)}\n`)
      } finally {
        running = false
        printPrompt()
        if (typeahead !== '') {
          const pendingInput = typeahead
          typeahead = ''
          handleData(pendingInput)
        }
      }
    }

    const redrawLine = (next: string) => {
      line = next
      term.write(`\r\x1b[K${promptText()}${line}`)
    }

    const handleData = (data: string) => {
      // approval prompt owns the keyboard while it is open — checked
      // per character, so a pasted `y\nls\n` settles the approval and
      // the remainder flows into normal line handling
      if (approvalQueue.length > 0) {
        let index = 0
        for (; index < data.length; index++) {
          const ch = data[index]
          if (ch === '\r' || ch === '\n') {
            const answer = approvalAnswer.trim().toLowerCase()
            settleApproval(answer === 'y' || answer === 'yes')
          } else if (ch === '\x03') {
            settleApproval(false)
          } else if (ch === '\x7f') {
            if (approvalAnswer.length > 0) {
              approvalAnswer = approvalAnswer.slice(0, -1)
              term.write('\b \b')
            }
          } else if (ch >= ' ') {
            approvalAnswer += ch
            term.write(ch)
          }
          if (approvalQueue.length === 0) {
            index++
            break
          }
        }
        const rest = data.slice(index)
        if (rest === '') return
        if (approvalQueue.length > 0) return
        handleData(rest)
        return
      }
      // while a command runs, keystrokes are buffered (capped) and
      // replayed at the next prompt instead of being dropped; Ctrl-C
      // clears the buffer. Approvals wipe it on open (see showApproval).
      if (running) {
        for (const ch of data) {
          if (ch === '\x03') typeahead = ''
          else if (typeahead.length < 4096) typeahead += ch
        }
        return
      }
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
    }
    term.onData(handleData)

    term.write(
      '\x1b[90mCell shell — just-bash on the Cell VFS. You are in ~ (a full home directory).\x1b[0m\r\n\x1b[90mTry: ls, cd project, node src/index.ts, git init, npm install ms\x1b[0m\r\n\r\n',
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
      for (const entry of approvalQueue.splice(0)) entry.resolve(false)
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

  return <div ref={hostRef} className="terminal-host" role="log" aria-label="terminal" />
}
