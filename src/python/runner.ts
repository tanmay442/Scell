/**
 * The python execution core — framework-agnostic: it receives a loaded
 * Pyodide instance and runs one script against it. Used by the web worker
 * (browser) and directly by the node-side tests, so both exercise the exact
 * same semantics: argv, env, cwd, stdin files, package loading from imports,
 * matplotlib output, and a filesystem write-back diff.
 */

/** Pure-Python wheels installed from the same-origin vendor dir instead
 * of PyPI: pinned bytes (hash-checked below), offline-capable, no CORS
 * or typosquat risk. Vendored by scripts/vendor-public.mjs into
 * public/vendor/wheels/ — PINNED THERE TOO (check-isolate-pure.sh fails
 * the build when the pins differ; see VENDOR_WHEEL_HASHES).
 *
 * Install order: pyodide index (CDN) → hash-verified vendor wheel.
 * Anything else is REFUSED (fail-closed): the runner never micropip-
 * installs an unreviewed PyPI name on its own — a prompt-injected
 * `import typosquat` stops here with a clear status line instead of
 * fetching attacker code. To enable more, vendor the wheel after review. */
export const VENDOR_WHEELS: Record<string, string> = {
  pypdf: 'pypdf-6.21.4-py3-none-any.whl',
  seaborn: 'seaborn-0.13.2-py3-none-any.whl',
}

/** Install one missing pure-Python package, same-origin first. Exported
 * for tests. Throws when every source fails. */
export async function installPureWheel(
  pyodide: { loadPackage(p: string): Promise<unknown>; runPythonAsync(code: string): Promise<unknown>; FS: { mkdirTree(p: string): void; writeFile(p: string, data: Uint8Array): void } },
  name: string,
  onStatus?: (text: string) => void,
  wheelBaseUrl = '/vendor/wheels',
): Promise<void> {
  const wheel = VENDOR_WHEELS[name]
  if (wheel === undefined) {
    // pyodide index only — never PyPI on our own authority. A
    // prompt-injected `import typosquat` dies here instead of fetching
    // attacker code: loadPackage throws for unknown names.
    try {
      await pyodide.loadPackage(name)
      return
    } catch {
      throw new Error(`pip: ${name} is not allowlisted for auto-install (see VENDOR_WHEELS) — ask for it to be vendored after review`)
    }
  }
  // vendor path: same-origin fetch, then hash-verify BEFORE touching
  // the bytes — a poisoned wheel is silent code execution otherwise.
  // No PyPI fallback, ever: allowlisted names install from pinned bytes
  // or fail loudly (fail-closed beats fail-online for reviewed code).
  // wheelBaseUrl exists for tests, which serve public/vendor over a
  // local HTTP server — production always uses same-origin /vendor.
  const res = await fetch(`${wheelBaseUrl}/${wheel}`)
  if (!res.ok) throw new Error(`vendored wheel HTTP ${res.status} for ${wheel} — run scripts/vendor-public.mjs`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer)
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  if (VENDOR_WHEEL_HASHES[wheel] === undefined || hex !== VENDOR_WHEEL_HASHES[wheel]) {
    throw new Error(`vendored wheel hash mismatch for ${wheel} — refusing to install`)
  }
  try {
    pyodide.FS.mkdirTree('/tmp/wheels')
  } catch {
    // exists
  }
  pyodide.FS.writeFile(`/tmp/wheels/${wheel}`, bytes)
  await installWheelMembers(pyodide, `/tmp/wheels/${wheel}`, wheel.split('-')[0].toLowerCase(), name)
}

/** Validate zip members and extract into site-packages. Exported for
 * tests: feed it hostile zips directly (the hash gate lives one layer
 * up in installPureWheel). Members outside the distribution dir /
 * dist-info, absolute paths, `..`, startup-execution files (*.pth,
 * sitecustomize, usercustomize) and symlinks are refused before anything
 * is written. Manual extraction, NOT micropip: micropip queries the PyPI
 * index even for local files (network), but a pure wheel is just a zip
 * whose allowlisted members belong in site-packages (fully offline). */
