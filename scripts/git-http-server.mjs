#!/usr/bin/env node
/**
 * Real git smart-HTTP server for e2e — git http-backend (CGI) behind node's
 * http server, with CORS headers so the browser can reach it cross-origin.
 * Seeds a bare repo with one real commit using the local git CLI.
 * Prints "GITSERVER <port>" once listening.
 */
import http from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'cell-gitserver-'))
const bare = join(root, 'testrepo.git')
const work = join(root, 'seed-work')

const git = (cwd, ...args) => {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}

mkdirSync(work, { recursive: true })
git(work, 'init', '-b', 'master')
git(work, 'config', 'user.name', 'E2E Seed')
git(work, 'config', 'user.email', 'seed@e2e.local')
writeFileSync(join(work, 'hello.txt'), 'hello from the e2e git server\n')
mkdirSync(join(work, 'src'))
writeFileSync(join(work, 'src', 'main.js'), 'console.log("from testrepo")\n')
git(work, 'add', '.')
git(work, 'commit', '-m', 'e2e seed commit')
spawnSync('git', ['init', '--bare', '-b', 'master', bare], { encoding: 'utf8' })
git(work, 'remote', 'add', 'origin', bare)
git(work, 'push', 'origin', 'master')

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', '*')
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }
  const url = new URL(req.url, 'http://localhost')
  const child = spawn('git', ['http-backend'], {
    env: {
      ...process.env,
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: url.pathname,
      REQUEST_METHOD: req.method,
      QUERY_STRING: url.searchParams.toString(),
      CONTENT_TYPE: req.headers['content-type'] ?? '',
      REMOTE_ADDR: req.socket.remoteAddress ?? '127.0.0.1',
      GIT_HTTP_MAX_REQUEST_BUFFER: '1g',
      GIT_PROTOCOL: req.headers['git-protocol'] ?? '',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  req.pipe(child.stdin)
  const chunks = []
  child.stdout.on('data', (chunk) => chunks.push(chunk))
  child.stderr.on('data', (chunk) => process.stderr.write(`[git] ${chunk}`))
  child.on('close', () => {
    const buffer = Buffer.concat(chunks)
    const crlf = buffer.indexOf('\r\n\r\n')
    const lf = buffer.indexOf('\n\n')
    const sep = crlf !== -1 ? crlf : lf
    const bodyStart = crlf !== -1 ? crlf + 4 : lf + 2
    let status = 200
    if (sep !== -1) {
      for (const line of buffer.subarray(0, sep).toString().split(/\r?\n/)) {
        const idx = line.indexOf(':')
        if (idx === -1) continue
        const name = line.slice(0, idx).trim()
        const value = line.slice(idx + 1).trim()
        if (name.toLowerCase() === 'status') status = parseInt(value, 10) || 200
        else if (name.toLowerCase() !== 'access-control-allow-origin') res.setHeader(name, value)
      }
    }
    res.writeHead(status)
    res.end(sep !== -1 ? buffer.subarray(bodyStart) : buffer)
  })
})

server.listen(0, '127.0.0.1', () => {
  console.log(`GITSERVER ${server.address().port}`)
})

const cleanup = () => {
  server.close()
  rmSync(root, { recursive: true, force: true })
  process.exit(0)
}
process.on('SIGTERM', cleanup)
process.on('SIGINT', cleanup)
