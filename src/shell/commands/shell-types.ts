/**
 * Shell and command types shared by the browser shell (just-bash over
 * the VFS) and the server shell (real bash over a workspace directory).
 * Kept in a leaf module with no imports so headless builds can use the
 * types without dragging in either shell implementation.
 */
export interface CommandResult {
  stdout: string
  stderr: string
  exitCode: number
  /** the run exceeded its time budget (exit 124); output is partial */
  timedOut?: boolean
  /** the run died or was capped under memory pressure; output may be partial */
  oomSuspected?: boolean
}

export interface ShellLike {
  exec(cmd: string, cwd?: string, onProgress?: (line: string) => void, opts?: { timeoutMs?: number }): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut?: boolean }>
}
