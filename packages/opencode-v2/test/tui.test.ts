import { describe, expect, jest, test } from 'bun:test'
import { RGBA, TextAttributes } from '@opentui/core'
import { testRender } from '@opentui/solid'
import { jsx } from '@opentui/solid/jsx-runtime'
import { createSignal } from 'solid-js'
import type { SidebarQuotaSnapshot } from '../src/rpc.ts'
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
      | ((input: {
          name: string
          args: string
        }) => Record<string, unknown> | Promise<Record<string, unknown>>)
    operation?:
      | Record<string, unknown>
      | (() => Promise<Record<string, unknown>>)
    sidebarQuota?:
      | SidebarQuotaSnapshot
      | ((input: { mode: 'cache' | 'ensure' }) => Promise<SidebarQuotaSnapshot>)
  } = {},
  dataOptions: {
    syncSession?: (sessionID: string) => Promise<void>
    defaultDirectory?: string
    directory?: string
    sessionDirectories?: Record<string, string>
  } = {},
  themeOverride?: unknown,
) {
  let currentRoute = route
  const layers: Array<() => Layer> = []
  let panel: { name: string; sessionID: string } | undefined
  let destination: unknown
  let renderPage: (() => unknown) | undefined
  const navigations: unknown[] = []
  let panelOpenCount = 0
  const calls: Array<{ name: string; args: string }> = []
  const toastCalls: unknown[] = []
  const sidebarCalls: Array<'cache' | 'ensure'> = []
  const rpcLocations: Array<{
    method: 'run' | 'operation' | 'sidebarQuota'
    directory: string | undefined
  }> = []
  const sessions = new Map<
    string,
    {
      model?: { providerID: string; id: string }
      location?: { directory: string }
    }
  >()
  const sessionLocationSetters = new Map<string, (directory: string) => void>()
  for (const [sessionID, directory] of Object.entries(
    dataOptions.sessionDirectories ?? {},
  )) {
    const [getDirectory, setDirectory] = createSignal(directory)
    sessionLocationSetters.set(sessionID, setDirectory)
    sessions.set(sessionID, {
      location: {
        get directory() {
          return getDirectory()
        },
      },
    })
  }
  const [currentDirectory, setCurrentDirectory] = createSignal(
    dataOptions.directory ?? '/workspace/current',
  )
  const defaultDirectory = dataOptions.defaultDirectory ?? '/workspace/default'
  const listeners = new Set<(event: unknown) => void>()
  let renderSidebar: ((input: { sessionID: string }) => unknown) | undefined
  const ctx = {
    client: {
      rpc: () => ({
        sidebarQuota: async (
          input: { mode: 'cache' | 'ensure' },
          options?: { location?: { directory: string } },
        ) => {
          rpcLocations.push({
            method: 'sidebarQuota',
            directory: options?.location?.directory,
          })
          sidebarCalls.push(input.mode)
          const result = rpcResults.sidebarQuota
          return typeof result === 'function'
            ? result(input)
            : (result ?? { accounts: [], notices: [] })
        },
        run: async (
          input: { name: string; args: string },
          options?: { location?: { directory: string } },
        ) => {
          rpcLocations.push({
            method: 'run',
            directory: options?.location?.directory,
          })
          calls.push(input)
          return typeof rpcResults.run === 'function'
            ? rpcResults.run(input)
            : (rpcResults.run ?? { messages: ['Done'] })
        },
        operation: async (
          _input: { operationId: string },
          options?: { location?: { directory: string } },
        ) => {
          rpcLocations.push({
            method: 'operation',
            directory: options?.location?.directory,
          })
          return typeof rpcResults.operation === 'function'
            ? rpcResults.operation()
            : (rpcResults.operation ?? { state: 'complete', messages: [] })
        },
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
        if (claim.append === 'sidebar.content')
          renderSidebar = claim.render as (input: {
            sessionID: string
          }) => unknown
        return () => {}
      },
      toast: { show: (input: unknown) => toastCalls.push(input) },
    },
    get location() {
      return { directory: currentDirectory() }
    },
    data: {
      location: { default: () => ({ directory: defaultDirectory }) },
      session: {
        get: (id: string) => sessions.get(id),
        sync: async (sessionID: string) => dataOptions.syncSession?.(sessionID),
      },
      on: (_type: string, handler: (event: unknown) => void) => {
        listeners.add(handler)
        return () => listeners.delete(handler)
      },
    },
    theme: themeOverride ?? {
      text: {
        base: RGBA.fromInts(238, 238, 238),
        muted: RGBA.fromInts(128, 128, 128),
        action: { primary: { selected: RGBA.fromInts(250, 178, 131) } },
        feedback: {
          success: { base: RGBA.fromInts(127, 216, 143) },
          warning: { base: RGBA.fromInts(245, 167, 66) },
          error: { base: RGBA.fromInts(224, 108, 117) },
        },
      },
      border: { base: RGBA.fromInts(72, 72, 72) },
    },
  }
  const cleanup = tui.setup(ctx as never)
  return {
    commands: layers[0]!().commands,
    calls,
    toastCalls,
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
    get renderSidebar() {
      return renderSidebar
    },
    sidebarCalls,
    rpcLocations,
    setLocation(directory: string) {
      setCurrentDirectory(directory)
    },
    setSessionLocation(sessionID: string, directory: string) {
      let setDirectory = sessionLocationSetters.get(sessionID)
      if (!setDirectory) {
        const [getDirectory, set] = createSignal(directory)
        setDirectory = set
        sessionLocationSetters.set(sessionID, set)
        sessions.set(sessionID, {
          ...sessions.get(sessionID),
          location: {
            get directory() {
              return getDirectory()
            },
          },
        })
      }
      setDirectory(directory)
    },
    selectModel(sessionID: string, model?: { providerID: string; id: string }) {
      const current = sessions.get(sessionID)
      sessions.set(sessionID, { model, location: current?.location })
      for (const listener of listeners)
        listener({
          type: 'session.model.selected',
          data: { sessionID, model },
        })
    },
    get navigations() {
      return navigations
    },
    cleanup,
  }
}

function sidebarSnapshot(
  remainingPercent: number | null,
  source: 'cache' | 'live' = 'cache',
): SidebarQuotaSnapshot {
  const cell = {
    remainingPercent,
    source,
    updatedAt: Date.now() - 60_000,
    refreshState: 'idle' as const,
    windows: [
      {
        name: '5h' as const,
        remainingPercent,
        resetAt: Date.now() + 3_600_000,
      },
      {
        name: 'weekly' as const,
        remainingPercent: 14,
        resetAt: Date.now() + 4 * 24 * 60 * 60_000,
      },
    ],
  }
  return {
    notices: [],
    accounts: [
      {
        label: 'Default account',
        state: 'active',
        current: 'both',
        gemini: cell,
        nonGemini: { ...cell, remainingPercent: 0 },
      },
      {
        label: 'Disabled account',
        state: 'disabled',
        current: 'none',
        gemini: { ...cell, remainingPercent: null },
        nonGemini: { ...cell, remainingPercent: 22 },
      },
    ],
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

  test('routes run and operation RPCs through the initiating session directory', async () => {
    let resolveOperation!: (result: Record<string, unknown>) => void
    const mounted = setup(
      { type: 'session', sessionID: 'session-a' },
      {
        run: { messages: [], operationId: 'login-a' },
        operation: () =>
          new Promise((resolve) => {
            resolveOperation = resolve
          }),
      },
      { sessionDirectories: { 'session-a': '/workspace/session-a' } },
    )
    try {
      await mounted.commands
        .find((command) => command.slash?.name === 'antigravity-account')!
        .run('login')
      mounted.setLocation('/workspace/other')
      resolveOperation({ state: 'complete', messages: ['Login complete'] })
      await Bun.sleep(0)
      expect(mounted.rpcLocations).toEqual([
        { method: 'run', directory: '/workspace/session-a' },
        { method: 'operation', directory: '/workspace/session-a' },
      ])
    } finally {
      await mounted.cleanup?.()
    }
  })

  test('a newer run invalidates the previous operation poll', async () => {
    let resolveOperation!: (result: Record<string, unknown>) => void
    const mounted = setup(
      { type: 'home' },
      {
        run: (input) =>
          input.name === 'account'
            ? { messages: ['Old login'], operationId: 'login-old' }
            : { messages: ['New status'] },
        operation: () =>
          new Promise((resolve) => {
            resolveOperation = resolve
          }),
      },
    )
    try {
      await mounted.commands
        .find((command) => command.slash?.name === 'antigravity-account')!
        .run('login')
      await Bun.sleep(0)
      await mounted.commands
        .find((command) => command.slash?.name === 'antigravity-status')!
        .run()
      resolveOperation({ state: 'complete', messages: ['Stale login result'] })
      await Bun.sleep(0)
      expect(
        mounted.rpcLocations.filter(({ method }) => method === 'run'),
      ).toEqual([
        { method: 'run', directory: '/workspace/current' },
        { method: 'run', directory: '/workspace/current' },
      ])
      expect(
        mounted.rpcLocations.find(({ method }) => method === 'operation'),
      ).toEqual({
        method: 'operation',
        directory: '/workspace/current',
      })
      expect(mounted.calls).toEqual([
        { name: 'account', args: 'login' },
        { name: 'status', args: '' },
      ])
    } finally {
      await mounted.cleanup?.()
    }
  })

  test('unload ignores a run result that arrives later', async () => {
    let resolveRun!: (result: Record<string, unknown>) => void
    const mounted = setup(
      { type: 'home' },
      {
        run: () =>
          new Promise((resolve) => {
            resolveRun = resolve
          }),
      },
    )
    const pending = mounted.commands
      .find((command) => command.slash?.name === 'antigravity-account')!
      .run('login')
    await Bun.sleep(0)
    mounted.cleanup?.()
    resolveRun({ messages: ['Late login'], operationId: 'late-operation' })
    await pending
    expect(
      mounted.rpcLocations.filter(({ method }) => method === 'operation'),
    ).toEqual([])
    expect(mounted.toastCalls).toEqual([])
  })

  test('unload clears polling and ignores a late terminal failure', async () => {
    let resolveOperation!: (result: Record<string, unknown>) => void
    const setIntervalSpy = jest.spyOn(globalThis, 'setInterval')
    const clearIntervalSpy = jest.spyOn(globalThis, 'clearInterval')
    const mounted = setup(
      { type: 'home' },
      {
        run: { messages: [], operationId: 'unloaded-operation' },
        operation: () =>
          new Promise((resolve) => {
            resolveOperation = resolve
          }),
      },
    )
    try {
      await mounted.commands
        .find((command) => command.slash?.name === 'antigravity-account')!
        .run('login')
      const timer = setIntervalSpy.mock.results.at(-1)?.value
      const clockIndex = setIntervalSpy.mock.calls.findIndex(
        ([, delay]) => delay === 60_000,
      )
      expect(clockIndex).toBeGreaterThanOrEqual(0)
      const clockTimer = setIntervalSpy.mock.results[clockIndex]?.value
      expect(timer).toBeDefined()
      expect(clockTimer).toBeDefined()
      mounted.cleanup?.()
      expect(clearIntervalSpy).toHaveBeenCalledWith(timer)
      expect(clearIntervalSpy).toHaveBeenCalledWith(clockTimer)
      resolveOperation({ state: 'failed', messages: ['Late failure'] })
      await Bun.sleep(0)
      expect(
        mounted.rpcLocations.filter(({ method }) => method === 'operation'),
      ).toHaveLength(1)
      expect(mounted.toastCalls).toEqual([])
    } finally {
      setIntervalSpy.mockRestore()
      clearIntervalSpy.mockRestore()
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

  test('status cache age advances from the accepted snapshot without another RPC', async () => {
    let now = 1_800_000_000_000
    const dateNowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now)
    const intervalSpy = jest.spyOn(globalThis, 'setInterval')
    const mounted = setup(
      { type: 'home' },
      {
        run: {
          messages: [],
          snapshot: {
            kind: 'status',
            pool: {
              total: 1,
              enabled: 1,
              disabled: 0,
              ineligible: 0,
              verificationRequired: 0,
            },
            current: { claude: 'Account 1', gemini: 'Account 1' },
            quotaCache: { oldestAgeMs: 2 * 60_000 },
            paths: { accountsFile: '/accounts.json', logFile: '/log.txt' },
          },
        },
      },
    )
    const rendered = await testRender(() => mounted.renderPage!() as never, {
      width: 80,
      height: 30,
    })
    try {
      await mounted.commands
        .find((command) => command.slash?.name === 'antigravity-status')!
        .run()
      await Bun.sleep(0)
      await rendered.flush()
      expect(rendered.captureCharFrame()).toContain(
        'Oldest enabled account cache: 2m ago',
      )

      now += 60_000
      const clockCall = intervalSpy.mock.calls.find(
        ([, delay]) => delay === 60_000,
      )
      expect(clockCall).toBeDefined()
      ;(clockCall![0] as () => void)()
      await rendered.flush()
      expect(rendered.captureCharFrame()).toContain(
        'Oldest enabled account cache: 3m ago',
      )
      expect(
        mounted.rpcLocations.filter(({ method }) => method === 'run'),
      ).toHaveLength(1)
    } finally {
      await mounted.cleanup?.()
      rendered.renderer.destroy()
      intervalSpy.mockRestore()
      dateNowSpy.mockRestore()
    }
  })

  test('unknown status cache age stays unknown as the shared clock advances', async () => {
    let now = 1_800_000_000_000
    const dateNowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now)
    const intervalSpy = jest.spyOn(globalThis, 'setInterval')
    const mounted = setup(
      { type: 'home' },
      {
        run: {
          messages: [],
          snapshot: {
            kind: 'status',
            pool: {
              total: 0,
              enabled: 0,
              disabled: 0,
              ineligible: 0,
              verificationRequired: 0,
            },
            current: { claude: null, gemini: null },
            quotaCache: { oldestAgeMs: null },
            paths: { accountsFile: '/accounts.json', logFile: '/log.txt' },
          },
        },
      },
    )
    const rendered = await testRender(() => mounted.renderPage!() as never, {
      width: 80,
      height: 30,
    })
    try {
      await mounted.commands
        .find((command) => command.slash?.name === 'antigravity-status')!
        .run()
      await Bun.sleep(0)
      await rendered.flush()
      expect(rendered.captureCharFrame()).toContain('Never refreshed')

      now += 60_000
      const clockCall = intervalSpy.mock.calls.find(
        ([, delay]) => delay === 60_000,
      )
      expect(clockCall).toBeDefined()
      ;(clockCall![0] as () => void)()
      await rendered.flush()
      expect(rendered.captureCharFrame()).toContain('Never refreshed')
    } finally {
      await mounted.cleanup?.()
      rendered.renderer.destroy()
      intervalSpy.mockRestore()
      dateNowSpy.mockRestore()
    }
  })

  test('zero status cache age advances as a known value', async () => {
    let now = 1_800_000_000_000
    const dateNowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now)
    const intervalSpy = jest.spyOn(globalThis, 'setInterval')
    const mounted = setup(
      { type: 'home' },
      {
        run: {
          messages: [],
          snapshot: {
            kind: 'status',
            pool: {
              total: 0,
              enabled: 0,
              disabled: 0,
              ineligible: 0,
              verificationRequired: 0,
            },
            current: { claude: null, gemini: null },
            quotaCache: { oldestAgeMs: 0 },
            paths: { accountsFile: '/accounts.json', logFile: '/log.txt' },
          },
        },
      },
    )
    const rendered = await testRender(() => mounted.renderPage!() as never, {
      width: 80,
      height: 30,
    })
    try {
      await mounted.commands
        .find((command) => command.slash?.name === 'antigravity-status')!
        .run()
      await Bun.sleep(0)
      await rendered.flush()
      expect(rendered.captureCharFrame()).toContain(
        'Oldest enabled account cache: just now',
      )

      now += 60_000
      const clockCall = intervalSpy.mock.calls.find(
        ([, delay]) => delay === 60_000,
      )
      expect(clockCall).toBeDefined()
      ;(clockCall![0] as () => void)()
      await rendered.flush()
      expect(rendered.captureCharFrame()).toContain(
        'Oldest enabled account cache: 1m ago',
      )
    } finally {
      await mounted.cleanup?.()
      rendered.renderer.destroy()
      intervalSpy.mockRestore()
      dateNowSpy.mockRestore()
    }
  })

  test('status cache ages switch from just now to elapsed units at minute boundaries', async () => {
    jest.setSystemTime(new Date(2026, 9, 4, 12, 34))
    let ageMs = 0
    const mounted = setup(
      { type: 'home' },
      {
        run: () => ({
          messages: [],
          snapshot: {
            kind: 'status',
            pool: {
              total: 0,
              enabled: 0,
              disabled: 0,
              ineligible: 0,
              verificationRequired: 0,
            },
            current: { claude: null, gemini: null },
            quotaCache: { oldestAgeMs: ageMs },
            paths: { accountsFile: '/accounts.json', logFile: '/log.txt' },
          },
        }),
      },
    )
    const rendered = await testRender(() => mounted.renderPage!() as never, {
      width: 80,
      height: 30,
    })
    try {
      const status = mounted.commands.find(
        (command) => command.slash?.name === 'antigravity-status',
      )!
      for (const [age, label] of [
        [0, 'just now'],
        [59_999, 'just now'],
        [60_000, '1m ago'],
        [3_599_999, '59m ago'],
        [3_600_000, '1h ago'],
      ] as const) {
        ageMs = age
        await status.run()
        await Bun.sleep(0)
        await rendered.flush()
        expect(rendered.captureCharFrame()).toContain(
          `Oldest enabled account cache: ${label}`,
        )
      }
    } finally {
      await mounted.cleanup?.()
      rendered.renderer.destroy()
      jest.useRealTimers()
    }
  })

  test('account quota cache age shows just now below one minute', async () => {
    jest.setSystemTime(new Date(2026, 9, 4, 12, 34))
    let ageMs = 0
    const mounted = setup(
      { type: 'home' },
      {
        run: () => ({
          messages: [],
          snapshot: {
            kind: 'quota',
            accounts: [
              {
                label: 'Account 1',
                state: 'active',
                current: 'both',
                gemini: { remainingPercent: null, windows: [] },
                nonGemini: { remainingPercent: null, windows: [] },
                cacheUpdatedAt: Date.now() - ageMs,
              },
            ],
          },
        }),
      },
    )
    const rendered = await testRender(() => mounted.renderPage!() as never, {
      width: 80,
      height: 30,
    })
    try {
      const quota = mounted.commands.find(
        (command) => command.slash?.name === 'antigravity-quota',
      )!
      for (const [age, label] of [
        [0, 'just now'],
        [59_999, 'just now'],
        [60_000, '1m ago'],
      ] as const) {
        ageMs = age
        await quota.run()
        await Bun.sleep(0)
        await rendered.flush()
        expect(rendered.captureCharFrame()).toContain(`Quota cache: ${label}`)
      }
    } finally {
      await mounted.cleanup?.()
      rendered.renderer.destroy()
      jest.useRealTimers()
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
        expect(frame).toContain('5h · 63% · reset in 59m')
        expect(frame).toContain('Weekly · 8% · reset in 6d0h')
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
      expect(frame).toContain('Reset in 0m')
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

describe('OpenCode 2 quota sidebar', () => {
  test('same-session directory changes refresh RPC scope and fence stale sync completion', async () => {
    const syncResolvers: Array<{ resolve: () => void; reject: () => void }> = []
    const mounted = setup(
      { type: 'session', sessionID: 'same-session' },
      { sidebarQuota: sidebarSnapshot(62) },
      {
        directory: '/workspace/first',
        sessionDirectories: { 'same-session': '/workspace/first' },
        syncSession: () =>
          new Promise<void>((resolve, reject) =>
            syncResolvers.push({ resolve, reject }),
          ),
      },
    )
    mounted.selectModel('same-session', {
      providerID: 'google',
      id: 'gemini-3.8-flash',
    })
    const rendered = await testRender(
      () => mounted.renderSidebar!({ sessionID: 'same-session' }) as never,
      { width: 40, height: 24 },
    )
    try {
      await Bun.sleep(0)
      mounted.setSessionLocation('same-session', '/workspace/second')
      await Bun.sleep(0)
      expect(syncResolvers).toHaveLength(2)
      syncResolvers[0]!.reject()
      syncResolvers[1]!.resolve()
      await Bun.sleep(0)
      await rendered.flush()
      expect(
        mounted.rpcLocations.filter(({ method }) => method === 'sidebarQuota'),
      ).toEqual([
        { method: 'sidebarQuota', directory: '/workspace/first' },
        { method: 'sidebarQuota', directory: '/workspace/first' },
        { method: 'sidebarQuota', directory: '/workspace/second' },
        { method: 'sidebarQuota', directory: '/workspace/second' },
      ])
      expect(rendered.captureCharFrame()).toContain('62%')
      expect(rendered.captureCharFrame()).not.toContain('Could not load')
    } finally {
      await mounted.cleanup?.()
      rendered.renderer.destroy()
    }
  })

  test('falls back to base text color when semantic theme colors are absent', async () => {
    const snapshot = sidebarSnapshot(20)
    const baseColor = RGBA.fromInts(238, 238, 238)
    const mutedColor = RGBA.fromInts(128, 128, 128)
    const mounted = setup(
      { type: 'session', sessionID: 'session-theme-fallback' },
      { sidebarQuota: snapshot },
      {},
      { text: { base: baseColor, muted: mutedColor }, border: {} },
    )
    mounted.selectModel('session-theme-fallback', {
      providerID: 'google',
      id: 'gemini-3.8-flash',
    })
    const rendered = await testRender(
      () =>
        mounted.renderSidebar!({
          sessionID: 'session-theme-fallback',
        }) as never,
      { width: 60, height: 24 },
    )
    try {
      await Bun.sleep(0)
      await rendered.flush()
      const spans = rendered.captureSpans().lines.flatMap((line) => line.spans)
      const find = (text: string) =>
        spans.find((span) => span.text.includes(text))!
      expect(find('Gm 5h').fg.toInts()).toEqual([238, 238, 238, 255])
      expect(find(' 20%').fg.toInts()).toEqual([238, 238, 238, 255])
      expect(find(' Default').fg.toInts()).toEqual([128, 128, 128, 255])
      expect(
        spans.find((span) => span.text.includes('5h'))!.fg.toInts(),
      ).toEqual([238, 238, 238, 255])
    } finally {
      await mounted.cleanup?.()
      rendered.renderer.destroy()
    }
  })

  test('keeps severity, exact percentages, and selected styling across boundaries', async () => {
    const snapshot = sidebarSnapshot(0)
    const summaryReset = Date.now() + 59 * 60_000
    const cells = [
      [0, 5],
      [19, 20],
      [21, 39],
      [40, 50],
      [59, 60],
      [90, 94],
      [95, 98],
      [99, 100],
      [null, null],
    ] as const
    snapshot.accounts = cells.map(([gemini, claude], index) => {
      const base = snapshot.accounts[index % snapshot.accounts.length]!
      const refreshState = ['refreshing', 'error', 'unavailable', 'idle'][
        index
      ]!
      return {
        ...base,
        label: `Boundary ${index + 1}`,
        gemini: {
          ...base.gemini,
          remainingPercent: gemini,
          resetAt: summaryReset,
          windows: [],
          refreshState: refreshState as
            | 'refreshing'
            | 'error'
            | 'unavailable'
            | 'idle',
        },
        nonGemini: {
          ...base.nonGemini,
          remainingPercent: claude,
          resetAt: summaryReset,
          windows: [],
          refreshState: refreshState as
            | 'refreshing'
            | 'error'
            | 'unavailable'
            | 'idle',
        },
      }
    })
    const mounted = setup(
      { type: 'session', sessionID: 'session-boundaries' },
      { sidebarQuota: snapshot },
    )
    mounted.selectModel('session-boundaries', {
      providerID: 'google',
      id: 'claude-opus-4-6-thinking',
    })
    const rendered = await testRender(
      () =>
        mounted.renderSidebar!({ sessionID: 'session-boundaries' }) as never,
      { width: 32, height: 100 },
    )
    try {
      await Bun.sleep(0)
      await rendered.flush()
      const frame = rendered.captureCharFrame()
      const frameLines = frame.split('\n')
      const quotaRows = frameLines.filter((line) => /^(Gm|NG) /.test(line))
      const expectedRows: Array<['Gm' | 'NG', number | null]> = cells.flatMap(
        ([gemini, nonGemini]) => [
          ['Gm', gemini],
          ['NG', nonGemini],
        ],
      )
      const expectedBars = [
        '▱▱▱▱▱▱▱▱▱▱',
        '▰▱▱▱▱▱▱▱▱▱',
        '▰▰▱▱▱▱▱▱▱▱',
        '▰▰▱▱▱▱▱▱▱▱',
        '▰▰▱▱▱▱▱▱▱▱',
        '▰▰▰▰▱▱▱▱▱▱',
        '▰▰▰▰▱▱▱▱▱▱',
        '▰▰▰▰▰▱▱▱▱▱',
        '▰▰▰▰▰▰▱▱▱▱',
        '▰▰▰▰▰▰▱▱▱▱',
        '▰▰▰▰▰▰▰▰▰▱',
        '▰▰▰▰▰▰▰▰▰▱',
        '▰▰▰▰▰▰▰▰▰▰',
        '▰▰▰▰▰▰▰▰▰▰',
        '▰▰▰▰▰▰▰▰▰▰',
        '▰▰▰▰▰▰▰▰▰▰',
        '──────────',
        '──────────',
      ]
      expect(quotaRows).toHaveLength(expectedRows.length)
      for (const [index, [label, value]] of expectedRows.entries()) {
        const line = quotaRows[index]!
        const percent =
          value === null ? '   —' : `${String(value).padStart(3)}%`
        expect(line.startsWith(`${label} `)).toBe(true)
        expect(line.slice(6, 16)).toBe(expectedBars[index]!)
        const rightStart = 32 - 11
        expect(line.slice(rightStart, rightStart + 4)).toBe(percent)
        expect(line[rightStart + 4]).toBe(' ')
        expect(line.slice(rightStart + 5, 32).trim()).toMatch(
          /^(?:5[89]m|1h0m)$/,
        )
      }
      expect(frame).toContain('refresh')
      expect(frame).toContain('failed')
      expect(frame).toContain('N/A')
      const cacheRows = frameLines
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => line.includes('Cached'))
      expect(cacheRows).toHaveLength(cells.length * 2 - 1)
      for (const { index } of cacheRows)
        expect(frameLines[index - 1]).toMatch(/^(Gm|NG) /)

      const spans = rendered.captureSpans()
      const textSpans = spans.lines.flatMap((line) => line.spans)
      const find = (value: string) =>
        textSpans.find((span) => span.text.includes(value))!
      const rgb = (value: string) => find(value).fg.toInts()
      expect(rgb('NG')).toEqual([250, 178, 131, 255])
      expect(find('NG').attributes).toBe(TextAttributes.BOLD)
      expect(rgb('0%')).toEqual([224, 108, 117, 255])
      expect(rgb('19%')).toEqual([224, 108, 117, 255])
      expect(rgb('20%')).toEqual([224, 108, 117, 255])
      expect(rgb('21%')).toEqual([245, 167, 66, 255])
      expect(rgb('50%')).toEqual([245, 167, 66, 255])
      expect(rgb('59%')).toEqual([127, 216, 143, 255])
      expect(rgb('60%')).toEqual([127, 216, 143, 255])
      expect(rgb('99%')).toEqual([127, 216, 143, 255])
      expect(rgb('100%')).toEqual([127, 216, 143, 255])
      expect(rgb('▱▱▱▱▱▱▱▱▱▱')).toEqual([224, 108, 117, 255])
      expect(rgb('▰▱▱▱▱▱▱▱▱▱')).toEqual([224, 108, 117, 255])
      expect(rgb('▰▰▱▱▱▱▱▱▱▱')).toEqual([224, 108, 117, 255])
      expect(rgb('▰▰▰▰▱▱▱▱▱▱')).toEqual([245, 167, 66, 255])
      expect(rgb('▰▰▰▰▰▰▱▱▱▱')).toEqual([127, 216, 143, 255])
      expect(rgb('▰▰▰▰▰▰▰▰▰▱')).toEqual([127, 216, 143, 255])
      expect(rgb('▰▰▰▰▰▰▰▰▰▰')).toEqual([127, 216, 143, 255])
      expect(rgb('──────────')).toEqual([128, 128, 128, 255])
      expect(frame.indexOf('Gm')).toBeLessThan(frame.indexOf('NG'))
    } finally {
      await mounted.cleanup?.()
      rendered.renderer.destroy()
    }
  })

  test('renders all-account quota groups and follows committed model changes', async () => {
    const mounted = setup(
      { type: 'session', sessionID: 'session-1' },
      { sidebarQuota: sidebarSnapshot(63) },
    )
    mounted.selectModel('session-1', {
      providerID: 'google',
      id: 'gemini-3.8-flash',
    })
    const [activeSession, setActiveSession] = createSignal('session-1')
    const slotInput = {
      get sessionID() {
        return activeSession()
      },
    }
    const rendered = await testRender(
      () => mounted.renderSidebar!(slotInput) as never,
      { width: 42, height: 36 },
    )
    try {
      await Bun.sleep(0)
      await rendered.flush()
      let frame = rendered.captureCharFrame()
      expect(frame).toContain('Antigravity')
      expect(frame).toContain('remaining')
      expect(frame).toContain('2 accounts · remaining')
      expect(frame).toContain('Gemini')
      expect(frame).toContain('Default account')
      expect(frame).toContain('Disabled account')
      expect(frame).toContain('Gm 5h')
      expect(frame).toContain('NG 5h')
      expect(frame).toContain('Gm 7d')
      expect(frame).toContain('63%')
      expect(frame).toContain('14%')
      expect(frame).toContain('Default')
      expect(mounted.sidebarCalls).toEqual(['cache', 'ensure'])

      mounted.selectModel('session-1', {
        providerID: 'google',
        id: 'claude-sonnet-4-6-thinking',
      })
      await rendered.flush()
      expect(rendered.captureCharFrame()).toContain('NG 5h')
      expect(rendered.captureCharFrame()).toContain('Claude/other')
      expect(mounted.sidebarCalls).toEqual(['cache', 'ensure'])

      mounted.selectModel('session-1', {
        providerID: 'openai',
        id: 'gemini-3.8-flash',
      })
      await rendered.flush()
      frame = rendered.captureCharFrame()
      expect(frame).not.toContain('Antigravity')

      mounted.selectModel('session-2', {
        providerID: 'google',
        id: 'claude-opus-4-6-thinking',
      })
      setActiveSession('session-2')
      await rendered.flush()
      expect(rendered.captureCharFrame()).toContain('Antigravity')
      expect(mounted.sidebarCalls).toEqual([
        'cache',
        'ensure',
        'cache',
        'ensure',
      ])
    } finally {
      await mounted.cleanup?.()
      rendered.renderer.destroy()
    }
  })

  test('matches Default badge and narrow label space to the selected account group', async () => {
    const base = sidebarSnapshot(41).accounts[0]!
    const snapshot = sidebarSnapshot(41)
    snapshot.accounts = [
      {
        ...base,
        label: 'Gemini Account With Long Name',
        current: 'gemini',
      },
      {
        ...base,
        label: 'Claude Account With Long Name',
        current: 'claude',
      },
      {
        ...base,
        label: 'Both Account With Long Name',
        current: 'both',
      },
      {
        ...base,
        label: 'No Current Account With Long Name',
        current: 'none',
      },
    ]
    const mounted = setup(
      { type: 'session', sessionID: 'session-default-group' },
      { sidebarQuota: snapshot },
    )
    mounted.selectModel('session-default-group', {
      providerID: 'google',
      id: 'gemini-3.8-flash',
    })
    const rendered = await testRender(
      () =>
        mounted.renderSidebar!({
          sessionID: 'session-default-group',
        }) as never,
      { width: 36, height: 50 },
    )
    try {
      await Bun.sleep(0)
      await rendered.flush()
      const linesFor = (frame: string, prefix: string) =>
        frame.split('\n').filter((line) => line.includes(prefix))
      let frame = rendered.captureCharFrame()
      let gemini = linesFor(frame, 'Gemini Account')[0]!
      let claude = linesFor(frame, 'Claude Account')[0]!
      let both = linesFor(frame, 'Both Account')[0]!
      let none = linesFor(frame, 'No Current')[0]!
      expect(gemini).toContain('Default')
      expect(claude).not.toContain('Default')
      expect(both).toContain('Default')
      expect(none).not.toContain('Default')
      expect(gemini).toContain('…')
      expect(gemini).not.toContain('Long Name')
      expect(claude).toContain('Long Name')

      mounted.selectModel('session-default-group', {
        providerID: 'google',
        id: 'claude-sonnet-4-6-thinking',
      })
      await rendered.flush()
      frame = rendered.captureCharFrame()
      gemini = linesFor(frame, 'Gemini Account')[0]!
      claude = linesFor(frame, 'Claude Account')[0]!
      both = linesFor(frame, 'Both Account')[0]!
      none = linesFor(frame, 'No Current')[0]!
      expect(gemini).not.toContain('Default')
      expect(claude).toContain('Default')
      expect(both).toContain('Default')
      expect(none).not.toContain('Default')
      expect(claude).toContain('…')
      expect(claude).not.toContain('Long Name')
      expect(gemini).toContain('Long Name')
      expect(frame).toContain('Gm 5h')
      expect(frame).toContain('NG 5h')
    } finally {
      await mounted.cleanup?.()
      rendered.renderer.destroy()
    }
  })

  test('formats reset countdowns across minute, hour, and day boundaries', async () => {
    jest.setSystemTime(new Date(2026, 9, 4, 12, 34))
    const fixedNow = Date.now()
    const durations = [
      0,
      59_999,
      60_000,
      3_599_999,
      3_600_000,
      86_399_999,
      86_400_000,
      6 * 24 * 60 * 60_000 + 4 * 60 * 60_000,
    ]
    const expected = ['0m', '0m', '1m', '59m', '1h0m', '23h59m', '1d0h', '6d4h']
    const baseSnapshot = sidebarSnapshot(100)
    const base = baseSnapshot.accounts[0]!
    baseSnapshot.accounts = Array.from({ length: 4 }, (_, index) => {
      const first = index * 2
      return {
        ...base,
        label: `Reset account ${index + 1}`,
        current: 'both',
        gemini: {
          ...base.gemini,
          updatedAt: fixedNow,
          windows: [
            {
              name: '5h',
              remainingPercent: 100,
              resetAt: fixedNow + durations[first]!,
            },
            {
              name: 'weekly',
              remainingPercent: 100,
              resetAt: fixedNow + durations[first + 1]!,
            },
          ],
        },
        nonGemini: {
          ...base.nonGemini,
          updatedAt: fixedNow,
          windows: [],
          resetAt: undefined,
        },
      }
    })
    const mounted = setup(
      { type: 'session', sessionID: 'session-reset-boundaries' },
      { sidebarQuota: baseSnapshot },
    )
    mounted.selectModel('session-reset-boundaries', {
      providerID: 'google',
      id: 'gemini-3.8-flash',
    })
    const rendered = await testRender(
      () =>
        mounted.renderSidebar!({
          sessionID: 'session-reset-boundaries',
        }) as never,
      { width: 32, height: 70 },
    )
    try {
      await Bun.sleep(0)
      await rendered.flush()
      const frame = rendered.captureCharFrame()
      for (const value of expected) expect(frame).toContain(value)
      expect(frame.replace(/\s/g, '')).toContain('remaining/resetin')
      expect(frame).toContain('Cached · 10-04 12:34 · just now')
      expect(frame).not.toContain('just now ago')
      await saveCapture('sidebar-reset-boundaries', rendered)
    } finally {
      await mounted.cleanup?.()
      rendered.renderer.destroy()
      jest.useRealTimers()
    }
  })

  test('deduplicates idle metadata only within matching account groups', async () => {
    const snapshot = sidebarSnapshot(63)
    snapshot.accounts[1] = {
      ...snapshot.accounts[1]!,
      gemini: { ...snapshot.accounts[1]!.gemini, source: 'live' },
    }
    snapshot.accounts.push({
      ...snapshot.accounts[0]!,
      label: 'Different timestamp account',
      gemini: { ...snapshot.accounts[0]!.gemini, updatedAt: Date.now() },
    })
    snapshot.accounts.push({
      ...snapshot.accounts[0]!,
      label: 'Mixed refresh account',
      gemini: { ...snapshot.accounts[0]!.gemini, refreshState: 'idle' },
      nonGemini: {
        ...snapshot.accounts[0]!.nonGemini,
        refreshState: 'unavailable',
      },
    })
    const mounted = setup(
      { type: 'session', sessionID: 'session-metadata' },
      { sidebarQuota: snapshot },
    )
    mounted.selectModel('session-metadata', {
      providerID: 'google',
      id: 'gemini-3.8-flash',
    })
    const rendered = await testRender(
      () => mounted.renderSidebar!({ sessionID: 'session-metadata' }) as never,
      { width: 40, height: 44 },
    )
    try {
      await Bun.sleep(0)
      await rendered.flush()
      const lines = rendered.captureCharFrame().split('\n')
      const cachedDetails = lines.filter((line) => line.includes('Cached ·'))
      expect(cachedDetails).toHaveLength(6)
      expect(lines.filter((line) => line.includes('Live ·'))).toHaveLength(1)
      expect(lines.filter((line) => line.includes('N/A'))).toHaveLength(1)
      const accountLines = lines.filter((line) =>
        line.includes('Mixed refresh account'),
      )
      expect(accountLines).toHaveLength(1)
      const accountIndex = lines.indexOf(accountLines[0]!)
      expect(
        lines
          .slice(accountIndex + 1)
          .filter((line) => line.includes('Cached ·')),
      ).toHaveLength(2)
      expect(
        lines.slice(accountIndex + 1).filter((line) => line.includes('N/A')),
      ).toHaveLength(1)
    } finally {
      await mounted.cleanup?.()
      rendered.renderer.destroy()
    }
  })

  test('shows local success time and wraps long age at the measured slot width', async () => {
    jest.setSystemTime(new Date(2026, 9, 3, 6, 32))
    const snapshot = sidebarSnapshot(63)
    const successAt = new Date(2026, 9, 1, 6, 34).getTime()
    const localSuccess = new Date(successAt)
    const expectedDate = `${String(localSuccess.getMonth() + 1).padStart(2, '0')}-${String(localSuccess.getDate()).padStart(2, '0')} ${String(localSuccess.getHours()).padStart(2, '0')}:${String(localSuccess.getMinutes()).padStart(2, '0')}`
    snapshot.accounts = [
      {
        ...snapshot.accounts[0]!,
        gemini: { ...snapshot.accounts[0]!.gemini, updatedAt: successAt },
        nonGemini: { ...snapshot.accounts[0]!.nonGemini, updatedAt: successAt },
      },
    ]
    const mounted = setup(
      { type: 'session', sessionID: 'session-success-time' },
      { sidebarQuota: snapshot },
    )
    mounted.selectModel('session-success-time', {
      providerID: 'google',
      id: 'gemini-3.8-flash',
    })
    const rendered = await testRender(
      () =>
        mounted.renderSidebar!({ sessionID: 'session-success-time' }) as never,
      { width: 32, height: 24 },
    )
    try {
      await Bun.sleep(0)
      await rendered.flush()
      const lines = rendered.captureCharFrame().split('\n')
      const metadataIndex = lines.findIndex((line) =>
        line.includes(`Cached · ${expectedDate}`),
      )
      expect(metadataIndex).toBeGreaterThanOrEqual(0)
      expect(lines[metadataIndex]!.trim()).toBe(`Cached · ${expectedDate}`)
      expect(lines[metadataIndex + 1]!.trim()).toBe('47h58m ago')
      expect(lines.filter((line) => line.includes(expectedDate))).toHaveLength(
        1,
      )
    } finally {
      await mounted.cleanup?.()
      rendered.renderer.destroy()
      jest.useRealTimers()
    }
  })

  test('unknown or invalid success timestamps never invent an attempt time', async () => {
    const snapshot = sidebarSnapshot(63)
    const unknown = {
      ...snapshot.accounts[0]!,
      gemini: { ...snapshot.accounts[0]!.gemini, updatedAt: undefined },
      nonGemini: { ...snapshot.accounts[0]!.nonGemini, updatedAt: undefined },
    }
    const invalid = {
      ...snapshot.accounts[0]!,
      label: 'Invalid timestamp account',
      gemini: { ...snapshot.accounts[0]!.gemini, updatedAt: Number.MAX_VALUE },
      nonGemini: {
        ...snapshot.accounts[0]!.nonGemini,
        updatedAt: Number.MAX_VALUE,
      },
    }
    snapshot.accounts = [unknown, invalid]
    const mounted = setup(
      { type: 'session', sessionID: 'session-unknown-time' },
      { sidebarQuota: snapshot },
    )
    mounted.selectModel('session-unknown-time', {
      providerID: 'google',
      id: 'gemini-3.8-flash',
    })
    const rendered = await testRender(
      () =>
        mounted.renderSidebar!({ sessionID: 'session-unknown-time' }) as never,
      { width: 40, height: 32 },
    )
    try {
      await Bun.sleep(0)
      await rendered.flush()
      const frame = rendered.captureCharFrame()
      expect(frame.match(/Cached · update unknown/g)).toHaveLength(2)
      expect(frame).not.toContain('Infinity')
    } finally {
      await mounted.cleanup?.()
      rendered.renderer.destroy()
    }
  })

  test('keeps compact rows readable at narrow sidebar widths', async () => {
    for (const { outerWidth, slotWidth } of [
      { outerWidth: 32, slotWidth: 32 },
      { outerWidth: 40, slotWidth: 40 },
      { outerWidth: 120, slotWidth: 32 },
    ]) {
      const snapshot = sidebarSnapshot(63)
      snapshot.accounts[1] = {
        ...snapshot.accounts[1]!,
        label: 'Disabled account',
        state: 'disabled',
        current: 'both',
        gemini: { ...snapshot.accounts[1]!.gemini, windows: [] },
        nonGemini: {
          ...snapshot.accounts[1]!.nonGemini,
          windows: [],
          resetAt: Date.now() + 47 * 60 * 60_000 + 59 * 60_000,
        },
      }
      snapshot.accounts.push(
        {
          ...snapshot.accounts[1]!,
          label: 'Verification Required Account',
          state: 'verification-required',
          current: 'both',
          gemini: {
            ...snapshot.accounts[1]!.gemini,
            windows: [],
            resetAt: Date.now() + 59 * 60_000,
          },
        },
        {
          ...snapshot.accounts[1]!,
          label: 'Ineligible Account Long',
          state: 'ineligible',
          current: 'both',
          nonGemini: {
            ...snapshot.accounts[1]!.nonGemini,
            resetAt: undefined,
          },
        },
      )
      const sessionID = `sidebar-width-${outerWidth}-${slotWidth}`
      const mounted = setup(
        { type: 'session', sessionID },
        { sidebarQuota: snapshot },
      )
      mounted.selectModel(sessionID, {
        providerID: 'google',
        id: 'gemini-3.8-flash',
      })
      const rendered = await testRender(
        () => {
          const sidebar = mounted.renderSidebar!({ sessionID })
          return outerWidth === slotWidth
            ? (sidebar as never)
            : (jsx('box', { width: slotWidth, children: sidebar }) as never)
        },
        { width: outerWidth, height: 40 },
      )
      try {
        await Bun.sleep(0)
        await rendered.flush()
        const frame = rendered.captureCharFrame()
        const lines = frame.split('\n')
        const headerIndex = lines.findIndex((line) =>
          line.includes('Antigravity'),
        )
        expect(headerIndex).toBeGreaterThanOrEqual(0)
        const header = lines[headerIndex]!.slice(0, slotWidth)
        expect(header.trimEnd().endsWith('Gemini')).toBe(true)
        expect(header.indexOf('Gemini')).toBe(slotWidth - 'Gemini'.length)
        expect(lines[headerIndex + 1]).toContain('accounts · remaining / reset')
        for (const [label, status] of [
          ['Default account', 'ACTIVE Default'],
          ['Disabled', 'DISABLED Default'],
          ['Verification', 'VERIFY Default'],
          ['Ineligible', 'INELIGIBLE Default'],
        ] as const) {
          expect(
            lines.some((line) => line.includes(label) && line.includes(status)),
          ).toBe(true)
        }
        expect(frame).toContain('Gm 5h')
        expect(frame).toContain('NG 7d')
        const quotaRows = lines.filter((line) => /^(Gm|NG) /.test(line))
        expect(quotaRows.length).toBeGreaterThan(0)
        const rightStart = slotWidth - 11
        for (const line of quotaRows) {
          expect(line.slice(6, 16)).toMatch(/^(?:[▰▱]){10}|^─{10}$/)
          const percent = line.slice(rightStart, rightStart + 4)
          expect(percent.endsWith('%') || percent.endsWith('—')).toBe(true)
          expect(line[rightStart + 4]).toBe(' ')
          const reset = line.slice(slotWidth - 6, slotWidth).trim()
          if (reset)
            expect(line.slice(slotWidth - reset.length, slotWidth)).toBe(reset)
          if (percent.endsWith('%'))
            expect(line.indexOf('%')).toBe(slotWidth - 8)
          expect(line).not.toMatch(/[│╭╮╰╯┌┐└┘]/)
        }
        const resetLabels = quotaRows
          .map((line) => line.slice(slotWidth - 6, slotWidth).trim())
          .filter(Boolean)
        expect(resetLabels.some((label) => /^1d23h$/.test(label))).toBe(true)
        expect(resetLabels.some((label) => /^(?:59m|1h0m)$/.test(label))).toBe(
          true,
        )
        expect(resetLabels.some((label) => /^[34]d\d+h$/.test(label))).toBe(
          true,
        )
        const noReset = quotaRows.find(
          (line) =>
            line.startsWith('NG   ') &&
            !line.slice(slotWidth - 6, slotWidth).trim(),
        )!
        expect(noReset.slice(rightStart, rightStart + 4)).toBe(' 22%')
        expect(noReset.slice(slotWidth - 6, slotWidth).trim()).toBe('')
        for (const { index } of lines
          .map((line, index) => ({ line, index }))
          .filter(({ line }) => line.includes('Cached')))
          expect(lines[index - 1]).toMatch(/^(Gm|NG) /)
        await saveCapture(`sidebar-${outerWidth}-${slotWidth}`, rendered)
      } finally {
        await mounted.cleanup?.()
        rendered.renderer.destroy()
      }
    }
  })

  test('wraps quota rows and sidebar fields at narrow measured widths', async () => {
    jest.setSystemTime(new Date(2026, 9, 4, 12, 34))
    const fixedNow = Date.now()
    try {
      for (const width of [32, 27, 26, 16, 15, 10, 8]) {
        const snapshot = sidebarSnapshot(63)
        const base = snapshot.accounts[0]!
        const updatedAt = fixedNow - 59_999
        snapshot.accounts = [
          {
            ...base,
            label: 'Account Long',
            state: 'verification-required',
            current: 'both',
            gemini: {
              ...base.gemini,
              updatedAt,
              windows: [
                {
                  name: '5h',
                  remainingPercent: 100,
                  resetAt: fixedNow + 60_000,
                },
                {
                  name: 'weekly',
                  remainingPercent: null,
                  resetAt: fixedNow + 4 * 24 * 60 * 60_000,
                },
              ],
            },
            nonGemini: {
              ...base.nonGemini,
              updatedAt,
              windows: [
                {
                  name: '5h',
                  remainingPercent: 63,
                  resetAt: fixedNow + 60_000,
                },
                {
                  name: 'weekly',
                  remainingPercent: null,
                  resetAt: fixedNow + 4 * 24 * 60 * 60_000,
                },
              ],
            },
          },
        ]
        const sessionID = `sidebar-wrap-${width}`
        const mounted = setup(
          { type: 'session', sessionID },
          {
            sidebarQuota: async ({ mode }) => {
              if (mode === 'cache') return snapshot
              throw new Error('offline')
            },
          },
        )
        mounted.selectModel(sessionID, {
          providerID: 'google',
          id: 'claude-sonnet-4-6-thinking',
        })
        const rendered = await testRender(
          () => mounted.renderSidebar!({ sessionID }) as never,
          { width, height: 90 },
        )
        try {
          await Bun.sleep(0)
          await Bun.sleep(0)
          await rendered.flush()
          const frame = rendered.captureCharFrame()
          const compact = frame.replace(/\s/g, '')
          const lines = frame.split('\n')
          expect(lines.every((line) => line.length <= width)).toBe(true)
          expect(compact).toContain('AntigravityClaude/other')
          expect(compact).toContain('AccountLong')
          expect(compact).toContain('VERIFYDefault')
          expect(compact).toContain('Gm5h')
          expect(compact).toContain('Gm7d')
          expect(compact).toContain('NG5h')
          expect(compact).toContain('NG7d')
          expect(compact).toContain('remaining/resetin')
          expect(compact).toContain('100%')
          expect(compact).toContain('63%')
          expect(compact).toContain('—')
          expect(compact).toContain('Quotarefreshfailed')
          expect(compact).toContain('Cached')
          expect(compact).toContain('10-0412:33')
          expect(compact).toContain('justnow')
          expect(compact).not.toContain('justnowago')
          expect(compact).toContain('4d')

          const expectedBars = new Map([
            ['Gm 5h', '▰'.repeat(10)],
            ['Gm 7d', '─'.repeat(10)],
            ['NG 5h', `${'▰'.repeat(6)}${'▱'.repeat(4)}`],
            ['NG 7d', '─'.repeat(10)],
          ])
          const rowLabels = [...expectedBars.keys()]
          for (const [index, [label, expected]] of [
            ...expectedBars,
          ].entries()) {
            const start = lines.findIndex((line) => line.includes(label))
            expect(start).toBeGreaterThanOrEqual(0)
            const nextStart = rowLabels
              .slice(index + 1)
              .map((nextLabel) =>
                lines.findIndex((line) => line.includes(nextLabel)),
              )
              .find((lineIndex) => lineIndex > start)
            const segment = lines.slice(start, nextStart ?? lines.length)
            const cells = segment.join('').match(/[▰▱─]/g)?.join('') ?? ''
            expect(cells).toBe(expected)
            const rowLines = segment.filter((line) => line.trim().length > 0)
            const percentLine = rowLines.find((line) =>
              line.includes(
                label === 'NG 5h' ? ' 63%' : label === 'Gm 5h' ? '100%' : '—',
              ),
            )
            expect(percentLine).toBeDefined()
            const resetLine = rowLines.find((line) =>
              line.includes(label.endsWith('5h') ? '1m' : '4d'),
            )
            expect(resetLine).toBeDefined()
            if (width < 11) expect(percentLine).not.toBe(resetLine)
            else expect(percentLine).toBe(resetLine)
          }
          await saveCapture(`sidebar-wrap-${width}`, rendered)
        } finally {
          await mounted.cleanup?.()
          rendered.renderer.destroy()
        }
      }
    } finally {
      jest.useRealTimers()
    }
  })

  test('keeps cached values on transport failure and ignores hidden late results', async () => {
    let resolveEnsure!: (value: SidebarQuotaSnapshot) => void
    const mounted = setup(
      { type: 'session', sessionID: 'session-2' },
      {
        sidebarQuota: ({ mode }) =>
          mode === 'cache'
            ? Promise.resolve(sidebarSnapshot(41))
            : new Promise((resolve) => {
                resolveEnsure = resolve
              }),
      },
    )
    mounted.selectModel('session-2', {
      providerID: 'google',
      id: 'claude-opus-4-6-thinking',
    })
    const rendered = await testRender(
      () => mounted.renderSidebar!({ sessionID: 'session-2' }) as never,
      { width: 48, height: 40 },
    )
    try {
      await Bun.sleep(0)
      await rendered.flush()
      expect(rendered.captureCharFrame()).toContain('41%')
      mounted.selectModel('session-2', {
        providerID: 'openai',
        id: 'other-model',
      })
      resolveEnsure(sidebarSnapshot(99, 'live'))
      await Bun.sleep(0)
      await rendered.flush()
      const hiddenFrame = rendered.captureCharFrame()
      expect(hiddenFrame).not.toContain('Antigravity')
      expect(hiddenFrame).not.toContain('99%')
    } finally {
      await mounted.cleanup?.()
      rendered.renderer.destroy()
    }
  })

  test('preserves cache age and hides raw transport errors after refresh failure', async () => {
    const mounted = setup(
      { type: 'session', sessionID: 'session-4' },
      {
        sidebarQuota: async ({ mode }) => {
          if (mode === 'cache') return sidebarSnapshot(27)
          throw new Error('sensitive transport detail')
        },
      },
    )
    mounted.selectModel('session-4', {
      providerID: 'google',
      id: 'gemini-3.6-flash',
    })
    const rendered = await testRender(
      () => mounted.renderSidebar!({ sessionID: 'session-4' }) as never,
      { width: 42, height: 36 },
    )
    try {
      await Bun.sleep(0)
      await rendered.flush()
      const frame = rendered.captureCharFrame()
      expect(frame).toContain('27%')
      expect(frame).toContain('Cached ·')
      expect(frame).toContain(' ago')
      expect(frame).toContain('Quota refresh failed')
      expect(frame).not.toContain('sensitive transport detail')
    } finally {
      await mounted.cleanup?.()
      rendered.renderer.destroy()
    }
  })

  test('shared clock advances cached sidebar age and reset countdown after refresh failure', async () => {
    let now = 1_800_000_000_000
    const dateNowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now)
    const intervalSpy = jest.spyOn(globalThis, 'setInterval')
    const mounted = setup(
      { type: 'session', sessionID: 'session-clock' },
      {
        sidebarQuota: async ({ mode }) => {
          if (mode === 'cache') return sidebarSnapshot(41)
          throw new Error('unavailable')
        },
      },
    )
    mounted.selectModel('session-clock', {
      providerID: 'google',
      id: 'gemini-3.6-flash',
    })
    const rendered = await testRender(
      () => mounted.renderSidebar!({ sessionID: 'session-clock' }) as never,
      { width: 60, height: 36 },
    )
    try {
      await Bun.sleep(0)
      await Bun.sleep(0)
      await rendered.flush()
      const before = rendered.captureCharFrame()
      expect(before).toContain('41%')
      expect(before).toContain('Cached ·')
      expect(before).toContain('1m ago')
      expect(before).toContain('1h')
      expect(before).toContain('Quota refresh failed')
      expect(mounted.sidebarCalls).toEqual(['cache', 'ensure'])

      now += 60_000
      const clockCall = intervalSpy.mock.calls.find(
        ([, delay]) => delay === 60_000,
      )
      expect(clockCall).toBeDefined()
      ;(clockCall![0] as () => void)()
      await rendered.flush()
      const after = rendered.captureCharFrame()
      expect(after).toContain('41%')
      expect(after).toContain('2m ago')
      expect(after).toContain('59m')
      expect(after).toContain('Quota refresh failed')
      expect(mounted.sidebarCalls).toEqual(['cache', 'ensure'])
    } finally {
      await mounted.cleanup?.()
      rendered.renderer.destroy()
      intervalSpy.mockRestore()
      dateNowSpy.mockRestore()
    }
  })

  test('keeps cache-first polling serialized while RPC results are pending', async () => {
    let resolveCache!: (value: SidebarQuotaSnapshot) => void
    const resolveEnsures: Array<(value: SidebarQuotaSnapshot) => void> = []
    const pollCallbacks: Array<() => void> = []
    const clockCallbacks: Array<() => void> = []
    let now = 1_800_000_000_000
    const dateNowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now)
    const scheduled = jest.spyOn(globalThis, 'setInterval')
    scheduled.mockImplementation(((handler: TimerHandler, delay?: number) => {
      if (delay === 15_000 && typeof handler === 'function')
        pollCallbacks.push(handler as () => void)
      if (delay === 60_000 && typeof handler === 'function')
        clockCallbacks.push(handler as () => void)
      return 1 as never
    }) as typeof setInterval)
    const mounted = setup(
      { type: 'session', sessionID: 'session-overlap' },
      {
        sidebarQuota: ({ mode }) =>
          mode === 'cache'
            ? new Promise((resolve) => {
                resolveCache = resolve
              })
            : new Promise((resolve) => resolveEnsures.push(resolve)),
      },
    )
    mounted.selectModel('session-overlap', {
      providerID: 'google',
      id: 'gemini-3.8-flash',
    })
    const rendered = await testRender(
      () => mounted.renderSidebar!({ sessionID: 'session-overlap' }) as never,
      { width: 48, height: 36 },
    )
    try {
      await Bun.sleep(0)
      expect(mounted.sidebarCalls).toEqual(['cache'])
      pollCallbacks[0]!()
      await Bun.sleep(0)
      expect(mounted.sidebarCalls).toEqual(['cache'])

      resolveCache(sidebarSnapshot(12))
      await Bun.sleep(0)
      expect(mounted.sidebarCalls).toEqual(['cache', 'ensure'])
      expect(resolveEnsures).toHaveLength(1)
      await rendered.flush()
      const before = rendered.captureCharFrame()
      expect(before).toContain('12%')
      expect(before).toContain('1m ago')
      expect(before).toContain('1h0m')
      pollCallbacks[0]!()
      await Bun.sleep(0)
      expect(mounted.sidebarCalls).toEqual(['cache', 'ensure'])

      now += 60_000
      expect(clockCallbacks).toHaveLength(1)
      clockCallbacks[0]!()
      await rendered.flush()
      const after = rendered.captureCharFrame()
      expect(after).toContain('12%')
      expect(after).toContain('2m ago')
      expect(after).toContain('59m')
      expect(mounted.sidebarCalls).toEqual(['cache', 'ensure'])
      expect(resolveEnsures).toHaveLength(1)

      resolveEnsures[0]!(sidebarSnapshot(30, 'live'))
      await Bun.sleep(0)
      await rendered.flush()
      expect(rendered.captureCharFrame()).toContain('30%')
      pollCallbacks[0]!()
      await Bun.sleep(0)
      expect(mounted.sidebarCalls).toEqual(['cache', 'ensure', 'ensure'])
      expect(resolveEnsures).toHaveLength(2)
      resolveEnsures[1]!(sidebarSnapshot(45, 'live'))
      await Bun.sleep(0)
      await rendered.flush()
      expect(rendered.captureCharFrame()).toContain('45%')
    } finally {
      rendered.renderer.destroy()
      await mounted.cleanup?.()
      scheduled.mockRestore()
      dateNowSpy.mockRestore()
    }
  })

  test('reports session hydration failure safely and waits for a valid model', async () => {
    const mounted = setup(
      { type: 'session', sessionID: 'session-hydration' },
      { sidebarQuota: sidebarSnapshot(12) },
      {
        syncSession: async () => {
          throw new Error('private model sync failure')
        },
      },
    )
    mounted.selectModel('session-hydration', {
      providerID: 'google',
      id: 'gemini-3.8-flash',
    })
    const rendered = await testRender(
      () => mounted.renderSidebar!({ sessionID: 'session-hydration' }) as never,
      { width: 48, height: 40 },
    )
    try {
      await Bun.sleep(0)
      await rendered.flush()
      const frame = rendered.captureCharFrame()
      expect(frame).toContain('Default account')
      expect(frame).toContain('Could not load the selected session model yet.')
      expect(frame).not.toContain('private model sync failure')
      expect(mounted.sidebarCalls).toEqual(['cache', 'ensure'])
    } finally {
      rendered.renderer.destroy()
      await mounted.cleanup?.()
    }
  })

  test('unknown and third-party provider models never activate the sidebar', async () => {
    const mounted = setup(
      { type: 'session', sessionID: 'session-3' },
      {
        sidebarQuota: sidebarSnapshot(10),
      },
    )
    mounted.selectModel('session-3', {
      providerID: 'google',
      id: 'gemini-unknown',
    })
    const rendered = await testRender(
      () => mounted.renderSidebar!({ sessionID: 'session-3' }) as never,
      { width: 42, height: 16 },
    )
    try {
      await Bun.sleep(0)
      await rendered.flush()
      expect(rendered.captureCharFrame()).not.toContain('Antigravity')
      expect(mounted.sidebarCalls).toEqual([])
      mounted.selectModel('session-3', {
        providerID: 'google',
        id: 'gemini-3.7-flash',
      })
      await rendered.flush()
      expect(mounted.sidebarCalls).toEqual(['cache', 'ensure'])
    } finally {
      await mounted.cleanup?.()
      rendered.renderer.destroy()
    }
  })

  test('unmount stops polling and removes the session model listener', async () => {
    const scheduled = jest.spyOn(globalThis, 'setInterval')
    const canceled = jest.spyOn(globalThis, 'clearInterval')
    const mounted = setup(
      { type: 'session', sessionID: 'session-cleanup' },
      { sidebarQuota: sidebarSnapshot(10) },
    )
    mounted.selectModel('session-cleanup', {
      providerID: 'google',
      id: 'gemini-3.8-flash',
    })
    const rendered = await testRender(
      () => mounted.renderSidebar!({ sessionID: 'session-cleanup' }) as never,
      { width: 42, height: 20 },
    )
    try {
      await Bun.sleep(0)
      expect(scheduled).toHaveBeenCalled()
      const callsBeforeUnmount = mounted.sidebarCalls.length
      rendered.renderer.destroy()
      expect(canceled).toHaveBeenCalled()
      mounted.selectModel('session-cleanup', {
        providerID: 'google',
        id: 'claude-sonnet-4-6-thinking',
      })
      await Bun.sleep(0)
      expect(mounted.sidebarCalls).toHaveLength(callsBeforeUnmount)
    } finally {
      await mounted.cleanup?.()
      rendered.renderer.destroy()
      scheduled.mockRestore()
      canceled.mockRestore()
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
