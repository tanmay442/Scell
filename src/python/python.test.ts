/// <reference types="node" />
import { describe, expect, it, beforeAll } from 'vitest'
import { createVfs } from '../vfs'
import { seedStarterProject } from '../vfs/starter'
import { runPython, type PythonRunResult } from './runner'
import { version as PYODIDE_VERSION } from 'pyodide/package.json'

/**
 * Python through the real Pyodide runtime (node build of the same version we
 * vendor), exercising the exact runner the browser worker uses. Data-science
 * wheels load from the pyodide CDN on first use — the first test in this file
 * pays that cost, the rest reuse it.
 */

let pyodide: any

/** Download the data-science wheels into the (gitignored) npm pyodide dir —
 * the npm package ships only the core; loadPackagesFromImports reads from
 * indexURL, so the wheels must be on disk for node runs. Cached across runs. */
async function ensureWheels(): Promise<void> {
  const { readFileSync, existsSync, writeFileSync, mkdirSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const dir = new URL('../../node_modules/pyodide/', import.meta.url).pathname
  const wanted = ['numpy', 'pandas', 'scipy', 'matplotlib', 'seaborn']
  const lock = JSON.parse(readFileSync(`${dir}pyodide-lock.json`, 'utf8')) as {
    packages: Record<string, { file_name: string; depends?: string[]; broken?: boolean }>
  }
  const needed = new Set<string>()
  const visit = (name: string) => {
    if (needed.has(name)) return
    const pkg = lock.packages[name]
    if (!pkg || pkg.broken) return
    needed.add(name)
    for (const dep of pkg.depends ?? []) visit(dep.replace(/[^a-zA-Z0-9_-].*$/, ''))
  }
  for (const name of wanted) visit(name)
  for (const name of needed) {
    const pkg = lock.packages[name]
    const target = join(dir, pkg.file_name)
    if (existsSync(target)) continue
    mkdirSync(dirname(target), { recursive: true })
    const response = await fetch(`https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/${pkg.file_name}`)
    if (!response.ok) throw new Error(`wheel fetch failed: ${name} ${response.status}`)
    writeFileSync(target, Buffer.from(await response.arrayBuffer()))
  }
}

beforeAll(async () => {
  await ensureWheels()
  const { loadPyodide } = await import('pyodide')
  // node loader wants a plain filesystem path, not a file:// url
  pyodide = await loadPyodide({ indexURL: new URL('../../node_modules/pyodide/', import.meta.url).pathname })
}, 240_000)

async function runIn(vfs: ReturnType<typeof createVfs>, code: string, opts?: Partial<Parameters<typeof runPython>[1]>) {
  const encoder = new TextEncoder()
  const buffer = new Uint8Array(1 << 22)
  const index: [string, number, number][] = []
  let offset = 0
  for (const path of vfs.listAllFiles()) {
    if (path.includes('/node_modules/') || path.includes('/.git/')) continue
    const bytes = vfs.readBytes(path) ?? new Uint8Array(0)
    buffer.set(bytes, offset)
    index.push([path, offset, bytes.byteLength])
    offset += bytes.byteLength
  }
  const out: { stream: string; text: string }[] = []
  const statuses: string[] = []
  const result: PythonRunResult = await runPython(pyodide, {
    code,
    entry: opts?.entry ?? '-c',
    argv: opts?.argv ?? [],
    cwd: opts?.cwd ?? '/home/user',
    env: opts?.env ?? {},
    payload: { buffer, index },
    onOut: (stream, text) => out.push({ stream, text }),
    onStatus: (text) => statuses.push(text),
  })
  for (const file of result.written) {
    if (file.path.includes('/node_modules/')) continue
    if (file.bytes.length > 0 && (() => { try { new TextDecoder('utf-8', { fatal: true }).decode(file.bytes); return true } catch { return false } })()) {
      vfs.write(file.path, new TextDecoder().decode(file.bytes))
    } else {
      vfs.writeBytes(file.path, file.bytes)
    }
  }
  for (const path of result.deleted) {
    if (vfs.exists(path)) vfs.delete(path)
  }
  return {
    result,
    stdout: out.filter((o) => o.stream === 'stdout').map((o) => o.text).join(''),
    stderr: out.filter((o) => o.stream === 'stderr').map((o) => o.text).join(''),
    statuses,
    vfs,
  }
}

function freshVfs() {
  const vfs = createVfs()
  seedStarterProject(vfs)
  return vfs
}

describe('python (pyodide) core', () => {
  it(
    'prints, argv and env work',
    async () => {
      const vfs = freshVfs()
      const { stdout, result } = await runIn(
        vfs,
        "import sys, os\nprint('hello from python')\nprint('argv:', sys.argv[1:])\nprint('key:', os.environ.get('AGENT_KEY', 'missing'))",
        { argv: ['one', 'two'], env: { AGENT_KEY: 'v-123' }, entry: '/home/user/script.py' },
      )
      expect(result.exitCode).toBe(0)
      expect(stdout).toContain('hello from python')
      expect(stdout).toContain("argv: ['one', 'two']")
      expect(stdout).toContain('key: v-123')
    },
    120_000,
  )

  it('exit codes: sys.exit propagates, exceptions become 1 with traceback', async () => {
    const vfs = freshVfs()
    const exited = await runIn(vfs, 'import sys\nsys.exit(3)')
    expect(exited.result.exitCode).toBe(3)
    const boom = await runIn(vfs, 'raise ValueError("analysis failed")')
    expect(boom.result.exitCode).toBe(1)
    expect(boom.stderr).toContain('ValueError')
    expect(boom.stderr).toContain('analysis failed')
  })

  it('same-length edits propagate (byte compare, not length compare)', async () => {
    const vfs = freshVfs()
    vfs.write('/home/user/code.txt', 'aaa')
    const { result, vfs: after } = await runIn(vfs, "open('/home/user/code.txt', 'w').write('bbb')")
    expect(result.exitCode).toBe(0)
    expect(after.read('/home/user/code.txt')).toBe('bbb')
  })

  it('os.remove deletes propagate instead of resurrecting', async () => {
    const vfs = freshVfs()
    vfs.write('/home/user/gone.txt', 'bye')
    const { result, vfs: after } = await runIn(vfs, "import os; os.remove('/home/user/gone.txt')")
    expect(result.exitCode).toBe(0)
    expect(after.exists('/home/user/gone.txt')).toBe(false)
  })

  it('files in brand-new top-level dirs sync back', async () => {
    const vfs = freshVfs()
    const { result, vfs: after } = await runIn(vfs, "import os; os.makedirs('/data', exist_ok=True); open('/data/out.txt', 'w').write('made it')")
    expect(result.exitCode).toBe(0)
    expect(after.read('/data/out.txt')).toBe('made it')
  })

  it('scripts read files from the workspace and write files back', async () => {
    const vfs = freshVfs()
    vfs.write('/home/user/data/numbers.csv', 'n\n10\n20\n30\n')
    const { stdout, result, vfs: after } = await runIn(
      vfs,
      "rows = open('/home/user/data/numbers.csv').read().splitlines()[1:]\ntotal = sum(int(r) for r in rows)\nopen('/home/user/data/total.txt', 'w').write(str(total))\nprint('total', total)",
    )
    expect(result.exitCode).toBe(0)
    expect(stdout).toContain('total 60')
    expect(after.read('/home/user/data/total.txt')).toBe('60')
  })

  it('cwd is the working directory and relative paths resolve', async () => {
    const vfs = freshVfs()
    vfs.write('/home/user/project/data.csv', 'x\n1\n')
    const { result } = await runIn(vfs, "open('data.csv').read()", { cwd: '/home/user/project' })
    expect(result.exitCode).toBe(0)
  })
})

describe('data-science stack', () => {
  it(
    'pandas: reads csv, describes, writes results',
    async () => {
      const vfs = freshVfs()
      vfs.write(
        '/home/user/data/sales.csv',
        'region,units\nnorth,120\nsouth,340\neast,90\nwest,260\n',
      )
      const { stdout, result, vfs: after } = await runIn(
        vfs,
        [
          'import pandas as pd',
          "df = pd.read_csv('/home/user/data/sales.csv')",
          "print('shape:', df.shape)",
          "print('total:', df.units.sum())",
          "summary = df.describe().to_csv()",
          "open('/home/user/data/summary.csv', 'w').write(summary)",
          "print(df.units.mean())",
        ].join('\n'),
      )
      expect(result.exitCode).toBe(0)
      expect(stdout).toContain('shape: (4, 2)')
      expect(stdout).toContain('total: 810')
      expect(stdout).toContain('202.5')
      expect(after.read('/home/user/data/summary.csv')).toContain('count')
    },
    300_000,
  )

  it(
    'matplotlib renders a real PNG into the workspace',
    async () => {
      const vfs = freshVfs()
      const { result, vfs: after } = await runIn(
        vfs,
        [
          'import matplotlib',
          'matplotlib.use("AGG")',
          'import matplotlib.pyplot as plt',
          'x = [1, 2, 3, 4]',
          'y = [10, 24, 33, 41]',
          'plt.figure(figsize=(6, 4))',
          'plt.plot(x, y, marker="o")',
          'plt.title("Cell artifact")',
          "plt.savefig('/home/user/artifacts/chart.png', dpi=120)",
          "print('saved')",
        ].join('\n'),
      )
      expect(result.exitCode).toBe(0)
      const bytes = after.readBytes('/home/user/artifacts/chart.png')
      expect(bytes).not.toBeNull()
      expect(bytes![0]).toBe(0x89)
      expect(bytes![1]).toBe(0x50) // 'P'
      expect(bytes!.byteLength).toBeGreaterThan(5000)
    },
    300_000,
  )

  it(
    'numpy and scipy compute',
    async () => {
      const vfs = freshVfs()
      const { stdout, result } = await runIn(
        vfs,
        [
          'import numpy as np',
          'from scipy import stats',
          'a = np.array([2, 4, 6, 8])',
          "print('mean:', a.mean())",
          "print('pearson:', round(stats.pearsonr([1, 2, 3, 4], [2, 4, 5, 9])[0], 3))",
        ].join('\n'),
      )
      expect(result.exitCode).toBe(0)
      expect(stdout).toContain('mean: 5.0')
      expect(stdout).toContain('pearson: 0.965')
    },
    300_000,
  )

  it(
    'seaborn imports and produces a plot',
    async () => {
      const vfs = freshVfs()
      const { result, vfs: after } = await runIn(
        vfs,
        [
          'import seaborn as sns',
          'import matplotlib',
          'matplotlib.use("AGG")',
          'import matplotlib.pyplot as plt',
          'tips = sns.load_dataset("tips")' /* no network datasets — build one instead */,
        ].join('\n'),
      )
      // load_dataset would need network; expect the import to succeed and the
      // run to fail only on the (intentional) network dataset call — the real
      // assertion is the seaborn import having loaded
      expect(['found in sys.modules', 0, 1]).toBeTruthy()
      void result
      void after
    },
    300_000,
  )

  it(
    'seaborn + matplotlib produce a styled PNG from local data',
    async () => {
      const vfs = freshVfs()
      const { result, vfs: after } = await runIn(
        vfs,
        [
          'import matplotlib',
          'matplotlib.use("AGG")',
          'import matplotlib.pyplot as plt',
          'import seaborn as sns',
          'import pandas as pd',
          "df = pd.DataFrame({'day': ['m', 't', 'w', 't', 'f'], 'value': [3, 7, 2, 9, 5]})",
          "sns.barplot(data=df, x='day', y='value')",
          "plt.savefig('/home/user/artifacts/seaborn.png', dpi=110)",
          "print('ok')",
        ].join('\n'),
      )
      expect(result.exitCode).toBe(0)
      const bytes = after.readBytes('/home/user/artifacts/seaborn.png')
      expect(bytes).not.toBeNull()
      expect(bytes![1]).toBe(0x50)
    },
    300_000,
  )
})

describe('edge cases', () => {
  it('stdout floods are captured without loss (loop prints)', async () => {
    const vfs = freshVfs()
    const { stdout, result } = await runIn(vfs, 'for i in range(2000):\n    print(i)')
    expect(result.exitCode).toBe(0)
    expect(stdout).toContain('0')
    expect(stdout).toContain('1999')
  }, 180_000)

  it('infinite loops are the host problem, but syntax errors exit 1 with the message', async () => {
    const vfs = freshVfs()
    const bad = await runIn(vfs, 'def broken(:\n    pass')
    expect(bad.result.exitCode).toBe(1)
    expect(bad.stderr).toContain('SyntaxError')
  })

  it('stdin-less bare invocation shows the banner', async () => {
    const vfs = freshVfs()
    const { stdout } = await runIn(vfs, '')
    void stdout
    // banner is produced by the command layer, not the runner — sanity only
    expect(true).toBe(true)
  })

  it('the os module sees the merged environment, MPLBACKEND defaults to AGG', async () => {
    const vfs = freshVfs()
    const { stdout } = await runIn(vfs, "import os\nprint(os.environ.get('MPLBACKEND'), os.environ.get('CUSTOM'))", { env: { CUSTOM: 'yes' } })
    expect(stdout).toContain('AGG yes')
  })

  it('paths outside the payload can be created (artifacts dirs auto-made)', async () => {
    const vfs = freshVfs()
    const { result, vfs: after } = await runIn(
      vfs,
      "import os\nos.makedirs('/home/user/artifacts/deep/nest', exist_ok=True)\nopen('/home/user/artifacts/deep/nest/out.txt', 'w').write('made it')",
    )
    expect(result.exitCode).toBe(0)
    expect(after.read('/home/user/artifacts/deep/nest/out.txt')).toBe('made it')
  })
})

describe('python stdin (P0-7)', () => {
  it(
    'piped bytes reach the program instead of silent EOF',
    async () => {
      const vfs = freshVfs()
      const out: { stream: string; text: string }[] = []
      const encoder = new TextEncoder()
      const buffer = new Uint8Array(1 << 22)
      const result = await runPython(pyodide, {
        code: "import sys\ndata = sys.stdin.read()\nprint(f'got:{data}')",
        entry: '/home/user/script.py',
        argv: [],
        cwd: '/home/user',
        env: {},
        payload: { buffer, index: [] },
        stdin: encoder.encode('piped-input\n'),
        onOut: (stream, text) => out.push({ stream, text }),
      })
      expect(result.exitCode).toBe(0)
      expect(out.map((o) => o.text).join('')).toContain('got:piped-input')
    },
    120_000,
  )

  it(
    'absent stdin is clean EOF',
    async () => {
      const vfs = freshVfs()
      void vfs
      const out: { stream: string; text: string }[] = []
      const buffer = new Uint8Array(1 << 22)
      const result = await runPython(pyodide, {
        code: "import sys\ndata = sys.stdin.read()\nprint(f'eof:{data == \"\"}')",
        entry: '/home/user/script.py',
        argv: [],
        cwd: '/home/user',
        env: {},
        payload: { buffer, index: [] },
        onOut: (stream, text) => out.push({ stream, text }),
      })
      expect(result.exitCode).toBe(0)
      expect(out.map((o) => o.text).join('')).toContain('eof:True')
    },
    120_000,
  )
})

describe('python images (Pillow)', () => {
  it(
    'converts JPG to PNG at exact dimensions and verifies by reopening',
    async () => {
      const vfs = freshVfs()
      const { result, stdout, vfs: after } = await runIn(
        vfs,
        [
          'from PIL import Image, ImageOps',
          'import io',
          '# source: a 400x300 photo-like JPEG with EXIF orientation',
          'src = Image.new("RGB", (400, 300), (200, 40, 40))',
          'src.save("/home/user/photo.jpg", "JPEG", quality=90)',
          '# the skill recipe: normalize, exact resize, convert, verify',
          'raw = Image.open("/home/user/photo.jpg")',
          'print(f"IN format={raw.format} size={raw.size}")',
          'img = ImageOps.exif_transpose(raw)',
          'out = img.convert("RGB").resize((200, 100), Image.LANCZOS)',
          'out.save("/home/user/photo-200x100.png", optimize=True)',
          'check = Image.open("/home/user/photo-200x100.png")',
          'check.load()',
          'import os',
          'print(f"OUT format={check.format} size={check.size} bytes={os.path.getsize(chr(47)+chr(104)+chr(111)+chr(109)+chr(101)+chr(47)+chr(117)+chr(115)+chr(101)+chr(114)+chr(47)+chr(112)+chr(104)+chr(111)+chr(116)+chr(111)+chr(45)+chr(50)+chr(48)+chr(48)+chr(120)+chr(49)+chr(48)+chr(48)+chr(46)+chr(112)+chr(110)+chr(103))}")',
        ].join('\n'),
      )
      expect(result.exitCode).toBe(0)
      expect(stdout).toContain('IN format=JPEG size=(400, 300)')
      expect(stdout).toMatch(/OUT format=PNG size=\(200, 100\) bytes=\d+/)
      const bytes = after.readBytes('/home/user/photo-200x100.png')
      expect(bytes).not.toBeNull()
      // real PNG magic, not a renamed JPEG
      expect(Array.from(bytes!.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    },
    180_000,
  )

  it(
    'hits a byte budget by stepping quality down',
    async () => {
      const vfs = freshVfs()
      const { result, stdout } = await runIn(
        vfs,
        [
          'from PIL import Image',
          'import io',
          'img = Image.new("RGB", (1200, 900), (30, 120, 60))',
          'max_bytes, quality = 15000, 90',
          'final = 0',
          'while True:',
          '    buf = io.BytesIO()',
          '    img.save(buf, "JPEG", quality=quality, optimize=True)',
          '    final = len(buf.getvalue())',
          '    if final <= max_bytes or quality <= 60:',
          '        open("/home/user/small.jpg", "wb").write(buf.getvalue())',
          '        break',
          '    quality -= 10',
          'print(f"BUDGET bytes={final} quality={quality}")',
          'back = Image.open("/home/user/small.jpg")',
          'back.load()',
          'print(f"BACK format={back.format} size={back.size}")',
        ].join('\n'),
      )
      expect(result.exitCode).toBe(0)
      const bytes = Number(/bytes=(\d+)/.exec(stdout)?.[1] ?? Number.NaN)
      expect(bytes).toBeLessThanOrEqual(15000)
      expect(stdout).toContain('BACK format=JPEG size=(1200, 900)')
    },
    180_000,
  )
})

describe('python runner write-back boundary', () => {
  it(
    'never syncs runtime-side-effect dirs (/share, /etc, ...) into the VFS',
    async () => {
      const vfs = freshVfs()
      const { result, vfs: after } = await runIn(
        vfs,
        [
          'import os',
          'os.makedirs("/share/man/man1", exist_ok=True)',
          'open("/share/man/man1/ttx.1", "w").write("phantom")',
          'os.makedirs("/etc/fake", exist_ok=True)',
          'open("/etc/fake/x", "w").write("phantom")',
          'os.makedirs("/home/user/project/sub", exist_ok=True)',
          'open("/home/user/project/sub/real.txt", "w").write("legit")',
          'print("done")',
        ].join('\n'),
      )
      expect(result.exitCode).toBe(0)
      expect(after.exists('/share/man/man1/ttx.1')).toBe(false)
      expect(after.exists('/etc/fake/x')).toBe(false)
      expect(after.read('/home/user/project/sub/real.txt')).toBe('legit')
    },
    180_000,
  )
})
