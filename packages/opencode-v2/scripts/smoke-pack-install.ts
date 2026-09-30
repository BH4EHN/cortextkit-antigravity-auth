import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { Host } from '@opencode-ai/plugin/host'

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../../../')
const PACKAGE_ROOT = join(REPO_ROOT, 'packages/opencode-v2')
const CORE_ROOT = join(REPO_ROOT, 'packages/core')
const PACKAGE_NAME = '@cortexkit/opencode-v2-antigravity-auth'

type Rendered = {
  flush(): Promise<void>
  captureCharFrame(): string
  renderer: { destroy(): void }
}

type TuiHandlers = {
  run(input: { name: string; args: string }): Promise<Record<string, unknown>>
  operation(input: { operationId: string }): Promise<Record<string, unknown>>
}

type TuiRoute =
  | { type: 'home' }
  | { type: 'session'; sessionID: string }
  | { type: 'plugin'; name: string }

type TuiCommand = {
  id?: string
  bind?: false | string
  slash?: { name: string }
  run(args?: string): void | Promise<void>
}

type TuiLayer = {
  mode?: string
  priority?: number
  enabled?: boolean | (() => boolean)
  commands: TuiCommand[]
}

async function settle(rendered: Rendered): Promise<string> {
  await Bun.sleep(0)
  await rendered.flush()
  return rendered.captureCharFrame()
}

function assertContains(frame: string, value: string, context: string): void {
  if (!frame.includes(value)) {
    throw new Error(
      `${context}: rendered TUI did not contain ${JSON.stringify(value)}\n${frame}`,
    )
  }
}

