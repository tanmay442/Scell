import type { Vfs } from '../src/vfs/types'

const CONFIG_PATH = '/home/user/.cell/agent.json'
const ALLOWED_PROVIDERS = ['meta', 'anthropic', 'openai', 'compat']

export function ensureAgentConfig(vfs: Vfs): void {
  if (vfs.exists(CONFIG_PATH)) return
  const provider = process.env.CELL_PROVIDER || 'meta'
  if (!ALLOWED_PROVIDERS.includes(provider)) {
    throw new Error(`unknown CELL_PROVIDER '${provider}' (use ${ALLOWED_PROVIDERS.join(', ')})`)
  }
  const model = process.env.CELL_MODEL || ''
  const apiKey = process.env.CELL_AGENT_KEY || ''
  const baseURL = process.env.CELL_BASE_URL || ''
  if (provider === 'compat' && baseURL === '') {
    throw new Error(`compat provider requires CELL_BASE_URL (e.g. https://api.x.ai/v1)`)
  }
  const config: Record<string, string> = { provider }
  if (model !== '') config.model = model
  if (apiKey !== '') config.apiKey = apiKey
  if (provider === 'compat' && baseURL !== '') config.baseURL = baseURL
  vfs.write(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`)
}
