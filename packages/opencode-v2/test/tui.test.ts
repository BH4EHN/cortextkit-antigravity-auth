import { describe, expect, test } from 'bun:test'
import { testRender } from '@opentui/solid'

import { tui } from '../src/tui.tsx'

type Command = {
  id?: string
  bind?: false | string
  slash?: { name: string; arguments?: boolean }
  run: (args?: string) => Promise<void> | void
}

type Layer = {
  mode?: string
  priority?: number
  enabled?: boolean | (() => boolean)
  commands: Command[]
}

function setup(
  route: { type: 'home' } | { type: 'session'; sessionID: string },
  rpcResults: {
    run?:
      | Record<string, unknown>
      | ((input: { name: string; args: string }) => Record<string, unknown>)
    operation?:
      | Record<string, unknown>
      | (() => Promise<Record<string, unknown>>)
  } = {},
) {
  let currentRoute = route
  const layers: Array<() => Layer> = []
  let panel: { name: string; sessionID: string } | undefined
  let destination: unknown
  let renderPage: (() => unknown) | undefined
  const navigations: unknown[] = []
  let panelOpenCount = 0
  const calls: Array<{ name: string; args: string }> = []
  const ctx = {
    client: {
      rpc: () => ({
        run: async (input: { name: string; args: string }) => {
          calls.push(input)
          return typeof rpcResults.run === 'function'
            ? rpcResults.run(input)
            : (rpcResults.run ?? { messages: ['Done'] })
        },
        operation: async () =>
          typeof rpcResults.operation === 'function'
            ? rpcResults.operation()
            : (rpcResults.operation ?? { state: 'complete', messages: [] }),
      }),
    },
    keymap: {
      layer: (input: () => Layer) => {
        layers.push(input)
      },
    },
    ui: {
      router: {
        current: () => currentRoute,
        register: (page: { render: () => unknown }) => {
          renderPage = page.render
          return () => {}
        },
        navigate: (input: unknown) => {
          destination = input
          navigations.push(input)
          currentRoute = input as typeof currentRoute
        },
      },
      panel: {
        open: (name: string) => {
          panelOpenCount++
          if (currentRoute.type === 'session')
            panel = { name, sessionID: currentRoute.sessionID }
          return true
        },
        current: () => panel,
        close: () => {
          panel = undefined
        },
      },
      slot: (claim: { append: string; render: () => unknown }) => {
        if (claim.append === 'app') claim.render()
        return () => {}
      },
      toast: { show: () => {} },
    },
    theme: {
      current: {
        text: '#eeeeee',
        textMuted: '#888888',
        accent: '#5555ff',
        success: '#00ff00',
        warning: '#ffff00',
        error: '#ff0000',
        borderSubtle: '#444444',
      },
    },
  }
  const cleanup = tui.setup(ctx as never)
  return {
    commands: layers[0]!().commands,
    calls,
    layers,
    get panel() {
      return panel?.name
    },
    get panelOpenCount() {
      return panelOpenCount
    },
    reopenPanel() {
      if (currentRoute.type !== 'session') return
      panel = {
        name: 'cortexkit.antigravity-auth',
        sessionID: currentRoute.sessionID,
      }
      panelOpenCount++
    },
    get destination() {
      return destination
    },
    get renderPage() {
      return renderPage
    },
    get navigations() {
      return navigations
    },
    cleanup,
  }
}

