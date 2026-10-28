import { describe, expect, it } from 'vitest'
import { createVfs } from '../vfs'
import { seedStarterProject } from '../vfs/starter'
import { createShell, type Shell } from './shell'

/**
 * The bash realism audit: the commands a coding agent would actually type,
 * asserted end to end through the real shell. If an agent can detect Cell
 * is not Linux through any of these, this file fails.
 */

async function auditShell(): Promise<{ shell: Shell; vfs: ReturnType<typeof createVfs> }> {
  const vfs = createVfs()
  seedStarterProject(vfs)
  vfs.write('/home/user/.gitconfig', '[user]\n\tname = T\n\temail = t@t.local\n')
  return { shell: createShell(vfs), vfs }
}

describe('system identity (container-detection tells)', () => {
  it('uname reports a linux kernel', async () => {
    const { shell } = await auditShell()
    const r = await shell.exec('uname -a')
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toMatch(/^Linux \S+ \d+\.\d+\S* .*x86_64 GNU\/Linux/)
  })

  it('id, groups, hostname, whoami look like a real user', async () => {
    const { shell } = await auditShell()
    expect((await shell.exec('id')).stdout).toContain('uid=1000(user)')
    expect((await shell.exec('groups')).stdout).toContain('sudo')
    expect((await shell.exec('hostname')).stdout.trim()).toBe('cell')
    expect((await shell.exec('whoami')).stdout.trim()).toBe('user')
  })

  it('df, free, ps, uptime produce plausible output', async () => {
    const { shell } = await auditShell()
    expect((await shell.exec('df -h /')).stdout).toMatch(/\/dev\/sda1\s+100G/)
    expect((await shell.exec('free -m')).stdout).toMatch(/Mem:/)
    expect((await shell.exec('ps aux')).stdout).toMatch(/PID.*COMMAND.*bash/s)
    expect((await shell.exec('uptime')).stdout).toMatch(/load average/)
  })

  it('/etc/os-release and /proc are readable', async () => {
    const { shell } = await auditShell()
    expect((await shell.exec('cat /etc/os-release')).stdout).toContain('PRETTY_NAME')
    expect((await shell.exec('cat /proc/version')).stdout).toContain('Linux version')
    expect((await shell.exec('cat /proc/cpuinfo')).stdout).toContain('processor')
  })

  it('which resolves platform commands to paths', async () => {
    const { shell } = await auditShell()
    const node = await shell.exec('which node')
    expect(node.exitCode).toBe(0)
    expect(node.stdout.trim()).toBe('/usr/local/bin/node')
    const git = await shell.exec('which git')
    expect(git.stdout.trim()).toBe('/usr/bin/git')
    const missing = await shell.exec('which definitely-not-here')
    expect(missing.exitCode).toBe(1)
  })
})

describe('.bashrc and session environment', () => {
  it('~/.bashrc exists and its exports are live in every command', async () => {
    const { shell } = await auditShell()
    const r = await shell.exec('echo "$NODE_ENV|$NPM_CONFIG_FUND|$EDITOR"')
    expect(r.stdout.trim()).toBe('development|false|vi')
  })

  it('exports persist across commands (like a real interactive shell)', async () => {
    const { shell } = await auditShell()
    await shell.exec('export DEPLOY_ENV=staging')
    await shell.exec('export BUILD_NUM=42')
    const r = await shell.exec('echo "$DEPLOY_ENV/$BUILD_NUM"')
    expect(r.stdout.trim()).toBe('staging/42')
  })

  it('plain (non-exported) variables also persist', async () => {
    const { shell } = await auditShell()
    await shell.exec('X=plain-value')
    expect((await shell.exec('echo $X')).stdout.trim()).toBe('plain-value')
  })

  it('aliases from .bashrc are defined and listed', async () => {
    const { shell } = await auditShell()
    // aliases expand at parse time in real bash too — a fresh non-interactive
    // parse sees them listed, expansion comes from an interactive line
    const r = await shell.exec('alias ll')
    expect(r.stdout).toContain("alias ll='ls -laF'")
  })

  it('the environment survives pipes and command substitution', async () => {
    const { shell } = await auditShell()
    await shell.exec('export COMBO=works')
    const r = await shell.exec('echo "value: $(echo $COMBO)" | tr a-z A-Z')
    expect(r.stdout).toContain('VALUE: WORKS')
  })
})

