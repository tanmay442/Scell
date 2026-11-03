import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadSecrets } from './secrets'

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {}
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key]
    const value = vars[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    fn()
  } finally {
    for (const key of Object.keys(vars)) {
      const value = saved[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

describe('loadSecrets', () => {
  it('returns an empty map when neither variable is set', () => {
    withEnv({ CELL_SECRETS_JSON: undefined, CELL_SECRETS_FILE: undefined }, () => {
      expect(loadSecrets().size).toBe(0)
    })
  })

  it('parses a JSON object string', () => {
    withEnv({ CELL_SECRETS_JSON: '{"META_KEY":"abc","OTHER":"x=y z"}', CELL_SECRETS_FILE: undefined }, () => {
      const secrets = loadSecrets()
      expect(secrets.get('META_KEY')).toBe('abc')
      expect(secrets.get('OTHER')).toBe('x=y z')
      expect(secrets.size).toBe(2)
    })
  })

  it('throws a clear error on malformed JSON', () => {
    withEnv({ CELL_SECRETS_JSON: '{"broken":', CELL_SECRETS_FILE: undefined }, () => {
      expect(() => loadSecrets()).toThrow(/CELL_SECRETS_JSON is not valid JSON/)
    })
  })

  it('rejects non-object JSON and non-string values', () => {
    withEnv({ CELL_SECRETS_JSON: '["a"]', CELL_SECRETS_FILE: undefined }, () => {
      expect(() => loadSecrets()).toThrow(/must be a JSON object of string values/)
    })
    withEnv({ CELL_SECRETS_JSON: '{"KEY":42}', CELL_SECRETS_FILE: undefined }, () => {
      expect(() => loadSecrets()).toThrow(/key 'KEY' is not a string/)
    })
  })

  it('reads secrets from a file and reports file errors clearly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'secrets-test-'))
    try {
      const good = join(dir, 'good.json')
      writeFileSync(good, '{"FROM_FILE":"yes"}')
      withEnv({ CELL_SECRETS_JSON: undefined, CELL_SECRETS_FILE: good }, () => {
        expect(loadSecrets().get('FROM_FILE')).toBe('yes')
      })
      const bad = join(dir, 'bad.json')
      writeFileSync(bad, 'not json{')
      withEnv({ CELL_SECRETS_JSON: undefined, CELL_SECRETS_FILE: bad }, () => {
        expect(() => loadSecrets()).toThrow(/is not valid JSON/)
      })
      withEnv({ CELL_SECRETS_JSON: undefined, CELL_SECRETS_FILE: join(dir, 'missing.json') }, () => {
        expect(() => loadSecrets()).toThrow(/cannot read/)
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('prefers CELL_SECRETS_JSON when both are set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'secrets-test-'))
    try {
      const file = join(dir, 's.json')
      writeFileSync(file, '{"K":"file"}')
      withEnv({ CELL_SECRETS_JSON: '{"K":"json"}', CELL_SECRETS_FILE: file }, () => {
        expect(loadSecrets().get('K')).toBe('json')
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
