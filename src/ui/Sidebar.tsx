import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, FilePlus, FolderPlus, ListCollapse, RefreshCw, Check, X } from 'lucide-react'
import { platform } from '../platform'
import { vfsPath } from '../vfs/types'
import { downloadVfsFile } from './download'
import { workspaceActions } from './workspace-store'
import { FileIcon } from './file-icon'
import { ContextMenu, type ContextMenuItem, type ContextMenuState } from './ContextMenu'
import { GitPanel } from './GitPanel'

type TreeFile = { name: string; path: string; dir: false }
type TreeDir = { name: string; path: string; dir: true; children: TreeEntry[] }
type TreeEntry = TreeFile | TreeDir

function buildTree(paths: string[]): TreeDir {
  const root: TreeDir = { name: '', path: '/', dir: true, children: [] }
  const dirIndex = new Map<string, TreeDir>([['/', root]])

  const ensureDir = (path: string): TreeDir => {
    const existing = dirIndex.get(path)
    if (existing) return existing
    const parent = ensureDir(vfsPath.dirname(path))
    const dir: TreeDir = { name: vfsPath.basename(path), path, dir: true, children: [] }
    parent.children.push(dir)
    dirIndex.set(path, dir)
    return dir
  }

  for (const path of paths) {
    const parent = ensureDir(vfsPath.dirname(path))
    parent.children.push({ name: vfsPath.basename(path), path, dir: false })
  }

  const sortDir = (dir: TreeDir) => {
    dir.children.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
    for (const child of dir.children) if (child.dir) sortDir(child)
  }
  sortDir(root)
  return root
}

type Editing =
  | { mode: 'create-file'; dir: string }
  | { mode: 'create-dir'; dir: string }
  | { mode: 'rename'; path: string; dir: boolean }
  | null

export function Sidebar({ view }: { view: 'explorer' | 'git' }) {
  if (view === 'git') {
    return (
      <aside className="sidebar">
        <GitPanel />
      </aside>
    )
  }
  return <Explorer />
}

const HOME = '/home/user'
const PROJECT = `${HOME}/project`

