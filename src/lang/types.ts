/** Mirrors the parts of ts-rust's Diagnostic (core.d.ts) that Cell uses. */
export interface TsRustPosition {
  line: number
  character: number
}

export interface TsRustDiagnostic {
  fileName?: string
  pos: number
  end: number
  startPosition?: TsRustPosition
  endPosition?: TsRustPosition
  code: number
  /** 0 warning, 1 error, 2 suggestion, 3 message */
  category: 0 | 1 | 2 | 3
  source?: string
  text: string
}
