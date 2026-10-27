import { Braces, FileCode2, FileText, File as FileIconGeneric, Palette, FileType2 } from 'lucide-react'
import { vfsPath } from '../vfs/types'

const BY_EXT: Record<string, { icon: typeof FileIconGeneric; color: string }> = {
  ts: { icon: FileCode2, color: '#3178c6' },
  mts: { icon: FileCode2, color: '#3178c6' },
  cts: { icon: FileCode2, color: '#3178c6' },
  tsx: { icon: FileCode2, color: '#48b9c7' },
  js: { icon: FileCode2, color: '#e8d44d' },
  mjs: { icon: FileCode2, color: '#e8d44d' },
  cjs: { icon: FileCode2, color: '#e8d44d' },
  jsx: { icon: FileCode2, color: '#48b9c7' },
  json: { icon: Braces, color: '#cbcb41' },
  md: { icon: FileText, color: '#cccccc' },
  markdown: { icon: FileText, color: '#cccccc' },
  txt: { icon: FileText, color: '#9a9a9a' },
  css: { icon: Palette, color: '#519aba' },
  html: { icon: FileType2, color: '#e37933' },
  htm: { icon: FileType2, color: '#e37933' },
}

export function FileIcon({ path, size = 14 }: { path: string; size?: number }) {
  const ext = vfsPath.ext(path)
  const entry = BY_EXT[ext] ?? { icon: FileIconGeneric, color: '#9a9a9a' }
  const Icon = entry.icon
  return <Icon size={size} style={{ color: entry.color, flexShrink: 0 }} strokeWidth={1.8} />
}
