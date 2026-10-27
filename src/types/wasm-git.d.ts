/** Type surface for wasm-git's Asyncify build (libgit2 → WASM). */
declare module 'wasm-git/lg2_async.js' {
  export interface WasmGitFS {
    mkdir(path: string): void
    mkdirTree(path: string): void
    writeFile(path: string, data: string | Uint8Array): void
    readFile(path: string): Uint8Array
    readdir(path: string): string[]
    stat(path: string): { isDirectory?: () => boolean; mode?: number }
    unlink(path: string): void
    rmdir(path: string): void
    chdir(path: string): void
    analyzePath(path: string): { exists: boolean }
  }

  export interface WasmGitModule {
    FS: WasmGitFS
    /** Asyncify build: resolves with the exit code; nonzero exits reject */
    callMain(args: string[]): Promise<number | undefined>
    /** convenience wrapper that captures stdout and throws "code: stderr" */
    callWithOutput(args: string[]): Promise<string>
  }

  const initGit: (config?: {
    locateFile?: (path: string, scriptDirectory: string) => string
    print?: (text: string) => void
    printErr?: (text: string) => void
    [key: string]: unknown
  }) => Promise<WasmGitModule>

  export default initGit
}
