import { describe, expect, it } from 'vitest'
import { createVfs } from '../../vfs'
import { findGitRepos, looksLikeText } from './git'

describe('looksLikeText', () => {
  const enc = (s: string) => new TextEncoder().encode(s)

  it('accepts plain text and typical config files', () => {
    expect(looksLikeText(enc('hello world'))).toBe(true)
    expect(looksLikeText(enc('ref: refs/heads/main\n'))).toBe(true)
    expect(looksLikeText(enc('[core]\n\tbare = false\n'))).toBe(true)
  })

  it('accepts utf-8 multibyte content', () => {
    expect(looksLikeText(enc('héllo — 🎉 日本語'))).toBe(true)
  })

  it('accepts the empty file', () => {
    expect(looksLikeText(new Uint8Array(0))).toBe(true)
  })

  it('rejects NUL bytes and control characters', () => {
    expect(looksLikeText(new Uint8Array([0x68, 0x00, 0x69]))).toBe(false)
    expect(looksLikeText(new Uint8Array([0x01, 0x02]))).toBe(false)
  })

  it('rejects invalid utf-8', () => {
    expect(looksLikeText(new Uint8Array([0xff, 0xfe, 0xff]))).toBe(false)
    expect(looksLikeText(new Uint8Array([0x68, 0xc3, 0x28]))).toBe(false)
  })
})

describe('findGitRepos', () => {
  it('returns nothing in an empty workspace', () => {
    expect(findGitRepos(createVfs())).toEqual([])
  })

  it('discovers a repo by its .git directory', () => {
    const vfs = createVfs()
    vfs.write('/home/user/project/.git/HEAD', 'ref: refs/heads/main\n')
    vfs.write('/home/user/project/README.md', 'x')
    expect(findGitRepos(vfs)).toEqual(['/home/user/project'])
  })

  it('discovers several repos, wherever they live', () => {
    const vfs = createVfs()
    vfs.write('/home/user/project/.git/HEAD', 'ref: refs/heads/main\n')
    vfs.write('/home/user/repos/clone-a/.git/HEAD', 'ref: refs/heads/master\n')
    vfs.write('/opt/elsewhere/.git/HEAD', 'ref: refs/heads/trunk\n')
    expect(findGitRepos(vfs)).toEqual(['/home/user/project', '/home/user/repos/clone-a', '/opt/elsewhere'].sort())
  })

  it('treats a .git pointer file (submodule/worktree) as a repo root', () => {
    const vfs = createVfs()
    vfs.write('/home/user/sub/.git', 'gitdir: ../project/.git/worktrees/sub\n')
    expect(findGitRepos(vfs)).toEqual(['/home/user/sub'])
  })

  it('does not mistake .git internals for nested repos', () => {
    const vfs = createVfs()
    vfs.write('/home/user/project/.git/HEAD', 'ref: refs/heads/main\n')
    // a worktree pointer inside .git is not itself a repo root
    expect(findGitRepos(vfs)).toEqual(['/home/user/project'])
  })
})
