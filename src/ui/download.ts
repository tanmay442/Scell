import { platform } from '../platform'

/** Download any VFS file through a blob link (artifacts, PNGs, CSVs…). */
export function downloadVfsFile(path: string): void {
  const bytes = platform().vfs.readBytes(path)
  if (bytes === null) return
  const name = path.slice(path.lastIndexOf('/') + 1)
  const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart]))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}