async function verifyInstalledTui(
  consumerDir: string,
  tuiEntry: string,
): Promise<void> {
  const solid = (await import(
    pathToFileURL(join(consumerDir, 'node_modules/@opentui/solid/index.bun.js'))
      .href
  )) as {
    testRender(
      render: () => unknown,
      options: { width: number; height: number },
    ): Promise<Rendered>
  }
  const tuiModule = (await import(tuiEntry)) as {
    default?: { setup(ctx: never): () => void }
  }
  const setupTui = tuiModule.default?.setup
  if (typeof setupTui !== 'function') {
    throw new Error(
      'Installed TUI artifact has no setup function for rendering',
    )
  }

  let handlers: TuiHandlers = {
    run: async () => ({ messages: [] }),
    operation: async () => ({ state: 'complete', messages: [] }),
  }
  const layers: TuiLayer[] = []
  let route: TuiRoute = { type: 'home' }
  let panel: { name: string; sessionID: string } | undefined
  let page: (() => unknown) | undefined
  const ctx = {
    client: {
      rpc: () => ({
        run: (input: { name: string; args: string }) => handlers.run(input),
        operation: (input: { operationId: string }) =>
          handlers.operation(input),
      }),
    },
    keymap: {
      layer: (create: () => TuiLayer) => {
        layers.push(create())
      },
    },
    ui: {
      router: {
        current: () => route,
        register: (input: { render(): unknown }) => {
          page = input.render
          return () => {}
        },
        navigate: (destination: TuiRoute) => {
          route = destination
        },
      },
      panel: {
        open: (name: string) => {
          if (route.type === 'session')
            panel = { name, sessionID: route.sessionID }
          return true
        },
        current: () => panel,
        close: () => {
          panel = undefined
        },
      },
      slot: (input: { append: string; render(): unknown }) => {
        if (input.append === 'app') input.render()
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
  const cleanup = setupTui(ctx as never)
  if (!page) throw new Error('Installed TUI artifact did not register its page')
  const command = (name: string) => {
    const found = layers
      .flatMap((layer) => layer.commands)
      .find((entry) => entry.slash?.name === name)
    if (!found) throw new Error(`Installed TUI artifact omitted /${name}`)
    return found
  }
  const closeLayer = layers.find((layer) =>
    layer.commands.some((entry) => entry.id === 'antigravity.close'),
  )
  const closeCommand = closeLayer?.commands.find(
    (entry) => entry.id === 'antigravity.close',
  )
  if (
    !closeLayer ||
    !closeCommand ||
    closeLayer.mode !== 'base' ||
    closeLayer.priority !== 1 ||
    closeCommand.bind !== 'escape'
  ) {
    throw new Error('Installed TUI artifact omitted the scoped Esc close layer')
  }

  const rendered = await solid.testRender(() => page!(), {
    width: 80,
    height: 26,
  })
  try {
    assertContains(await settle(rendered), 'Esc: Close', 'close footer')
    command('antigravity-quota').run()
    await settle(rendered)
    const isCloseEnabled = closeLayer.enabled
    if (
      route.type !== 'plugin' ||
      typeof isCloseEnabled !== 'function' ||
      !isCloseEnabled()
    ) {
      throw new Error('Installed TUI close layer was not enabled on its page')
    }
    closeCommand.run()
    if (route.type !== 'home') {
      throw new Error('Installed TUI Esc close did not return its page home')
    }

    let resolveQuota!: (value: Record<string, unknown>) => void
    handlers = {
      run: async ({ name }) => {
        if (name !== 'quota') return { messages: [] }
        return new Promise((resolve) => {
          resolveQuota = resolve
        })
      },
      operation: async () => ({ state: 'complete', messages: [] }),
    }
    command('antigravity-quota').run()
    assertContains(await settle(rendered), 'QUOTA · LOADING', 'quota loading')
    const resetAt = Date.now() + 3_300_000
    resolveQuota({
      messages: ['Quota refreshed'],
      snapshot: {
        kind: 'quota',
        accounts: [
          {
            label: 'Installed account',
            state: 'active',
            current: 'both',
            gemini: {
              remainingPercent: 63,
              resetAt,
              windows: [
                {
                  name: '5h',
                  remainingPercent: 63,
                  resetAt,
                },
              ],
            },
            nonGemini: { remainingPercent: null, windows: [] },
          },
        ],
      },
    })
    let frame = await settle(rendered)
    assertContains(frame, '63% remaining', 'quota card')
    assertContains(frame, 'resets ', 'quota reset')

    handlers = {
      run: async () => {
        throw new Error('renderer RPC unavailable')
      },
      operation: async () => ({ state: 'complete', messages: [] }),
    }
    command('antigravity-quota').run()
    frame = await settle(rendered)
    assertContains(frame, 'Notice', 'RPC error notice')
    assertContains(frame, 'renderer RPC unavailable', 'RPC error notice')

    handlers = {
      run: async () => ({
        messages: [
          'Open this URL to authorize: https://accounts.example/oauth',
        ],
        operationId: 'installed-operation',
      }),
      operation: async () => ({
        state: 'complete',
        messages: ['OAuth account added'],
        snapshot: {
          kind: 'account',
          accounts: [
            {
              label: 'OAuth account',
              state: 'active',
              current: 'gemini',
              gemini: { remainingPercent: 75, windows: [] },
              nonGemini: { remainingPercent: null, windows: [] },
            },
          ],
        },
      }),
    }
    command('antigravity-account').run('add')
    frame = await settle(rendered)
    assertContains(frame, 'OAuth account added', 'OAuth completion')
    assertContains(frame, 'OAuth account', 'OAuth account card')

    let resolveOperation!: (value: Record<string, unknown>) => void
    handlers = {
      run: async ({ name }) =>
        name === 'account'
          ? { messages: ['OAuth pending'], operationId: 'stale-operation' }
          : {
              messages: [],
              snapshot: {
                kind: 'status',
                pool: {
                  total: 3,
                  enabled: 2,
                  disabled: 1,
                  ineligible: 0,
                  verificationRequired: 0,
                },
                current: { claude: 'Status Claude', gemini: 'Status Gemini' },
                quotaCache: { oldestAgeMs: null },
                paths: {
                  accountsFile: '/tmp/accounts.json',
                  logFile: '/tmp/agy.log',
                },
              },
            },
      operation: async () =>
        new Promise((resolve) => {
          resolveOperation = resolve
        }),
    }
    command('antigravity-account').run('add')
    await settle(rendered)
    command('antigravity-status').run()
    await settle(rendered)
    resolveOperation({
      state: 'complete',
      messages: ['Late OAuth completion'],
      snapshot: { kind: 'account', accounts: [] },
    })
    frame = await settle(rendered)
    assertContains(frame, 'Current family accounts', 'newer status view')
    assertContains(frame, 'Claude: Status Claude', 'newer status view')
    if (frame.includes('Late OAuth completion')) {
      throw new Error('Late OAuth completion replaced the newer status view')
    }
  } finally {
    cleanup()
    rendered.renderer.destroy()
  }
}

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`,
    )
  }
  return result.stdout
}

function pack(packageRoot: string, destination: string): string {
  const output = run(
    process.execPath,
    ['pm', 'pack', '--destination', destination],
    packageRoot,
  )
  const tarball = output
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.endsWith('.tgz') && existsSync(line))
  if (!tarball) {
    throw new Error(`bun pm pack did not report a tarball for ${packageRoot}`)
  }
  return tarball
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'agy-opencode2-pack-'))
  try {
    const packDir = join(root, 'pack')
    const consumerDir = join(root, 'consumer')
    mkdirSync(packDir, { recursive: true })
    mkdirSync(consumerDir, { recursive: true })

    const coreTarball = pack(CORE_ROOT, packDir)
    const adapterTarball = pack(PACKAGE_ROOT, packDir)
    writeFileSync(
      join(consumerDir, 'package.json'),
      `${JSON.stringify(
        {
          name: 'antigravity-opencode2-pack-consumer',
          private: true,
          type: 'module',
          dependencies: {
            [PACKAGE_NAME]: adapterTarball,
            '@opentui/core': '0.5.10',
            '@opentui/solid': '0.5.10',
            'solid-js': '^1.9.0',
          },
          overrides: {
            '@cortexkit/antigravity-auth-core': coreTarball,
          },
        },
        null,
        2,
      )}\n`,
    )
    run(process.execPath, ['install', '--no-save'], consumerDir)

    const resolved = Host.resolve({
      directory: consumerDir,
      name: PACKAGE_NAME,
    })
    if (!resolved.server) {
      throw new Error(
        'OpenCode 2 host resolver did not discover a server entry',
      )
    }
    if (!resolved.tui || !resolved.rpc) {
      throw new Error(
        'OpenCode 2 host resolver did not discover TUI and RPC entries',
      )
    }
    if (
      existsSync(join(consumerDir, 'node_modules', '@opencode-ai', 'plugin'))
    ) {
      throw new Error(
        'Packed adapter unexpectedly installed the host plugin SDK',
      )
    }
    const installedRoot = join(
      consumerDir,
      'node_modules',
      '@cortexkit',
      'opencode-v2-antigravity-auth',
    )
    const directoryEntries = Host.resolve({ directory: installedRoot })
    if (
      !directoryEntries.server ||
      !directoryEntries.tui ||
      !directoryEntries.rpc
    ) {
      throw new Error(
        'Packed directory plugin did not expose all host entrypoints',
      )
    }
    const directoryTui = (await import(directoryEntries.tui)) as {
      default?: { setup?: unknown }
    }
    if (typeof directoryTui.default?.setup !== 'function') {
      throw new Error('Packed directory TUI entry has no setup function')
    }
    const resolvedPath = realpathSync(fileURLToPath(resolved.server))
    const installedPath = realpathSync(installedRoot)
    const installedRelative = relative(installedPath, resolvedPath)
    if (installedRelative.startsWith('..') || isAbsolute(installedRelative)) {
      throw new Error(
        `Host resolver escaped installed package: ${resolved.server}`,
      )
    }
    const manifest = JSON.parse(
      readFileSync(join(installedRoot, 'package.json'), 'utf8'),
    ) as { files?: string[]; 'oc-plugin'?: string[] }
    if (
      !manifest.files?.includes('dist/') ||
      !manifest.files.includes('index.js') ||
      !manifest.files.includes('tui.js') ||
      !manifest.files.includes('rpc.js') ||
      !manifest.files.includes('CHANGELOG.md') ||
      manifest['oc-plugin']?.join(',') !== 'server,tui'
    ) {
      throw new Error('Packed OpenCode 2 manifest lost its server contract')
    }
    const module = (await import(resolved.server)) as {
      default?: { setup?: unknown }
    }
    if (typeof module.default?.setup !== 'function') {
      throw new Error('Packed OpenCode 2 server entry has no setup function')
    }
    const tuiModule = (await import(resolved.tui)) as {
      default?: { tui?: unknown }
    }
    if (typeof tuiModule.default?.setup !== 'function') {
      throw new Error('Packed OpenCode 2 TUI entry has no setup function')
    }
    const rpcModule = (await import(resolved.rpc)) as {
      default?: { id?: unknown }
    }
    if (typeof rpcModule.default?.id !== 'string') {
      throw new Error('Packed OpenCode 2 RPC entry is invalid')
    }
    run(
      process.execPath,
      [
        '--preload',
        join(consumerDir, 'node_modules/@opentui/solid/scripts/preload.js'),
        fileURLToPath(import.meta.url),
        '--render-probe',
        consumerDir,
        resolved.tui,
      ],
      consumerDir,
    )

    console.log(
      `[smoke:pack] OK — packed package resolved through Host.resolve at ${resolved.server}`,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

if (process.argv[2] === '--render-probe') {
  const consumerDir = process.argv[3]
  const tuiEntry = process.argv[4]
  if (!consumerDir || !tuiEntry) {
    throw new Error('TUI render probe requires a consumer directory and entry')
  }
  await verifyInstalledTui(consumerDir, tuiEntry)
} else {
  await main()
}