function Explorer() {
  const { vfs, bus } = platform()
  const [vfsVersion, setVfsVersion] = useState(0)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['/home', HOME, PROJECT]))
  const [editing, setEditing] = useState<Editing>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [menu, setMenu] = useState<ContextMenuState | null>(null)

  useEffect(() => {
    return bus.on('vfs:changed', () => setVfsVersion((v) => v + 1))
  }, [bus])

  const tree = useMemo(() => buildTree(vfs.listAllFiles()), [vfs, vfsVersion])

  const toggleDir = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const beginCreate = (dir: string, kind: 'file' | 'dir') => {
    setExpanded((prev) => new Set(prev).add(dir))
    setEditing(kind === 'file' ? { mode: 'create-file', dir } : { mode: 'create-dir', dir })
  }

  const commitCreate = (dir: string, kind: 'file' | 'dir', name: string) => {
    const path = vfsPath.join(dir, name)
    if (!name.trim()) return
    if (kind === 'file') {
      vfs.write(path, '')
      workspaceActions.openFile(path)
    } else {
      vfs.mkdir(path)
    }
  }

  const commitRename = (path: string, name: string) => {
    if (!name.trim()) return
    const to = vfsPath.join(vfsPath.dirname(path), name)
    if (to !== path) vfs.rename(path, to)
  }

  const confirmDeleteRow = (
    <span className="row-confirm">
      <button className="confirm-yes" title="Confirm delete" onClick={() => { if (confirmDelete) vfs.delete(confirmDelete); setConfirmDelete(null) }}>
        <Check size={13} />
      </button>
      <button className="confirm-no" title="Cancel" onClick={() => setConfirmDelete(null)}>
        <X size={13} />
      </button>
    </span>
  )

  const itemMenu = (entry: TreeEntry): ContextMenuItem[] => {
    const parentDir = vfsPath.dirname(entry.path)
    return entry.dir
      ? [
          { label: 'New File', onClick: () => beginCreate(entry.path, 'file') },
          { label: 'New Folder', onClick: () => beginCreate(entry.path, 'dir') },
          { label: 'Rename', onClick: () => setEditing({ mode: 'rename', path: entry.path, dir: true }) },
          { label: 'Delete', danger: true, onClick: () => setConfirmDelete(entry.path) },
          { label: 'Copy Path', onClick: () => void navigator.clipboard?.writeText(entry.path).catch(() => {}) },
        ]
      : [
          { label: 'New File', onClick: () => beginCreate(parentDir, 'file') },
          { label: 'Rename', onClick: () => setEditing({ mode: 'rename', path: entry.path, dir: false }) },
          { label: 'Download', onClick: () => downloadVfsFile(entry.path) },
          { label: 'Delete', danger: true, onClick: () => setConfirmDelete(entry.path) },
          { label: 'Copy Path', onClick: () => void navigator.clipboard?.writeText(entry.path).catch(() => {}) },
        ]
  }

  const renderEntry = (entry: TreeEntry, depth: number) => {
    const isExpanded = expanded.has(entry.path)
    const isRenameTarget = editing !== null && editing.mode === 'rename' && editing.path === entry.path

    if (isRenameTarget) {
      return (
        <NameInput
          key={`edit-${entry.path}`}
          depth={depth}
          defaultValue={entry.name}
          placeholder={editing!.dir ? 'folder name' : 'file name'}
          onCommit={(name) => {
            commitRename(entry.path, name)
            setEditing(null)
          }}
          onCancel={() => setEditing(null)}
        />
      )
    }

    return (
      <div key={entry.path}>
        <div
          className={`tree-row ${entry.dir ? 'is-dir' : 'is-file'}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => (entry.dir ? toggleDir(entry.path) : workspaceActions.openFile(entry.path))}
          onContextMenu={(e) => {
            e.preventDefault()
            setMenu({ x: e.clientX, y: e.clientY, items: itemMenu(entry) })
          }}
        >
          <span className="tree-chevron">
            {entry.dir ? (isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />) : null}
          </span>
          {entry.dir ? (
            <span className="tree-folder-name">{entry.name}</span>
          ) : (
            <>
              <FileIcon path={entry.path} />
              <span className="tree-file-name">{entry.name}</span>
            </>
          )}
          {confirmDelete === entry.path ? confirmDeleteRow : null}
        </div>
        {entry.dir && isExpanded ? (
          <div className="tree-children">
            {entry.children.map((child) => renderEntry(child, depth + 1))}
            {editing !== null && (editing.mode === 'create-file' || editing.mode === 'create-dir') && editing.dir === entry.path ? (
              <NameInput
                depth={depth + 1}
                defaultValue=""
                placeholder={editing.mode === 'create-file' ? 'file name' : 'folder name'}
                onCommit={(name) => {
                  commitCreate(entry.path, editing.mode === 'create-file' ? 'file' : 'dir', name)
                  setEditing(null)
                }}
                onCancel={() => setEditing(null)}
              />
            ) : null}
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <aside
      className="sidebar"
      onContextMenu={(e) => {
        if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('sidebar-body')) {
          e.preventDefault()
          setMenu({
            x: e.clientX,
            y: e.clientY,
            items: [
              { label: 'New File', onClick: () => beginCreate(PROJECT, 'file') },
              { label: 'New Folder', onClick: () => beginCreate(PROJECT, 'dir') },
            ],
          })
        }
      }}
    >
      <div className="sidebar-header">
        <span>EXPLORER</span>
        <span className="sidebar-actions">
          <button title="New File" onClick={() => beginCreate(PROJECT, 'file')}>
            <FilePlus size={14} />
          </button>
          <button title="New Folder" onClick={() => beginCreate(PROJECT, 'dir')}>
            <FolderPlus size={14} />
          </button>
          <button title="Collapse All" onClick={() => setExpanded(new Set())}>
            <ListCollapse size={14} />
          </button>
          <button title="Refresh" onClick={() => setVfsVersion((v) => v + 1)}>
            <RefreshCw size={14} />
          </button>
        </span>
      </div>
      <div className="sidebar-body">
        {tree.children.length === 0 && editing === null ? (
          <div className="sidebar-empty">
            Empty workspace — create a file
            <button className="linkish" onClick={() => beginCreate(PROJECT, 'file')}>
              here
            </button>
            , or right-click for more.
          </div>
        ) : null}
        {tree.children.map((child) => renderEntry(child, 0))}
        {editing !== null && (editing.mode === 'create-file' || editing.mode === 'create-dir') && editing.dir === PROJECT ? (
          <NameInput
            depth={0}
            defaultValue=""
            placeholder={editing.mode === 'create-file' ? 'file name' : 'folder name'}
            onCommit={(name) => {
              commitCreate('/', editing.mode === 'create-file' ? 'file' : 'dir', name)
              setEditing(null)
            }}
            onCancel={() => setEditing(null)}
          />
        ) : null}
      </div>
      {menu ? <ContextMenu state={menu} onClose={() => setMenu(null)} /> : null}
    </aside>
  )
}

function NameInput({
  depth,
  defaultValue,
  placeholder,
  onCommit,
  onCancel,
}: {
  depth: number
  defaultValue: string
  placeholder: string
  onCommit(name: string): void
  onCancel(): void
}) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  return (
    <div className="tree-row name-input-row" style={{ paddingLeft: 8 + depth * 14 }}>
      <input
        ref={ref}
        className="name-input"
        defaultValue={defaultValue}
        placeholder={placeholder}
        spellCheck={false}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onCommit((e.target as HTMLInputElement).value)
          if (e.key === 'Escape') onCancel()
        }}
        onBlur={(e) => onCommit(e.target.value)}
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  )
}