export async function installWheelMembers(
  pyodide: { runPythonAsync(code: string): Promise<unknown> },
  zipPath: string,
  dist: string,
  name: string,
): Promise<void> {
  await pyodide.runPythonAsync(
    `import zipfile as _zf, site as _site, importlib as _il, re as _re\n` +
      `_sp = [p for p in _site.getsitepackages() if p.endswith('site-packages')][0]\n` +
      `_z = _zf.ZipFile(${JSON.stringify(zipPath)})\n` +
      `_bad = []\n` +
      `for _m in _z.namelist():\n` +
      `    _n = _m.replace(chr(92), '/')\n` +
      `    _base = _n.rsplit('/', 1)[-1].lower()\n` +
      `    _top = _n.split('/')[0].lower().replace('_', '-')\n` +
      `    _ok_top = _top == ${JSON.stringify(dist)} or _re.match(r'^' + ${JSON.stringify(dist)} + r'(-[.\\w]+)?\\.(dist-info|egg-info)$', _top) is not None\n` +
      `    _evil = _base in ('sitecustomize.py', 'usercustomize.py') or _base.endswith('.pth')\n` +
      `    _info = _z.getinfo(_m)\n` +
      `    _is_link = (_info.external_attr >> 16) & 0o170000 == 0o120000\n` +
      `    if _n.startswith('/') or '..' in _n.split('/') or _evil or _is_link or not _ok_top:\n` +
      `        _bad.append(_m)\n` +
      `if _bad: raise ValueError('refusing wheel members: ' + ', '.join(_bad[:8]))\n` +
      `_z.extractall(_sp)\n` +
      `_il.invalidate_caches()\n` +
      `__import__(${JSON.stringify(name)})`,
  )
}

/** Vendored-wheel integrity pins. The SAME map lives in
 * scripts/vendor-public.mjs (PIN note there) — check-isolate-pure.sh
 * fails the build when they differ. Verified at download time (vendor
 * script) AND at install time (hash of the fetched bytes, below).
 * A poisoned wheel is the arbitrary-code-execution path into every
 * session, so both checks fail closed. */
export const VENDOR_WHEEL_HASHES: Record<string, string> = {
  'pypdf-6.21.4-py3-none-any.whl': '33e4fb41ca352810eb4e9838aa0d82d6888a5f8bf682f43e99cce5faa666255c',
  'seaborn-0.13.2-py3-none-any.whl': '636f8336facf092165e27924f223d3c62ca560b1f2bb5dff7ab7fad265361987',
}

export interface PythonPayload {
  buffer: Uint8Array
  // entries may carry kind 'dir' (empty dirs invisible to listAllFiles)
  index: [path: string, offset: number, length: number, kind?: 'file' | 'dir'][]
}

export interface PythonRunOptions {
  /** the python source to execute */
  code: string
  /** path of the script (sys.argv[0]); '-' when reading code from stdin/-c */
  entry: string
  argv: string[]
  cwd: string
  env: Record<string, string>
  payload: PythonPayload
  /** bytes for the program's stdin (echo data | python script.py); EOF when absent */
  stdin?: Uint8Array
  /** loading progress (package installs) */
  onStatus?: (text: string) => void
  onOut: (stream: 'stdout' | 'stderr', text: string) => void
  /** base URL for vendored wheels (tests serve public/vendor over HTTP;
   * production defaults to same-origin /vendor/wheels) */
  wheelBaseUrl?: string
}

export interface PythonWrittenFile {
  path: string
  bytes: Uint8Array
}

export interface PythonRunResult {
  exitCode: number
  written: PythonWrittenFile[]
  deleted: string[]
}

/** dirs of the pyodide filesystem that belong to the runtime, not the user.
 * Package installs and runtime side-effects land outside /home/user
 * (/share man pages, /etc, /opt, ...); without these entries the write-back
 * walk would sync them into the VFS as phantom workspace files. */
const FS_SKIP = new Set(['/lib', '/usr', '/dev', '/proc', '/sys', '/bin', '/home/pydide', '/python312.zip', '/.webpy', '/tmp', '/share', '/etc', '/opt', '/var', '/root'])

