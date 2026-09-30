import { describe, expect, it } from 'bun:test'
import { fileURLToPath } from 'node:url'

import { Host } from '@opencode-ai/plugin/host'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
describe('OpenCode 2 package manifest', () => {
  it('resolves and loads the package directory without a name', async () => {
    const entrypoints = Host.resolve({ directory: packageRoot })

    expect(entrypoints.server).toBe(
      new URL('../index.js', import.meta.url).href,
    )

    const plugin = await import(entrypoints.server!)
    expect(plugin.default.setup).toBeFunction()
    expect(entrypoints.tui).toBe(new URL('../tui.js', import.meta.url).href)
    expect(entrypoints.rpc).toBe(new URL('../rpc.js', import.meta.url).href)
    const tui = await import(entrypoints.tui!)
    expect(tui.default.setup).toBeFunction()
  })

  it('resolves the built server entry through the real host resolver', () => {
    const entrypoints = Host.resolve({
      directory: packageRoot,
      name: '@cortexkit/opencode-v2-antigravity-auth',
    })

    expect(entrypoints.server).toBe(
      new URL('../dist/plugin.js', import.meta.url).href,
    )
    expect(fileURLToPath(entrypoints.server!)).toStartWith(packageRoot)
    expect(entrypoints.tui).toBe(
      new URL('../dist/tui.js', import.meta.url).href,
    )
    expect(entrypoints.rpc).toBe(
      new URL('../dist/rpc.js', import.meta.url).href,
    )
  })
})