describe('OpenCode 2 TUI slash commands', () => {
  test('home route opens a plugin page without a model session', async () => {
    const mounted = setup({ type: 'home' })
    try {
      const quota = mounted.commands.find(
        (command) => command.slash?.name === 'antigravity-quota',
      )!
      expect(quota.slash?.arguments).toBe(true)
      await quota.run('refresh')
      expect(mounted.calls).toEqual([{ name: 'quota', args: 'refresh' }])
      expect(mounted.destination).toEqual({
        type: 'plugin',
        name: 'cortexkit.antigravity-auth',
      })
      expect(mounted.panel).toBeUndefined()
    } finally {
      await mounted.cleanup?.()
    }
  })

  test('session route opens the independent panel and passes account action text', async () => {
    const mounted = setup({ type: 'session', sessionID: 's1' })
    try {
      const account = mounted.commands.find(
        (command) => command.slash?.name === 'antigravity-account',
      )!
      await account.run('disable 2')
      expect(mounted.calls).toEqual([{ name: 'account', args: 'disable 2' }])
      expect(mounted.panel).toBe('cortexkit.antigravity-auth')
      expect(mounted.destination).toBeUndefined()
    } finally {
      await mounted.cleanup?.()
    }
  })

  test('Esc closes only this plugin page or session panel in base mode', async () => {
    const page = setup({ type: 'home' })
    try {
      const quota = page.commands.find(
        (command) => command.slash?.name === 'antigravity-quota',
      )!
      await quota.run()
      const closeLayer = page.layers[1]!()
      const close = closeLayer.commands.find(
        (command) => command.id === 'antigravity.close',
      )!
      expect(closeLayer.mode).toBe('base')
      expect(closeLayer.priority).toBe(1)
      expect(close.bind).toBe('escape')
      const pageEnabled = closeLayer.enabled
      expect(typeof pageEnabled).toBe('function')
      expect(typeof pageEnabled === 'function' && pageEnabled()).toBe(true)
      close.run()
      expect(page.navigations).toEqual([
        { type: 'plugin', name: 'cortexkit.antigravity-auth' },
        { type: 'home' },
      ])

      const session = setup({ type: 'session', sessionID: 's1' })
      try {
        const hiddenEnabled = session.layers[1]!().enabled
        expect(typeof hiddenEnabled).toBe('function')
        expect(typeof hiddenEnabled === 'function' && hiddenEnabled()).toBe(
          false,
        )
        const account = session.commands.find(
          (command) => command.slash?.name === 'antigravity-account',
        )!
        await account.run()
        const sessionCloseLayer = session.layers[1]!()
        const sessionClose = sessionCloseLayer.commands.find(
          (command) => command.id === 'antigravity.close',
        )!
        const sessionEnabled = sessionCloseLayer.enabled
        expect(typeof sessionEnabled).toBe('function')
        expect(typeof sessionEnabled === 'function' && sessionEnabled()).toBe(
          true,
        )
        sessionClose.run()
        expect(session.panel).toBeUndefined()
        expect(session.navigations).toEqual([])
      } finally {
        await session.cleanup?.()
      }
    } finally {
      await page.cleanup?.()
    }
  })

  test('late completion leaves a closed panel closed and allows later reopen', async () => {
    let finishOperation!: (result: Record<string, unknown>) => void
    const mounted = setup(
      { type: 'session', sessionID: 's1' },
      {
        run: { messages: [], operationId: 'login-1' },
        operation: () =>
          new Promise((resolve) => {
            finishOperation = resolve
          }),
      },
    )
    try {
      const account = mounted.commands.find(
        (command) => command.slash?.name === 'antigravity-account',
      )!
      await account.run('login')
      await Bun.sleep(0)
      const close = mounted.layers[1]!().commands.find(
        (command) => command.id === 'antigravity.close',
      )!
      close.run()
      expect(mounted.panel).toBeUndefined()
      finishOperation({ state: 'complete', messages: [] })
      await Bun.sleep(0)
      expect(mounted.panel).toBeUndefined()
      expect(mounted.panelOpenCount).toBe(1)
      expect(mounted.navigations).toEqual([])
      mounted.reopenPanel()
      expect(mounted.panel).toBe('cortexkit.antigravity-auth')
      expect(mounted.panelOpenCount).toBe(2)
      expect(mounted.navigations).toEqual([])
    } finally {
      await mounted.cleanup?.()
    }
  })

  test('plugin page footer advertises Esc close', async () => {
    const mounted = setup({ type: 'home' })
    const rendered = await testRender(() => mounted.renderPage!() as never, {
      width: 80,
      height: 40,
    })
    try {
      const status = mounted.commands.find(
        (command) => command.slash?.name === 'antigravity-status',
      )!
      await status.run()
      await rendered.flush()
      expect(rendered.captureCharFrame()).toContain('Esc: Close')
    } finally {
      await mounted.cleanup?.()
      rendered.renderer.destroy()
    }
  })

  test('async RPC results update the rendered page', async () => {
    const mounted = setup({ type: 'home' })
    const rendered = await testRender(() => mounted.renderPage!() as never, {
      width: 80,
      height: 12,
    })
    try {
      const status = mounted.commands.find(
        (command) => command.slash?.name === 'antigravity-status',
      )!
      status.run()
      await Bun.sleep(0)
      await rendered.flush()
      expect(rendered.captureCharFrame()).toContain('Done')
    } finally {
      await mounted.cleanup?.()
      rendered.renderer.destroy()
    }
  })

  test('status renders labeled groups at narrow and wide widths', async () => {
    const mounted = setup(
      { type: 'home' },
      {
        run: {
          messages: [],
          snapshot: {
            kind: 'status',
            pool: {
              total: 4,
              enabled: 2,
              disabled: 1,
              ineligible: 1,
              verificationRequired: 0,
            },
            current: { claude: 'Account 2', gemini: 'Account 1' },
            quotaCache: { oldestAgeMs: 3_600_000 },
            paths: {
              accountsFile:
                '/Users/example/.config/opencode/antigravity-accounts.json',
              logFile: '/Users/example/.local/share/opencode/antigravity.log',
            },
          },
        },
      },
    )
    const status = mounted.commands.find(
      (command) => command.slash?.name === 'antigravity-status',
    )!
    const narrow = await testRender(() => mounted.renderPage!() as never, {
      width: 42,
      height: 30,
    })
    const wide = await testRender(() => mounted.renderPage!() as never, {
      width: 100,
      height: 30,
    })
    try {
      status.run()
      await Bun.sleep(0)
      await narrow.flush()
      await wide.flush()
      await saveCapture('status-narrow', narrow)
      await saveCapture('status-wide', wide)
      const narrowFrame = narrow.captureCharFrame()
      const wideFrame = wide.captureCharFrame()
      for (const label of [
        'Pool',
        'Current family accounts',
        'Quota cache',
        'Files',
      ]) {
        expect(narrowFrame).toContain(label)
        expect(wideFrame).toContain(label)
      }
      expect(narrowFrame).toContain('Claude: Account 2')
      expect(wideFrame).toContain('verification needed: 0')
      expect(narrowFrame).toContain('Accounts file')
      expect(wideFrame).toContain('antigravity-accounts.json')
      expect(narrowFrame.replace(/\s/g, '')).toContain(
        '/Users/example/.config/opencode/antigravity-accounts.json',
      )
    } finally {
      await mounted.cleanup?.()
      narrow.renderer.destroy()
      wide.renderer.destroy()
    }
  })

  test('account quota uses explicit family windows, cache age, and current badges', async () => {
    const mounted = setup(
      { type: 'home' },
      {
        run: {
          messages: ['legacy quota table output', 'Quota refreshed.'],
          notices: ['Quota refreshed.'],
          snapshot: {
            kind: 'quota',
            accounts: [
              {
                label: 'Account 1',
                state: 'active',
                current: 'both',
                gemini: {
                  remainingPercent: 63,
                  resetAt: Date.now() + 3_600_000,
                  windows: [
                    {
                      name: '5h',
                      remainingPercent: 63,
                      resetAt: Date.now() + 3_600_000,
                    },
                  ],
                },
                nonGemini: {
                  remainingPercent: 8,
                  resetAt: Date.now() + 6 * 24 * 60 * 60_000 + 60 * 60_000,
                  windows: [
                    {
                      name: 'weekly',
                      remainingPercent: 8,
                      resetAt: Date.now() + 6 * 24 * 60 * 60_000 + 60 * 60_000,
                    },
                  ],
                },
                cacheUpdatedAt: Date.now() - 2 * 60_000,
              },
            ],
          },
        },
      },
    )
    const quota = mounted.commands.find(
      (command) => command.slash?.name === 'antigravity-quota',
    )!
    const narrow = await testRender(() => mounted.renderPage!() as never, {
      width: 42,
      height: 30,
    })
    const wide = await testRender(() => mounted.renderPage!() as never, {
      width: 100,
      height: 30,
    })
    try {
      quota.run()
      await Bun.sleep(0)
      await narrow.flush()
      await wide.flush()
      await saveCapture('quota-narrow', narrow)
      await saveCapture('quota-wide', wide)
      for (const frame of [
        narrow.captureCharFrame(),
        wide.captureCharFrame(),
      ]) {
        expect(frame).toContain('ACTIVE')
        expect(frame).toContain('Current · Claude + Gemini')
        expect(frame).toContain('63% remaining')
        expect(frame).toContain('5h · 63% · resets 59m')
        expect(frame).toContain('Weekly · 8% · resets 6d')
        expect(frame).toContain('Quota cache: 2m ago')
        expect(frame).not.toContain('Resets')
        expect(frame).toContain('┌')
        expect(frame).toContain('Notice')
        expect(frame).not.toContain('legacy quota table output')
        expect(frame).not.toContain('refresh-token-secret')
      }
      expect(narrow.captureCharFrame().replace(/\s/g, '')).not.toContain(
        'refresh-token-secret',
      )
    } finally {
      await mounted.cleanup?.()
      narrow.renderer.destroy()
      wide.renderer.destroy()
    }
  })

  test('OAuth progress stays visible while the final structured account view arrives', async () => {
    const mounted = setup(
      { type: 'home' },
      {
        run: {
          messages: [
            'Open this URL to authorize: https://accounts.example/oauth/very-long-url',
          ],
          operationId: 'operation-1',
        },
        operation: {
          state: 'complete',
          messages: [
            'Open this URL to authorize: https://accounts.example/oauth/very-long-url',
            'Account added to the Antigravity pool.',
          ],
          snapshot: { kind: 'account', accounts: [] },
        },
      },
    )
    const rendered = await testRender(() => mounted.renderPage!() as never, {
      width: 48,
      height: 20,
    })
    try {
      const account = mounted.commands.find(
        (command) => command.slash?.name === 'antigravity-account',
      )!
      account.run('add')
      await Bun.sleep(10)
      await rendered.flush()
      await saveCapture('oauth-narrow', rendered)
      const rawFrame = rendered.captureCharFrame()
      const frame = rawFrame.replace(/\s+/g, ' ')
      expect(frame).toContain('Open this URL to authorize')
      expect(frame).toContain('Account added to the Antigravity pool.')
      expect(frame).toContain('Notice')
      expect(rawFrame.replace(/\s/g, '')).toContain(
        'https://accounts.example/oauth/very-long-url',
      )
    } finally {
      await mounted.cleanup?.()
      rendered.renderer.destroy()
    }
  })

  test('timestamp zero remains a valid quota reset and cache timestamp', async () => {
    const mounted = setup(
      { type: 'home' },
      {
        run: {
          messages: [],
          notices: [],
          snapshot: {
            kind: 'quota',
            accounts: [
              {
                label: 'Account 1',
                state: 'active',
                current: 'claude',
                gemini: {
                  remainingPercent: 0,
                  resetAt: 0,
                  windows: [],
                },
                nonGemini: { remainingPercent: null, windows: [] },
                cacheUpdatedAt: 0,
              },
            ],
          },
        },
      },
    )
    const rendered = await testRender(() => mounted.renderPage!() as never, {
      width: 60,
      height: 24,
    })
    try {
      mounted.commands
        .find((command) => command.slash?.name === 'antigravity-quota')!
        .run()
      await Bun.sleep(0)
      await rendered.flush()
      const frame = rendered.captureCharFrame()
      expect(frame).toContain('Resets 0m')
      expect(frame).not.toContain('Quota cache: not available')
    } finally {
      await mounted.cleanup?.()
      rendered.renderer.destroy()
    }
  })

  test('OAuth completion does not replace a newer status view', async () => {
    let resolveOperation!: (value: Record<string, unknown>) => void
    const statusSnapshot = {
      kind: 'status',
      pool: {
        total: 3,
        enabled: 2,
        disabled: 1,
        ineligible: 0,
        verificationRequired: 0,
      },
      current: { claude: 'Account 1', gemini: 'Account 2' },
      quotaCache: { oldestAgeMs: null },
      paths: { accountsFile: '/tmp/accounts.json', logFile: '/tmp/agy.log' },
    }
    const mounted = setup(
      { type: 'home' },
      {
        run: (input) =>
          input.name === 'account'
            ? { messages: ['OAuth in progress'], operationId: 'pending-1' }
            : { messages: [], snapshot: statusSnapshot },
        operation: () =>
          new Promise((resolve) => {
            resolveOperation = resolve
          }),
      },
    )
    const rendered = await testRender(() => mounted.renderPage!() as never, {
      width: 76,
      height: 16,
    })
    try {
      mounted.commands
        .find((command) => command.slash?.name === 'antigravity-account')!
        .run('add')
      await Bun.sleep(0)
      mounted.commands
        .find((command) => command.slash?.name === 'antigravity-status')!
        .run()
      await Bun.sleep(0)
      await rendered.flush()
      expect(rendered.captureCharFrame()).toContain('Current family accounts')
      resolveOperation({
        state: 'complete',
        messages: ['OAuth complete'],
        snapshot: {
          kind: 'account',
          accounts: [
            {
              label: 'Account 1',
              state: 'active',
              current: 'both',
              gemini: { remainingPercent: null, windows: [] },
              nonGemini: { remainingPercent: null, windows: [] },
            },
          ],
        },
      })
      await Bun.sleep(0)
      await rendered.flush()
      const frame = rendered.captureCharFrame()
      expect(frame).toContain('Current family accounts')
      expect(frame).not.toContain('Current · Claude')
    } finally {
      await mounted.cleanup?.()
      rendered.renderer.destroy()
    }
  })
})

async function saveCapture(
  name: string,
  rendered: Awaited<ReturnType<typeof testRender>>,
): Promise<void> {
  const dir = process.env.AG_TUI_CAPTURE_DIR
  if (!dir) return
  const spans = rendered.captureSpans()
  const colors = spans.lines.map((line) =>
    line.spans.map((span) => ({
      text: span.text,
      fg: span.fg.toInts(),
      bg: span.bg.toInts(),
      attributes: span.attributes,
      width: span.width,
    })),
  )
  await Bun.write(`${dir}/${name}.txt`, rendered.captureCharFrame())
  await Bun.write(
    `${dir}/${name}.json`,
    JSON.stringify(
      { cols: spans.cols, rows: spans.rows, lines: colors },
      null,
      2,
    ),
  )
}