function inSkip(path: string): boolean {
  if (FS_SKIP.has(path)) return true
  for (const skip of FS_SKIP) {
    if (path.startsWith(`${skip}/`)) return true
  }
  return false
}

/** byte-exact compare — length alone silently drops same-length edits */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/** A python error surfaces as PythonError with the full traceback text. */
function describeError(err: unknown): { text: string; exitCode: number } {
  const raw = String((err as { message?: string })?.message ?? err)
  // SystemExit arrives inside the traceback, not as a typed error
  const match = /SystemExit:\s*(\d+)?/.exec(raw)
  if (match !== null) {
    const code = match[1] !== undefined ? Number.parseInt(match[1], 10) : 0
    return { text: '', exitCode: Number.isFinite(code) ? code : 0 }
  }
  // drop the pyodide-internal frames — agent-readable stderr
  const lines = raw.split('\n').filter((line) => !line.includes('/lib/python312.zip/_pyodide/'))
  return { text: lines.join('\n'), exitCode: 1 }
}

export async function runPython(pyodide: any, options: PythonRunOptions): Promise<PythonRunResult> {
  const { FS } = pyodide
  const { payload, cwd, env } = options

  // ---- filesystem in: the caller's snapshot ----
  for (const [path, offset, length, kind] of payload.index) {
    if (kind === 'dir') {
      // empty dirs are invisible to listAllFiles — materialize them
      // explicitly or open() into them fails even though the VFS has them
      try {
        FS.mkdirTree(path)
      } catch {
        // exists
      }
      continue
    }
    const dir = path.slice(0, path.lastIndexOf('/')) || '/'
    try {
      FS.mkdirTree(dir)
    } catch {
      // exists
    }
    FS.writeFile(path, payload.buffer.subarray(offset, offset + length))
  }
  try {
    FS.mkdirTree(cwd)
  } catch {
    // exists
  }
  // the artifacts convention: python visuals land in ~/artifacts (see UI
  // download affordances) — pre-create it so savefig never needs mkdir
  try {
    FS.mkdirTree('/home/user/artifacts')
  } catch {
    // exists
  }
  FS.chdir(cwd)

  // ---- environment: MPLBACKEND for headless plots, then the session's ----
  // update, never clear: pyodide presets HOME/MPLCONFIGDIR etc. that the
  // data-science stack depends on
  const mergedEnv: Record<string, string> = { MPLBACKEND: 'AGG', ...env }
  const envJson = JSON.stringify(mergedEnv)
  await pyodide.runPythonAsync(
    `import os, json as _json\nos.environ.update(_json.loads(${JSON.stringify(envJson)}))\ndel _json`,
  )

  // ---- streams ----
  pyodide.setStdout({ batched: (text: string) => options.onOut('stdout', `${text}\n`) })
  pyodide.setStderr({ batched: (text: string) => options.onOut('stderr', `${text}\n`) })

  // ---- stdin: piped bytes for the program (P0-7). just-bash hands us a
  // latin1 ByteString (one char per byte); the runner takes raw bytes so
  // `echo data | python script.py` reads `data` instead of silent EOF.
  // Absent stdin is explicit EOF — input()/read() return '' rather than
  // blocking the worker forever.
  const stdinBytes = options.stdin ?? new Uint8Array(0)
  let stdinCursor = 0
  try {
    // NB: no autoEOF here — pyodide only allows it with the byte-wise
    // `stdin` option, and passing it with `read` makes setStdin throw
    // (which left stdin at the blocking worker default and wedged runs).
    // With `read`, returning 0 is the EOF signal.
    pyodide.setStdin({
      error: false,
      isatty: false,
      read: (buffer: Uint8Array): number => {
        if (stdinCursor >= stdinBytes.length) return 0
        const n = Math.min(buffer.length, stdinBytes.length - stdinCursor)
        buffer.set(stdinBytes.subarray(stdinCursor, stdinCursor + n), 0)
        stdinCursor += n
        return n
      },
    })
  } catch {
    // older pyodide without setStdin.read — stdin stays EOF
  }

  // ---- argv + __file__ + script dir on sys.path (CPython semantics) ----
  const argv = [options.entry, ...options.argv]
  await pyodide.runPythonAsync(
    `import sys as _sys\n_sys.argv = ${JSON.stringify(argv)}\nimport os as _os\n_os.chdir(${JSON.stringify(cwd)})\nif ${JSON.stringify(cwd)} not in _sys.path: _sys.path.insert(0, ${JSON.stringify(cwd)})\nif ${JSON.stringify(options.entry !== '-' ? options.entry : cwd)} not in _sys.path: _sys.path.insert(0, ${JSON.stringify(options.entry !== '-' ? options.entry.slice(0, options.entry.lastIndexOf('/')) || '/' : cwd)})\ndel _sys, _os`,
  )

  // ---- packages: whatever the script imports that pyodide can provide ----
  let statusHandler: ((text: string) => void) | undefined = options.onStatus
  const prevLoadPackage = pyodide.loadedPackages
  try {
    await pyodide.loadPackagesFromImports(options.code, {
      messageCallback: (text: string) => statusHandler?.(text),
    })
  } catch (err) {
    options.onOut('stderr', `python: package resolution failed: ${describeError(err).text}\n`)
    return { exitCode: 1, written: [], deleted: [] }
  }
  const fresh = Object.keys(pyodide.loadedPackages ?? {}).filter((p) => !(prevLoadPackage ?? {})[p])
  for (const pkg of fresh) options.onStatus?.(`installed ${pkg}`)

  // pyodide ships only its curated set — anything else the script imports
  // that is pure-python gets installed from PyPI via micropip (best effort)
  try {
    // local files of the payload are importable (cwd + script dir are on
    // sys.path) — the scan checks the FS before declaring a module missing.
    // Only top-level names resolvable from those dirs suppress installs:
    // a nested sub/easy.py must NOT shadow a top-level `import easy`.
    const scriptDir = options.entry !== '-' ? options.entry.slice(0, options.entry.lastIndexOf('/')) || '/' : cwd
    const sysDirs = new Set([cwd, scriptDir])
    const localModules = new Set<string>()
    for (const [path] of payload.index) {
      if (!path.endsWith('.py')) continue
      const dir = path.slice(0, path.lastIndexOf('/'))
      const base = path.slice(path.lastIndexOf('/') + 1)
      if (base === '__init__.py') {
        // <sysdir>/X/__init__.py makes package X importable
        const parent = dir.slice(0, dir.lastIndexOf('/'))
        if (sysDirs.has(parent)) localModules.add(dir.slice(dir.lastIndexOf('/') + 1))
      } else if (sysDirs.has(dir)) {
        localModules.add(base.slice(0, -3))
      }
    }
    const missing = JSON.parse(
      (await pyodide.runPythonAsync(
        `import ast, importlib.util, json as _json, os as _os\n_missing = []\n_tree = ast.parse(${JSON.stringify(options.code)})\n_local = set(${JSON.stringify([...localModules])})\nfor _node in ast.walk(_tree):\n    if isinstance(_node, ast.Import):\n        for _a in _node.names:\n            _name = _a.name.split('.')[0]\n            if _name in _local or _name.startswith('.'):\n                continue\n            if importlib.util.find_spec(_name) is None and _name not in _missing:\n                _missing.append(_name)\n    elif isinstance(_node, ast.ImportFrom) and _node.module:\n        _name = _node.module.split('.')[0]\n        if _node.level == 0 and _name not in _local:\n            if importlib.util.find_spec(_name) is None and _name not in _missing:\n                _missing.append(_name)\n_json.dumps(_missing)`,
      )) as string,
    ) as string[]
    for (const name of missing) {
      options.onStatus?.(`pip installing ${name}…`)
      try {
        await installPureWheel(pyodide, name, options.onStatus, options.wheelBaseUrl)
        options.onStatus?.(`pip installed ${name}`)
      } catch (err) {
        options.onStatus?.(`pip: ${name} unavailable (${describeError(err).text.slice(0, 80)})`)
      }
    }
  } catch {
    // the ast scan itself must never fail the run
  }

  // ---- execute ----
  // SystemExit is caught at the Python level, inside __main__: letting it
  // propagate through pyodide's asyncio webloop re-raises it in a later
  // macrotask, which node reports as an unhandled rejection (red CI) and
  // browsers report as a page error. exec() keeps argv/env/cwd semantics
  // identical; compile() keeps tracebacks pointed at the real script path;
  // the eval+iscoroutine pair preserves top-level await.
  let exitCode = 0
  const filename = options.entry !== '-' ? options.entry : '<stdin>'
  try {
    await pyodide.runPythonAsync(
      [
        'import ast as __cell_ast, inspect as __cell_inspect',
        '__cell_exit_code = 0',
        '__cell_exit_msg = None',
        'try:',
        `    __cell_unit = eval(compile(${JSON.stringify(options.code)}, ${JSON.stringify(filename)}, 'exec', flags=__cell_ast.PyCF_ALLOW_TOP_LEVEL_AWAIT, dont_inherit=True))`,
        '    if __cell_inspect.iscoroutine(__cell_unit):',
        '        await __cell_unit',
        'except SystemExit as __cell_e:',
        '    __cell_code = __cell_e.code',
        '    if __cell_code is None:',
        '        __cell_exit_code = 0',
        '    elif isinstance(__cell_code, int):',
        '        __cell_exit_code = int(__cell_code)',
        '    elif isinstance(__cell_code, str):',
        '        __cell_exit_msg = __cell_code',
        '        __cell_exit_code = 1',
        '    else:',
        '        __cell_exit_code = 1',
      ].join('\n'),
    )
    const code = (await pyodide.runPythonAsync('__cell_exit_code')) as unknown
    exitCode = typeof code === 'number' ? code : 0
    if (exitCode !== 0) {
      const msg = (await pyodide.runPythonAsync('__cell_exit_msg')) as unknown
      if (typeof msg === 'string' && msg) options.onOut('stderr', `${msg}\n`)
    }
  } catch (err) {
    const described = describeError(err)
    if (described.text) options.onOut('stderr', `${described.text}\n`)
    exitCode = described.exitCode
  } finally {
    try {
      await pyodide.runPythonAsync(
        'try:\n    del __cell_exit_code, __cell_exit_msg\n    del __cell_unit, __cell_code\nexcept NameError:\n    pass',
      )
    } catch {
      // namespace hygiene must never fail the run
    }
  }

  // ---- filesystem out: diff against what came in. Walk the whole MEMFS
  // root and rely on the skip-list (runtime dirs + volatile /tmp): payload-
  // derived roots missed files created in brand-new top-level dirs, while
  // node_modules/.git never enter the payload and must never sync back.
  const input = new Map<string, { offset: number; length: number }>()
  for (const [path, offset, length, kind] of payload.index) {
    // dir entries exist only to materialize empty dirs — they are not
    // files, so they must not enter the delete-detection set
    if (kind !== 'dir') input.set(path, { offset, length })
  }
  const written: PythonWrittenFile[] = []
  const seen = new Set<string>()
  const shadowed = (path: string): boolean => path.includes('/node_modules/') || path.includes('/.git/')
  const walk = (dir: string) => {
    let names: string[]
    try {
      names = FS.readdir(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (name === '.' || name === '..') continue
      const full = dir === '/' ? `/${name}` : `${dir}/${name}`
      if (inSkip(full) || shadowed(full)) continue
      let stat: any
      try {
        stat = FS.stat(full)
      } catch {
        continue
      }
      if (FS.isDir(stat.mode)) {
        walk(full)
      } else {
        seen.add(full)
        const bytes: Uint8Array = FS.readFile(full)
        const prev = input.get(full)
        if (prev === undefined || !bytesEqual(payload.buffer.subarray(prev.offset, prev.offset + prev.length), bytes)) {
          written.push({ path: full, bytes: new Uint8Array(bytes) })
        }
      }
    }
  }
  walk('/')
  const deleted = [...input.keys()].filter((path) => !seen.has(path) && !shadowed(path))
  return { exitCode, written, deleted }
}