describe('scripting: the agent workhorse', () => {
  it('runs a shebang script through bash with arguments', async () => {
    const { shell } = await auditShell()
    await shell.exec("printf '#!/bin/bash\\necho deploying to \$1 in \$2\\n' > deploy.sh")
    const r = await shell.exec('bash deploy.sh production eu-west')
    expect(r.stdout).toContain('deploying to production in eu-west')
  })

  it('chmod +x and stat agree', async () => {
    const { shell } = await auditShell()
    await shell.exec('printf "#!/bin/bash\\necho ok\\n" > x.sh && chmod 755 x.sh')
    expect((await shell.exec('stat -c %a x.sh')).stdout.trim()).toBe('755')
  })

  it('multi-line scripts with variables, loops and conditionals', async () => {
    const { shell } = await auditShell()
    await shell.exec([
      'cat > script.sh <<\'EOF\'',
      '#!/bin/bash',
      'TARGET=${1:-world}',
      'for i in 1 2 3; do',
      '  if [ $i -eq 2 ]; then',
      '    echo "skip $i"',
      '  else',
      '    echo "hello $TARGET $i"',
      '  fi',
      'done',
      'EOF',
    ].join('\n'))
    const r = await shell.exec('bash script.sh agent')
    expect(r.stdout).toContain('hello agent 1')
    expect(r.stdout).toContain('skip 2')
    expect(r.stdout).toContain('hello agent 3')
  })

  it('heredocs, command substitution, subshells, pipelines', async () => {
    const { shell } = await auditShell()
    await shell.exec('cat <<EOF > note.txt\nuser is $USER\nEOF')
    expect((await shell.exec('cat note.txt')).stdout).toContain('user is user')
    expect((await shell.exec('echo "y: $(date +%Y)"')).stdout).toMatch(/y: \d{4}/)
    expect((await shell.exec('(cd / && pwd); pwd')).stdout.split('\n')[0]).toBe('/')
    const piped = await shell.exec('seq 1 10 | grep -v 3 | wc -l')
    expect(piped.stdout.trim()).toBe('9')
  })

  it('tar round-trips a directory', async () => {
    const { shell } = await auditShell()
    await shell.exec('mkdir -p pkg && echo data > pkg/file.txt')
    await shell.exec('tar czf p.tgz pkg && mkdir -p un && tar xzf p.tgz -C un')
    expect((await shell.exec('cat un/pkg/file.txt')).stdout).toContain('data')
  })

  it('exit codes propagate through && || and set -e', async () => {
    const { shell } = await auditShell()
    expect((await shell.exec('true && echo yes || echo no')).stdout.trim()).toBe('yes')
    expect((await shell.exec('false && echo yes || echo no')).stdout.trim()).toBe('no')
    const sete = await shell.exec('set -e; echo one; false; echo two')
    expect(sete.exitCode).toBe(1)
    expect(sete.stdout).toContain('one')
    expect(sete.stdout).not.toContain('two')
  })

  it('find, xargs, sort/uniq/wc pipelines', async () => {
    const { shell } = await auditShell()
    await shell.exec('mkdir -p tree && touch tree/a.js tree/b.js tree/c.ts')
    expect((await shell.exec('find tree -name "*.js" | wc -l')).stdout.trim()).toBe('2')
    const uniq = await shell.exec('printf "b\\na\\nb\\n" | sort | uniq -c | tr -s " "')
    expect(uniq.stdout).toContain('2 b')
  })

  it('xargs batches GNU-style: all args at once, quoted, -n/-0 supported', async () => {
    const { shell } = await auditShell()
    expect((await shell.exec('printf "a\\nb\\n" | xargs echo')).stdout.trim()).toBe('a b')
    expect((await shell.exec('printf "a b\\n" | xargs echo')).stdout.trim()).toBe('a b')
    expect((await shell.exec('printf "a\\nb\\nc\\n" | xargs -n 2 echo')).stdout.trim()).toBe('a b\nc')
  })
})
