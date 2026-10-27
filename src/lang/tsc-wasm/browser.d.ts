/** Type surface of the vendored ts-rust browser entry (see browser.js). */
import type { Diagnostic, WasmModule } from './core.d.ts'

export type { Diagnostic, WasmModule } from './core.d.ts'
export { memoryFileSystem, runTsc, runTscAsync } from './core.d.ts'

export interface TscOptions {
  files?: Map<string, string> | Record<string, string>
  cwd?: string
  diagnostics?: 'text' | 'json'
  env?: Record<string, string | undefined>
  tty?: boolean
  stream?: boolean
  stackSizeMb?: number
  wasm?: string | URL | Response | ArrayBuffer | ArrayBufferView | WasmModule
}

export interface TscResult {
  exitCode: number
  stdout: string
  stderr: string
  diagnostics?: Diagnostic[]
  files?: Map<string, string>
}

export declare function tsc(args: string[], options?: TscOptions): Promise<TscResult>
export declare function loadModule(source?: TscOptions['wasm']): Promise<WasmModule>
