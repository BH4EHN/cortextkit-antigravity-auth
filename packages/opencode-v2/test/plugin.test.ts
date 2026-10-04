import { describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  loadAccountStorage,
  mutateAccountStorage,
} from '@cortexkit/antigravity-auth-core'
import type { SessionHttpRequest } from '@opencode-ai/plugin/promise/session'
import type { AntigravityPanelSnapshot } from '../src/commands.ts'

import plugin, {
  createOpenCodeV2AntigravityPlugin,
  upsertOAuthAccount,
} from '../src/plugin.ts'
import { encodeRpcOutput } from './rpc-output-codec.ts'

function successResponse(): Response {
  return new Response(
    `data: ${JSON.stringify({
      response: {
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'title' }] },
            finishReason: 'STOP',
          },
        ],
      },
    })}\n\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
}

describe('opencode-v2-antigravity-auth plugin entry', () => {
  test('exports the plugin contract shape', () => {
    expect(plugin).toBeTypeOf('object')
    expect(plugin.id).toBe('cortexkit.antigravity-auth')
    expect(plugin.setup).toBeTypeOf('function')
  })

  test('stores the bare OAuth refresh token while preserving account identity state', () => {
    const result = upsertOAuthAccount(
      {
        version: 4,
        accounts: [
          {
            email: 'account@example.test',
            refreshToken: 'old-refresh',
            projectId: 'old-project',
            addedAt: 1,
            lastUsed: 2,
            enabled: false,
            rateLimitResetTimes: {},
            accountIneligible: true,
            accountIneligibleReason: 'ACCOUNT_INELIGIBLE',
          },
        ],
        activeIndex: 0,
        activeIndexByFamily: { claude: 0, gemini: 0 },
      },
      {
        type: 'success',
        refresh: 'new-refresh|new-project|managed-project',
        access: 'new-access',
        expires: 100,
        email: 'account@example.test',
        projectId: 'new-project',
      },
      50,
    )

    expect(result.accounts).toHaveLength(1)
    expect(result.accounts[0]).toMatchObject({
      refreshToken: 'new-refresh',
      projectId: 'new-project',
      managedProjectId: 'managed-project',
      addedAt: 1,
      lastUsed: 50,
      enabled: true,
      accountIneligible: false,
      verificationRequired: false,
    })
    expect(result.accounts[0]?.accountIneligibleReason).toBeUndefined()
    expect(result.accounts[0]?.verificationRequiredReason).toBeUndefined()
    expect(result.activeIndexByFamily).toEqual({ claude: 0, gemini: 0 })
  })

  test('rejects OAuth completion when account persistence fails', async () => {
    type OAuthMethodDefinition = {
      authorize: () => Promise<{ callback: Promise<unknown> }>
    }
    let oauthMethod: OAuthMethodDefinition | undefined
    const adapter = createOpenCodeV2AntigravityPlugin({
      authorizeAntigravity: async () => ({
        url: 'https://accounts.example/authorize?state=oauth-state',
        verifier: 'oauth-verifier',
        projectId: '',
      }),
      waitForAntigravityCode: async (state) => {
        expect(state).toBe('oauth-state')
        return 'oauth-code'
      },
      exchangeAntigravity: async () => ({
        type: 'success',
        refresh: 'oauth-refresh|oauth-project',
        access: 'oauth-access',
        expires: Date.now() + 60_000,
        projectId: 'oauth-project',
      }),
      mutateAccountStorage: async () => {
        throw new Error('disk write failed')
      },
    })
    const registration = { dispose: async () => {} }
    const cleanup = await adapter.setup({
      rpc: { register: async () => registration },
      session: {
        hook: async () => registration,
      },
      integration: {
        transform: async (transform: unknown) => {
          ;(
            transform as (draft: {
              method: {
                update: (definition: OAuthMethodDefinition) => void
              }
            }) => void
          )({
            method: {
              update: (definition) => {
                oauthMethod = definition
              },
            },
          })
          return registration
        },
      },
    } as never)

    try {
      expect(oauthMethod).toBeDefined()
      const authorization = await oauthMethod!.authorize()
      await expect(authorization.callback).rejects.toThrow(
        'could not be confirmed',
      )
    } finally {
      if (cleanup) await cleanup()
    }
  })

  test('routes the host title model through a supported Antigravity model', async () => {
    const configDir = process.env.OPENCODE_CONFIG_DIR
    if (!configDir) throw new Error('OPENCODE_CONFIG_DIR is not set')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(
      join(configDir, 'antigravity-accounts.json'),
      `${JSON.stringify({
        version: 4,
        accounts: [
          {
            refreshToken: 'title-refresh',
            projectId: 'title-project',
            addedAt: 1,
            lastUsed: 0,
            enabled: true,
            rateLimitResetTimes: {},
          },
        ],
        activeIndex: 0,
        activeIndexByFamily: { claude: 0, gemini: 0 },
      })}\n`,
    )

    let httpRequestHook:
      | ((event: SessionHttpRequest) => Promise<void>)
      | undefined
    let routedModel: string | undefined
    const adapter = createOpenCodeV2AntigravityPlugin({
      refreshAntigravityToken: async (refresh) => ({
        refresh,
        access: 'title-access',
        expires: Date.now() + 60_000,
      }),
      ensureProjectContext: async (auth) => ({
        auth,
        projectId: 'title-project',
        effectiveProjectId: 'title-project',
      }),
      send: async ({ envelope }) => {
        routedModel = envelope.model
        return successResponse()
      },
    })
    const registration = { dispose: async () => {} }
    const cleanup = await adapter.setup({
      rpc: { register: async () => registration },
      session: {
        hook: async (name: string, callback: unknown) => {
          if (name === 'http.request') {
            httpRequestHook = callback as (
              event: SessionHttpRequest,
            ) => Promise<void>
          }
          return registration
        },
      },
      integration: {
        transform: async () => registration,
      },
    } as never)

    try {
      const event = {
        sessionID: 'title-session',
        agent: 'title-agent',
        model: {
          providerID: 'google',
          id: 'gemini-3.5-flash-lite',
        },
        kind: 'title',
        request: new Request(
          'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:streamGenerateContent?alt=sse',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              contents: [{ role: 'user', parts: [{ text: 'Create title' }] }],
            }),
          },
        ),
      }
      expect(httpRequestHook).toBeTypeOf('function')
      await httpRequestHook!(event as never)
      expect(new URL(event.request.url).hostname).toBe('127.0.0.1')
      const response = await fetch(event.request)
      expect(response.ok).toBe(true)
      expect(await response.text()).toContain('title')
      expect(routedModel).toBe('gemini-3.5-flash-extra-low')
    } finally {
      if (cleanup) await cleanup()
    }
  })
})

function seedPool(
  accounts: Array<Record<string, unknown>>,
  activeIndex = 0,
): string {
  const configDir = process.env.OPENCODE_CONFIG_DIR
  if (!configDir) throw new Error('OPENCODE_CONFIG_DIR is not set')
  mkdirSync(configDir, { recursive: true })
  const file = join(configDir, 'antigravity-accounts.json')
  writeFileSync(
    file,
    `${JSON.stringify({
      version: 4,
      accounts,
      activeIndex,
      activeIndexByFamily: { claude: activeIndex, gemini: activeIndex },
    })}\n`,
  )
  return file
}

interface CapturedCommands {
  httpRequestHook: (event: SessionHttpRequest) => Promise<void>
  promptHook: (event: { prompt: { text: string } }) => Promise<void>
  modelRequestHook: (event: { sessionID: string }) => Promise<void>
  hookNames: string[]
  outputs: Array<{ sessionID: string; text: string }>
  run: (input: {
    name: 'account' | 'quota' | 'status'
    args: string
  }) => Promise<{
    messages: string[]
    notices?: string[]
    operationId?: string
    snapshot?: AntigravityPanelSnapshot
  }>
  operation: (input: { operationId: string }) => Promise<{
    state: string
    messages: string[]
    notices?: string[]
    snapshot?: AntigravityPanelSnapshot
  }>
  cleanup: () => Promise<void>
}

async function setupCapturingCommands(
  options: {
    waitForCode?: () => Promise<string>
    loadAccountStorage?: NonNullable<
      Parameters<typeof createOpenCodeV2AntigravityPlugin>[0]
    >['loadAccountStorage']
    mutateAccountStorage?: NonNullable<
      Parameters<typeof createOpenCodeV2AntigravityPlugin>[0]
    >['mutateAccountStorage']
    send?: NonNullable<
      Parameters<typeof createOpenCodeV2AntigravityPlugin>[0]
    >['send']
    refreshAntigravityToken?: NonNullable<
      Parameters<typeof createOpenCodeV2AntigravityPlugin>[0]
    >['refreshAntigravityToken']
    ensureProjectContext?: NonNullable<
      Parameters<typeof createOpenCodeV2AntigravityPlugin>[0]
    >['ensureProjectContext']
    contextMessages?: Array<{ type: 'user'; text: string }>
  } = {},
): Promise<CapturedCommands> {
  const adapter = createOpenCodeV2AntigravityPlugin({
    loadAccountStorage: options.loadAccountStorage,
    mutateAccountStorage: options.mutateAccountStorage,
    send: options.send,
    refreshAntigravityToken: options.refreshAntigravityToken,
    ensureProjectContext: options.ensureProjectContext,
    authorizeAntigravity: async () => ({
      url: 'https://accounts.example/authorize?state=cmd-state',
      verifier: 'v',
      projectId: '',
    }),
    waitForAntigravityCode: async () => options.waitForCode?.() ?? 'cmd-code',
    exchangeAntigravity: async () => ({
      type: 'success' as const,
      refresh: 'cmd-refresh|cmd-project',
      access: 'cmd-access',
      expires: Date.now() + 60_000,
      projectId: 'cmd-project',
    }),
  })
  const outputs: Array<{ sessionID: string; text: string }> = []
  let rpcRun: CapturedCommands['run'] | undefined
  let rpcOperation: CapturedCommands['operation'] | undefined
  let promptHook: CapturedCommands['promptHook'] | undefined
  let modelRequestHook: CapturedCommands['modelRequestHook'] | undefined
  let httpRequestHook: CapturedCommands['httpRequestHook'] | undefined
  const hookNames: string[] = []
  const registration = { dispose: async () => {} }
  const cleanup = await adapter.setup({
    rpc: {
      register: async (
        _definition: unknown,
        handlers: {
          run: CapturedCommands['run']
          operation: CapturedCommands['operation']
        },
      ) => {
        rpcRun = handlers.run
        rpcOperation = handlers.operation
        return registration
      },
    },
    session: {
      hook: async (name: string, callback: unknown) => {
        hookNames.push(name)
        if (name === 'prompt')
          promptHook = callback as CapturedCommands['promptHook']
        if (name === 'model.request')
          modelRequestHook = callback as CapturedCommands['modelRequestHook']
        if (name === 'http.request')
          httpRequestHook = callback as CapturedCommands['httpRequestHook']
        return registration
      },
      context: async () => options.contextMessages ?? [],
    },
    integration: { transform: async () => registration },
    command: {
      transform: async () => {
        throw new Error('Server must not register duplicate TUI commands')
      },
    },
  } as never)
  return {
    httpRequestHook: httpRequestHook!,
    promptHook: promptHook!,
    modelRequestHook: modelRequestHook!,
    hookNames,
    outputs,
    run: rpcRun!,
    operation: rpcOperation!,
    cleanup: async () => {
      if (cleanup) await cleanup()
    },
  }
}

async function runCommand(
  captured: CapturedCommands,
  name: string,
  text: string,
): Promise<void> {
  const before = captured.outputs.length
  const result = await captured.run({
    name: name.replace('antigravity-', '') as 'account' | 'quota' | 'status',
    args: text,
  })
  captured.outputs.push(
    ...result.messages.map((message) => ({ sessionID: 'rpc', text: message })),
  )
  expect(captured.outputs.length).toBeGreaterThan(before)
}

async function sendTitle(
  captured: CapturedCommands,
  sessionID = 'transition-session',
): Promise<Response> {
  const event = {
    sessionID,
    agent: 'title-agent',
    model: { providerID: 'google', id: 'gemini-3.5-flash-lite' },
    kind: 'title',
    request: new Request(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:streamGenerateContent?alt=sse',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'title' }] }],
        }),
      },
    ),
  }
  await captured.httpRequestHook(event as SessionHttpRequest)
  return fetch(event.request)
}

function transitionPool(): void {
  seedPool([
    {
      refreshToken: 'pool-a',
      projectId: 'project-a',
      addedAt: 1,
      lastUsed: 0,
      enabled: true,
      rateLimitResetTimes: {},
    },
    {
      refreshToken: 'pool-b',
      projectId: 'project-b',
      addedAt: 2,
      lastUsed: 0,
      enabled: true,
      rateLimitResetTimes: {},
    },
  ])
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('opencode-v2 slash commands', () => {
  test('reselects an enabled account after project lookup and pool removal', async () => {
    transitionPool()
    const project = deferred<void>()
    const entered = deferred<void>()
    const sent: string[] = []
    const captured = await setupCapturingCommands({
      refreshAntigravityToken: async (refresh) => ({
        refresh,
        access: refresh,
        expires: Date.now() + 600_000,
      }),
      ensureProjectContext: async (auth) => {
        if (auth.access === 'pool-a') {
          entered.resolve()
          await project.promise
        }
        return { auth, projectId: 'project', effectiveProjectId: 'project' }
      },
      send: async ({ auth }) => {
        sent.push(auth.access ?? '')
        return successResponse()
      },
    })
    try {
      const pending = sendTitle(captured)
      await entered.promise
      await captured.run({ name: 'account', args: 'remove 1 confirm' })
      project.resolve()
      expect((await pending).ok).toBe(true)
      expect(sent).toEqual(['pool-b'])
    } finally {
      project.resolve()
      await captured.cleanup()
    }
  })

  test('waits for an in-progress mutation before sending with B', async () => {
    transitionPool()
    const project = deferred<void>()
    const enteredProject = deferred<void>()
    const mutation = deferred<void>()
    const enteredMutation = deferred<void>()
    const sent: string[] = []
    const captured = await setupCapturingCommands({
      mutateAccountStorage: async (path, mutator) => {
        enteredMutation.resolve()
        await mutation.promise
        return mutateAccountStorage(path, mutator)
      },
      refreshAntigravityToken: async (refresh) => ({
        refresh,
        access: refresh,
        expires: Date.now() + 600_000,
      }),
      ensureProjectContext: async (auth) => {
        if (auth.access === 'pool-a') {
          enteredProject.resolve()
          await project.promise
        }
        return { auth, projectId: 'project', effectiveProjectId: 'project' }
      },
      send: async ({ auth }) => {
        sent.push(auth.access ?? '')
        return successResponse()
      },
    })
    try {
      const pending = sendTitle(captured)
      await enteredProject.promise
      const removal = captured.run({
        name: 'account',
        args: 'remove 1 confirm',
      })
      await enteredMutation.promise
      project.resolve()
      await Bun.sleep(5)
      expect(sent).toEqual([])
      mutation.resolve()
      await removal
      expect((await pending).ok).toBe(true)
      expect(sent).toEqual(['pool-b'])
    } finally {
      project.resolve()
      mutation.resolve()
      await captured.cleanup()
    }
  })

  test('a new request waits for mutation settlement then selects B', async () => {
    transitionPool()
    const mutation = deferred<void>()
    const entered = deferred<void>()
    const sent: string[] = []
    const captured = await setupCapturingCommands({
      mutateAccountStorage: async (path, mutator) => {
        entered.resolve()
        await mutation.promise
        return mutateAccountStorage(path, mutator)
      },
      refreshAntigravityToken: async (refresh) => ({
        refresh,
        access: refresh,
        expires: Date.now() + 600_000,
      }),
      ensureProjectContext: async (auth) => ({
        auth,
        projectId: 'project',
        effectiveProjectId: 'project',
      }),
      send: async ({ auth }) => {
        sent.push(auth.access ?? '')
        return successResponse()
      },
    })
    try {
      const disable = captured.run({ name: 'account', args: 'disable 1' })
      await entered.promise
      const pending = sendTitle(captured)
      await Bun.sleep(5)
      expect(sent).toEqual([])
      mutation.resolve()
      await disable
      expect((await pending).ok).toBe(true)
      expect(sent).toEqual(['pool-b'])
    } finally {
      mutation.resolve()
      await captured.cleanup()
    }
  })

  for (const blocked of [
    'accountIneligible',
    'verificationRequired',
  ] as const) {
    test(`historical enabled A with ${blocked} does not block B`, async () => {
      seedPool([
        {
          refreshToken: 'pool-a',
          projectId: 'project-a',
          addedAt: 1,
          lastUsed: 0,
          enabled: true,
          [blocked]: true,
          rateLimitResetTimes: {},
        },
        {
          refreshToken: 'pool-b',
          projectId: 'project-b',
          addedAt: 2,
          lastUsed: 0,
          enabled: true,
          rateLimitResetTimes: {},
        },
      ])
      const sent: string[] = []
      const captured = await setupCapturingCommands({
        refreshAntigravityToken: async (refresh) => ({
          refresh,
          access: refresh,
          expires: Date.now() + 600_000,
        }),
        ensureProjectContext: async (auth) => ({
          auth,
          projectId: 'project',
          effectiveProjectId: 'project',
        }),
        send: async ({ auth }) => {
          sent.push(auth.access ?? '')
          return successResponse()
        },
      })
      try {
        expect((await sendTitle(captured)).ok).toBe(true)
        expect(sent).toEqual(['pool-b'])
      } finally {
        await captured.cleanup()
      }
    })
  }

  test('discards stale refresh metadata after same-token pool reload', async () => {
    transitionPool()
    const refresh = deferred<void>()
    const entered = deferred<void>()
    let refreshes = 0
    const sent: Array<{ access: string | undefined; project: string }> = []
    const captured = await setupCapturingCommands({
      mutateAccountStorage: (path, mutator) =>
        mutateAccountStorage(path, async (current) => {
          const next = await mutator(current)
          if (!next) return undefined
          return {
            ...next,
            accounts: next.accounts.map((entry) =>
              entry.refreshToken === 'pool-a'
                ? { ...entry, projectId: 'new-project' }
                : entry,
            ),
          }
        }),
      refreshAntigravityToken: async (token) => {
        refreshes++
        if (refreshes === 1) {
          entered.resolve()
          await refresh.promise
        }
        return {
          refresh: token,
          access: `access-${refreshes}`,
          expires: Date.now() + 600_000,
        }
      },
      ensureProjectContext: async (auth) => ({
        auth,
        projectId: 'project',
        effectiveProjectId: auth.refresh.includes('new-project')
          ? 'new-project'
          : 'old-project',
      }),
      send: async ({ auth, envelope }) => {
        sent.push({ access: auth.access, project: envelope.project })
        return successResponse()
      },
    })
    try {
      const pending = sendTitle(captured)
      await entered.promise
      await captured.run({ name: 'account', args: 'use 1' })
      refresh.resolve()
      expect((await pending).ok).toBe(true)
      expect(refreshes).toBe(2)
      expect(sent).toEqual([{ access: 'access-2', project: 'new-project' }])
    } finally {
      refresh.resolve()
      await captured.cleanup()
    }
  })

  test('rotated no-email A remains the same command target during deferred project', async () => {
    const file = seedPool([
      {
        refreshToken: 'pool-a',
        projectId: 'project-a',
        addedAt: 1,
        lastUsed: 0,
        enabled: true,
        rateLimitResetTimes: {},
      },
      {
        refreshToken: 'pool-b',
        projectId: 'project-b',
        addedAt: 2,
        lastUsed: 0,
        enabled: true,
        rateLimitResetTimes: {},
      },
    ])
    const project = deferred<void>()
    const entered = deferred<void>()
    const sent: string[] = []
    const captured = await setupCapturingCommands({
      refreshAntigravityToken: async (refresh) => ({
        refresh: refresh === 'pool-a' ? 'pool-a-rotated' : refresh,
        access: refresh === 'pool-a' ? 'rotated-access' : refresh,
        expires: Date.now() + 600_000,
      }),
      ensureProjectContext: async (auth) => {
        if (auth.access === 'rotated-access') {
          entered.resolve()
          await project.promise
        }
        return { auth, projectId: 'project', effectiveProjectId: 'project' }
      },
      send: async ({ auth }) => {
        sent.push(auth.access ?? '')
        return successResponse()
      },
    })
    try {
      const pending = sendTitle(captured)
      await entered.promise
      const before = JSON.parse(readFileSync(file, 'utf8')) as {
        accounts: Array<{ refreshToken: string }>
      }
      expect(before.accounts.map((entry) => entry.refreshToken)).toEqual([
        'pool-a-rotated',
        'pool-b',
      ])
      await captured.run({ name: 'account', args: 'disable 1' })
      project.resolve()
      expect((await pending).ok).toBe(true)
      expect(sent).toEqual(['pool-b'])
      const after = JSON.parse(readFileSync(file, 'utf8')) as {
        accounts: Array<{ refreshToken: string; enabled: boolean }>
      }
      expect(
        after.accounts.map((entry) => [entry.refreshToken, entry.enabled]),
      ).toEqual([
        ['pool-a-rotated', false],
        ['pool-b', true],
      ])
    } finally {
      project.resolve()
      await captured.cleanup()
    }
  })

  test('remove targets rotated no-email A once without resurrecting its old row', async () => {
    const file = seedPool([
      {
        refreshToken: 'pool-a',
        projectId: 'project-a',
        addedAt: 1,
        lastUsed: 0,
        enabled: true,
        rateLimitResetTimes: {},
      },
      {
        refreshToken: 'pool-b',
        projectId: 'project-b',
        addedAt: 2,
        lastUsed: 0,
        enabled: true,
        rateLimitResetTimes: {},
      },
    ])
    const project = deferred<void>()
    const entered = deferred<void>()
    const sent: string[] = []
    const captured = await setupCapturingCommands({
      refreshAntigravityToken: async (refresh) => ({
        refresh: refresh === 'pool-a' ? 'pool-a-rotated' : refresh,
        access: refresh === 'pool-a' ? 'rotated-access' : refresh,
        expires: Date.now() + 600_000,
      }),
      ensureProjectContext: async (auth) => {
        if (auth.access === 'rotated-access') {
          entered.resolve()
          await project.promise
        }
        return { auth, projectId: 'project', effectiveProjectId: 'project' }
      },
      send: async ({ auth }) => {
        sent.push(auth.access ?? '')
        return successResponse()
      },
    })
    try {
      const pending = sendTitle(captured)
      await entered.promise
      await captured.run({ name: 'account', args: 'remove 1 confirm' })
      project.resolve()
      expect((await pending).ok).toBe(true)
      expect(sent).toEqual(['pool-b'])
    } finally {
      project.resolve()
      await captured.cleanup()
    }
    const stored = JSON.parse(readFileSync(file, 'utf8')) as {
      accounts: Array<{ refreshToken: string }>
    }
    expect(stored.accounts.map((entry) => entry.refreshToken)).toEqual([
      'pool-b',
    ])
  })

  test('failed rotation readback leaves old A excluded and B available', async () => {
    const file = seedPool([
      {
        refreshToken: 'pool-a',
        projectId: 'project-a',
        addedAt: 1,
        lastUsed: 0,
        enabled: true,
        rateLimitResetTimes: {},
      },
      {
        refreshToken: 'pool-b',
        projectId: 'project-b',
        addedAt: 2,
        lastUsed: 0,
        enabled: true,
        rateLimitResetTimes: {},
      },
    ])
    let writes = 0
    const sent: string[] = []
    const captured = await setupCapturingCommands({
      mutateAccountStorage: async () => {
        writes++
        throw new Error('rotation not written')
      },
      refreshAntigravityToken: async (refresh) => ({
        refresh: refresh === 'pool-a' ? 'pool-a-rotated' : refresh,
        access: refresh,
        expires: Date.now() + 600_000,
      }),
      ensureProjectContext: async (auth) => ({
        auth,
        projectId: 'project',
        effectiveProjectId: 'project',
      }),
      send: async ({ auth }) => {
        sent.push(auth.access ?? '')
        return successResponse()
      },
    })
    try {
      expect((await sendTitle(captured)).ok).toBe(true)
      expect(sent).toEqual(['pool-b'])
      expect(writes).toBe(1)
    } finally {
      await captured.cleanup()
    }
    const stored = JSON.parse(readFileSync(file, 'utf8')) as {
      accounts: Array<{ refreshToken: string }>
    }
    expect(stored.accounts.map((entry) => entry.refreshToken)).toEqual([
      'pool-a',
      'pool-b',
    ])
  })

  test('write-then-error rotation is reconciled once from the durable pool', async () => {
    const file = seedPool([
      {
        refreshToken: 'pool-a',
        projectId: 'project-a',
        addedAt: 1,
        lastUsed: 0,
        enabled: true,
        rateLimitResetTimes: {},
      },
      {
        refreshToken: 'pool-b',
        projectId: 'project-b',
        addedAt: 2,
        lastUsed: 0,
        enabled: true,
        rateLimitResetTimes: {},
      },
    ])
    let writes = 0
    const sent: string[] = []
    const captured = await setupCapturingCommands({
      mutateAccountStorage: async (path, mutator) => {
        writes++
        await mutateAccountStorage(path, mutator)
        throw new Error('rotation acknowledgement lost')
      },
      refreshAntigravityToken: async (refresh) => ({
        refresh: refresh === 'pool-a' ? 'pool-a-rotated' : refresh,
        access: refresh,
        expires: Date.now() + 600_000,
      }),
      ensureProjectContext: async (auth) => ({
        auth,
        projectId: 'project',
        effectiveProjectId: 'project',
      }),
      send: async ({ auth }) => {
        sent.push(auth.access ?? '')
        return successResponse()
      },
    })
    try {
      expect((await sendTitle(captured)).ok).toBe(true)
      expect(writes).toBe(1)
      expect(sent).toEqual(['pool-a'])
    } finally {
      await captured.cleanup()
    }
    const stored = JSON.parse(readFileSync(file, 'utf8')) as {
      accounts: Array<{ refreshToken: string }>
    }
    expect(stored.accounts.map((entry) => entry.refreshToken)).toEqual([
      'pool-a-rotated',
      'pool-b',
    ])
  })

  test('forced 401 refresh stays once per logical account across token rotation', async () => {
    const file = seedPool([
      {
        refreshToken: 'pool-a',
        projectId: 'project-a',
        addedAt: 1,
        lastUsed: 0,
        enabled: true,
        rateLimitResetTimes: {},
      },
      {
        refreshToken: 'pool-b',
        projectId: 'project-b',
        addedAt: 2,
        lastUsed: 0,
        enabled: true,
        rateLimitResetTimes: {},
      },
    ])
    const refreshed: string[] = []
    const sent: string[] = []
    const captured = await setupCapturingCommands({
      refreshAntigravityToken: async (refresh) => {
        refreshed.push(refresh)
        return {
          refresh:
            refresh === 'pool-a' &&
            refreshed.filter((token) => token === 'pool-a').length === 2
              ? 'pool-a-rotated'
              : refresh,
          access:
            refresh === 'pool-b' ? 'pool-b' : `pool-a-${refreshed.length}`,
          expires: Date.now() + 600_000,
        }
      },
      ensureProjectContext: async (auth) => ({
        auth,
        projectId: 'project',
        effectiveProjectId: 'project',
      }),
      send: async ({ auth }) => {
        sent.push(auth.access ?? '')
        return auth.access === 'pool-b'
          ? successResponse()
          : new Response(JSON.stringify({ error: { message: 'expired' } }), {
              status: 401,
            })
      },
    })
    try {
      expect((await sendTitle(captured)).ok).toBe(true)
      expect(refreshed).toEqual(['pool-a', 'pool-a', 'pool-b'])
      expect(sent).toEqual(['pool-a-1', 'pool-a-2', 'pool-b'])
    } finally {
      await captured.cleanup()
    }
    const stored = JSON.parse(readFileSync(file, 'utf8')) as {
      accounts: Array<{ refreshToken: string }>
    }
    expect(stored.accounts.map((entry) => entry.refreshToken)).toEqual([
      'pool-a-rotated',
      'pool-b',
    ])
  })

  test('late old-token success records usage on surviving rotated A', async () => {
    const file = seedPool([
      {
        refreshToken: 'pool-a',
        projectId: 'project-a',
        addedAt: 1,
        lastUsed: 0,
        enabled: true,
        rateLimitResetTimes: {},
      },
      {
        refreshToken: 'pool-b',
        projectId: 'project-b',
        addedAt: 2,
        lastUsed: 0,
        enabled: false,
        rateLimitResetTimes: {},
      },
    ])
    const first = deferred<Response>()
    const entered = deferred<void>()
    let aRefreshes = 0
    const sent: string[] = []
    const captured = await setupCapturingCommands({
      refreshAntigravityToken: async (refresh) => {
        if (refresh === 'pool-a') {
          aRefreshes++
          return {
            refresh: aRefreshes === 1 ? 'pool-a' : 'pool-a-rotated',
            access: `pool-a-${aRefreshes}`,
            expires: Date.now() + (aRefreshes === 1 ? 30_000 : 600_000),
          }
        }
        return { refresh, access: refresh, expires: Date.now() + 600_000 }
      },
      ensureProjectContext: async (auth) => ({
        auth,
        projectId: 'project',
        effectiveProjectId: 'project',
      }),
      send: async ({ auth }) => {
        sent.push(auth.access ?? '')
        if (auth.access === 'pool-a-1') {
          entered.resolve()
          return first.promise
        }
        return successResponse()
      },
    })
    try {
      const pending = sendTitle(captured, 'first-session')
      await entered.promise
      expect((await sendTitle(captured, 'second-session')).ok).toBe(true)
      first.resolve(successResponse())
      expect((await pending).ok).toBe(true)
      expect(sent).toEqual(['pool-a-1', 'pool-a-2'])
    } finally {
      first.resolve(successResponse())
      await captured.cleanup()
    }
    const stored = JSON.parse(readFileSync(file, 'utf8')) as {
      accounts: Array<{
        refreshToken: string
        dailyRequestCounts?: { gemini: number }
      }>
    }
    expect(stored.accounts.map((entry) => entry.refreshToken)).toEqual([
      'pool-a-rotated',
      'pool-b',
    ])
    expect(stored.accounts[0]?.dailyRequestCounts?.gemini).toBe(2)
  })

  test('finishes an already sent success after removal without sending B', async () => {
    transitionPool()
    const upstream = deferred<Response>()
    const entered = deferred<void>()
    const sent: string[] = []
    const captured = await setupCapturingCommands({
      refreshAntigravityToken: async (refresh) => ({
        refresh,
        access: refresh,
        expires: Date.now() + 600_000,
      }),
      ensureProjectContext: async (auth) => ({
        auth,
        projectId: 'project',
        effectiveProjectId: 'project',
      }),
      send: async ({ auth }) => {
        sent.push(auth.access ?? '')
        if (auth.access === 'pool-a') {
          entered.resolve()
          return upstream.promise
        }
        return successResponse()
      },
    })
    try {
      const pending = sendTitle(captured)
      await entered.promise
      await captured.run({ name: 'account', args: 'remove 1 confirm' })
      upstream.resolve(successResponse())
      expect((await pending).ok).toBe(true)
      expect(sent).toEqual(['pool-a'])
    } finally {
      upstream.resolve(successResponse())
      await captured.cleanup()
    }
  })

  test('records a sent success on disabled A without enabling or sending B', async () => {
    const file = seedPool([
      {
        refreshToken: 'pool-a',
        projectId: 'project-a',
        addedAt: 1,
        lastUsed: 0,
        enabled: true,
        rateLimitResetTimes: {},
      },
      {
        refreshToken: 'pool-b',
        projectId: 'project-b',
        addedAt: 2,
        lastUsed: 0,
        enabled: true,
        rateLimitResetTimes: {},
      },
    ])
    const upstream = deferred<Response>()
    const entered = deferred<void>()
    const sent: string[] = []
    const captured = await setupCapturingCommands({
      refreshAntigravityToken: async (refresh) => ({
        refresh,
        access: refresh,
        expires: Date.now() + 600_000,
      }),
      ensureProjectContext: async (auth) => ({
        auth,
        projectId: 'project',
        effectiveProjectId: 'project',
      }),
      send: async ({ auth }) => {
        sent.push(auth.access ?? '')
        if (auth.access === 'pool-a') {
          entered.resolve()
          return upstream.promise
        }
        return successResponse()
      },
    })
    try {
      const pending = sendTitle(captured)
      await entered.promise
      await captured.run({ name: 'account', args: 'disable 1' })
      upstream.resolve(successResponse())
      expect((await pending).ok).toBe(true)
      expect(sent).toEqual(['pool-a'])
    } finally {
      upstream.resolve(successResponse())
      await captured.cleanup()
    }
    const stored = JSON.parse(readFileSync(file, 'utf8')) as {
      accounts: Array<{
        enabled: boolean
        dailyRequestCounts?: { gemini: number }
      }>
    }
    expect(stored.accounts[0]?.enabled).toBe(false)
    expect(stored.accounts[0]?.dailyRequestCounts?.gemini).toBe(1)
  })

  test('a removed account 403 never disables the account now at its index', async () => {
    transitionPool()
    const upstream = deferred<Response>()
    const entered = deferred<void>()
    const sent: string[] = []
    const captured = await setupCapturingCommands({
      refreshAntigravityToken: async (refresh) => ({
        refresh,
        access: refresh,
        expires: Date.now() + 600_000,
      }),
      ensureProjectContext: async (auth) => ({
        auth,
        projectId: 'project',
        effectiveProjectId: 'project',
      }),
      send: async ({ auth }) => {
        sent.push(auth.access ?? '')
        if (auth.access === 'pool-a') {
          entered.resolve()
          return upstream.promise
        }
        return successResponse()
      },
    })
    try {
      const pending = sendTitle(captured)
      await entered.promise
      await captured.run({ name: 'account', args: 'remove 1 confirm' })
      upstream.resolve(
        new Response(
          JSON.stringify({ error: { status: 'ACCOUNT_INELIGIBLE' } }),
          { status: 403 },
        ),
      )
      expect((await pending).ok).toBe(true)
      expect(sent).toEqual(['pool-a', 'pool-b'])
      const pool = await captured.run({ name: 'account', args: 'list' })
      expect(pool.snapshot?.kind).toBe('account')
      if (pool.snapshot?.kind === 'account')
        expect(pool.snapshot.accounts[0]?.state).toBe('active')
    } finally {
      upstream.resolve(successResponse())
      await captured.cleanup()
    }
  })

  for (const status of [401, 404, 503]) {
    test(`a ${status} fallback after removal sends only with current B`, async () => {
      transitionPool()
      const upstream = deferred<Response>()
      const entered = deferred<void>()
      const sent: string[] = []
      const captured = await setupCapturingCommands({
        refreshAntigravityToken: async (refresh) => ({
          refresh,
          access: refresh,
          expires: Date.now() + 600_000,
        }),
        ensureProjectContext: async (auth) => ({
          auth,
          projectId: 'project',
          effectiveProjectId: 'project',
        }),
        send: async ({ auth }) => {
          sent.push(auth.access ?? '')
          if (auth.access === 'pool-a') {
            entered.resolve()
            return upstream.promise
          }
          return successResponse()
        },
      })
      try {
        const pending = sendTitle(captured)
        await entered.promise
        await captured.run({ name: 'account', args: 'remove 1 confirm' })
        upstream.resolve(
          new Response(JSON.stringify({ error: { message: 'old account' } }), {
            status,
          }),
        )
        expect((await pending).ok).toBe(true)
        expect(sent).toEqual(['pool-a', 'pool-b'])
      } finally {
        upstream.resolve(successResponse())
        await captured.cleanup()
      }
    })
  }

  test('a disabled account error does not reenable it', async () => {
    transitionPool()
    const upstream = deferred<Response>()
    const entered = deferred<void>()
    const captured = await setupCapturingCommands({
      refreshAntigravityToken: async (refresh) => ({
        refresh,
        access: refresh,
        expires: Date.now() + 600_000,
      }),
      ensureProjectContext: async (auth) => ({
        auth,
        projectId: 'project',
        effectiveProjectId: 'project',
      }),
      send: async ({ auth }) => {
        if (auth.access === 'pool-a') {
          entered.resolve()
          return upstream.promise
        }
        return successResponse()
      },
    })
    try {
      const pending = sendTitle(captured)
      await entered.promise
      await captured.run({ name: 'account', args: 'disable 1' })
      upstream.resolve(
        new Response(
          JSON.stringify({ error: { status: 'ACCOUNT_INELIGIBLE' } }),
          { status: 403 },
        ),
      )
      expect((await pending).ok).toBe(true)
      const pool = await captured.run({ name: 'account', args: 'list' })
      if (pool.snapshot?.kind !== 'account')
        throw new Error('missing account panel')
      expect(pool.snapshot.accounts[0]?.state).toBe('disabled')
    } finally {
      upstream.resolve(successResponse())
      await captured.cleanup()
    }
  })

  test('a known no-write mutation failure leaves B and list available', async () => {
    seedPool([
      {
        refreshToken: 'pool-a',
        projectId: 'project-a',
        addedAt: 1,
        lastUsed: 0,
        enabled: false,
        rateLimitResetTimes: {},
      },
      {
        refreshToken: 'pool-b',
        projectId: 'project-b',
        addedAt: 2,
        lastUsed: 0,
        enabled: true,
        rateLimitResetTimes: {},
      },
    ])
    const sent: string[] = []
    const captured = await setupCapturingCommands({
      mutateAccountStorage: async () => {
        throw new Error('known no write')
      },
      refreshAntigravityToken: async (refresh) => ({
        refresh,
        access: refresh,
        expires: Date.now() + 600_000,
      }),
      ensureProjectContext: async (auth) => ({
        auth,
        projectId: 'project',
        effectiveProjectId: 'project',
      }),
      send: async ({ auth }) => {
        sent.push(auth.access ?? '')
        return successResponse()
      },
    })
    try {
      const failed = await captured.run({
        name: 'account',
        args: 'remove 1 confirm',
      })
      expect(failed.messages.join('\n')).toContain('could not be confirmed')
      expect(
        (await captured.run({ name: 'account', args: 'list' })).snapshot?.kind,
      ).toBe('account')
      expect((await sendTitle(captured)).ok).toBe(true)
      expect(sent).toEqual(['pool-b'])
    } finally {
      await captured.cleanup()
    }
  })

  test('write-then-error remove is unconfirmed without replaying a shifted ordinal', async () => {
    transitionPool()
    let writes = 0
    const sent: string[] = []
    const captured = await setupCapturingCommands({
      mutateAccountStorage: async (path, mutator) => {
        writes++
        await mutateAccountStorage(path, mutator)
        throw new Error('result lost after write')
      },
      refreshAntigravityToken: async (refresh) => ({
        refresh,
        access: refresh,
        expires: Date.now() + 600_000,
      }),
      ensureProjectContext: async (auth) => ({
        auth,
        projectId: 'project',
        effectiveProjectId: 'project',
      }),
      send: async ({ auth }) => {
        sent.push(auth.access ?? '')
        return successResponse()
      },
    })
    try {
      const failed = await captured.run({
        name: 'account',
        args: 'remove 1 confirm',
      })
      expect(failed.messages.join('\n')).toContain(
        'Inspect the current account pool before retrying',
      )
      expect(writes).toBe(1)
      const pool = await captured.run({ name: 'account', args: 'list' })
      if (pool.snapshot?.kind !== 'account')
        throw new Error('missing account panel')
      expect(pool.snapshot.accounts).toHaveLength(1)
      expect((await sendTitle(captured)).ok).toBe(true)
      expect(sent).toEqual(['pool-b'])
    } finally {
      await captured.cleanup()
    }
  })
  test('server registers no duplicate slash commands and guards exact prompt fallback', async () => {
    seedPool([
      {
        email: 'secret-pii@example.test',
        refreshToken: 'pool-a',
        addedAt: 1,
        lastUsed: 1,
        enabled: true,
      },
    ])
    const captured = await setupCapturingCommands()
    try {
      expect(captured.hookNames).toEqual([
        'prompt',
        'model.request',
        'http.request',
      ])
      for (const name of ['account', 'quota', 'status']) {
        await expect(
          captured.promptHook({
            prompt: { text: `  /antigravity-${name} refresh` },
          }),
        ).rejects.toThrow('require the OpenCode TUI')
      }
      await captured.promptHook({
        prompt: { text: 'What does /antigravity-account do?' },
      })
      await captured.promptHook({
        prompt: { text: '/antigravity-accounting is not our command' },
      })
      await captured.promptHook({ prompt: { text: '/other-command' } })
      expect(captured.outputs).toEqual([])
    } finally {
      await captured.cleanup()
    }
  })

  test('headless model-request guard blocks only the latest slash prompt before provider dispatch', async () => {
    seedPool([])
    const blocked = await setupCapturingCommands({
      contextMessages: [
        { type: 'user', text: 'A normal earlier question' },
        { type: 'user', text: '/antigravity-status' },
      ],
    })
    let providerCalls = 0
    try {
      await expect(
        (async () => {
          await blocked.modelRequestHook({ sessionID: 'headless-session' })
          providerCalls += 1
        })(),
      ).rejects.toThrow('require the OpenCode TUI')
      expect(providerCalls).toBe(0)
    } finally {
      await blocked.cleanup()
    }

    const allowed = await setupCapturingCommands({
      contextMessages: [
        { type: 'user', text: '/antigravity-status' },
        { type: 'user', text: 'Explain /antigravity-status in the docs' },
      ],
    })
    try {
      await allowed.modelRequestHook({ sessionID: 'headless-session' })
      providerCalls += 1
      expect(providerCalls).toBe(1)
    } finally {
      await allowed.cleanup()
    }
  })

  test('OAuth add returns a URL before completion and exposes scoped progress', async () => {
    seedPool([])
    let finishCode: (code: string) => void = () => {}
    const code = new Promise<string>((resolve) => {
      finishCode = resolve
    })
    const captured = await setupCapturingCommands({ waitForCode: () => code })
    try {
      const started = await captured.run({ name: 'account', args: 'add' })
      expect(started.operationId).toBeString()
      expect(Object.hasOwn(started, 'snapshot')).toBe(false)
      await expect(encodeRpcOutput(started)).resolves.toBeDefined()
      expect(started.messages.join('\n')).toContain(
        'https://accounts.example/authorize?state=cmd-state',
      )
      const pending = await captured.operation({
        operationId: started.operationId!,
      })
      expect(pending.state).toBe('pending')
      expect(Object.hasOwn(pending, 'snapshot')).toBe(false)
      await expect(encodeRpcOutput(pending)).resolves.toBeDefined()
      const independent = await captured.run({ name: 'quota', args: '' })
      expect(independent.messages.join('\n')).toContain('empty')
      finishCode('cmd-code')
      let completed = await captured.operation({
        operationId: started.operationId!,
      })
      for (
        let attempt = 0;
        attempt < 100 && completed.state === 'pending';
        attempt++
      ) {
        await Bun.sleep(10)
        completed = await captured.operation({
          operationId: started.operationId!,
        })
      }
      expect(completed.state).toBe('complete')
      expect(completed.snapshot?.kind).toBe('account')
      await expect(encodeRpcOutput(completed)).resolves.toBeDefined()
      expect(completed.messages.join('\n')).toContain('Account added')
      expect(completed.messages.join('\n')).not.toContain('cmd-refresh')
    } finally {
      await captured.cleanup()
    }
  })

  test('OAuth failure remains a failed operation without leaking upstream details', async () => {
    seedPool([])
    const captured = await setupCapturingCommands({
      waitForCode: async () => {
        throw new Error('upstream-secret-detail')
      },
    })
    try {
      const started = await captured.run({ name: 'account', args: 'add' })
      expect(started.operationId).toBeString()
      let outcome = await captured.operation({
        operationId: started.operationId!,
      })
      for (
        let attempt = 0;
        attempt < 10 && outcome.state === 'pending';
        attempt++
      ) {
        await Bun.sleep(1)
        outcome = await captured.operation({
          operationId: started.operationId!,
        })
      }
      expect(outcome.state).toBe('failed')
      expect(Object.hasOwn(outcome, 'snapshot')).toBe(false)
      await expect(encodeRpcOutput(outcome)).resolves.toBeDefined()
      expect(outcome.messages.join('\n')).toContain('login failed')
      expect(outcome.messages.join('\n')).not.toContain(
        'upstream-secret-detail',
      )
    } finally {
      await captured.cleanup()
    }
  })

  test('OAuth write readback distinguishes saved account from failed live reload', async () => {
    const file = seedPool([])
    let loads = 0
    const captured = await setupCapturingCommands({
      loadAccountStorage: async () => {
        loads++
        if (loads === 1) return null
        throw new Error('live reload unavailable')
      },
    })
    try {
      const started = await captured.run({ name: 'account', args: 'add' })
      expect(started.operationId).toBeString()
      let outcome = await captured.operation({
        operationId: started.operationId!,
      })
      for (
        let attempt = 0;
        attempt < 100 && outcome.state === 'pending';
        attempt++
      ) {
        await Bun.sleep(10)
        outcome = await captured.operation({
          operationId: started.operationId!,
        })
      }
      expect(outcome.state).toBe('persisted-not-live')
      expect(outcome.messages.join('\n')).toContain('Restart OpenCode')
      expect(outcome.messages.join('\n')).not.toContain('cmd-refresh')
      expect(
        (await captured.run({ name: 'quota', args: 'refresh' })).messages.join(
          '\n',
        ),
      ).toContain('requires an OpenCode restart')
      const stored = JSON.parse(readFileSync(file, 'utf8'))
      expect(
        stored.accounts.map(
          (entry: { refreshToken: string }) => entry.refreshToken,
        ),
      ).toContain('cmd-refresh')
    } finally {
      await captured.cleanup()
    }
  })

  test('OAuth write error with absent readback remains unconfirmed', async () => {
    seedPool([])
    const captured = await setupCapturingCommands({
      mutateAccountStorage: async () => {
        throw new Error('write result ambiguous')
      },
    })
    try {
      const started = await captured.run({ name: 'account', args: 'add' })
      expect(started.operationId).toBeString()
      let outcome = await captured.operation({
        operationId: started.operationId!,
      })
      for (
        let attempt = 0;
        attempt < 100 && outcome.state === 'pending';
        attempt++
      ) {
        await Bun.sleep(10)
        outcome = await captured.operation({
          operationId: started.operationId!,
        })
      }
      expect(outcome.state).toBe('unconfirmed')
      expect(outcome.messages.join('\n')).toContain(
        'Inspect the account pool before retrying',
      )
      expect(outcome.messages.join('\n')).not.toContain(
        'write result ambiguous',
      )
    } finally {
      await captured.cleanup()
    }
  })

  test('preexisting OAuth token does not confirm a failed write', async () => {
    seedPool([
      {
        refreshToken: 'cmd-refresh',
        projectId: 'cmd-project',
        addedAt: 1,
        lastUsed: 1,
        enabled: true,
      },
    ])
    const captured = await setupCapturingCommands({
      mutateAccountStorage: async () => {
        throw new Error('no write')
      },
    })
    try {
      const started = await captured.run({ name: 'account', args: 'add' })
      let outcome = await captured.operation({
        operationId: started.operationId!,
      })
      for (let i = 0; i < 100 && outcome.state === 'pending'; i++) {
        await Bun.sleep(10)
        outcome = await captured.operation({
          operationId: started.operationId!,
        })
      }
      expect(outcome.state).toBe('unconfirmed')
      expect(
        (await captured.run({ name: 'account', args: 'list' })).snapshot?.kind,
      ).toBe('account')
    } finally {
      await captured.cleanup()
    }
  })

  test('OAuth read-only recovery restores a confirmed written account live', async () => {
    seedPool([])
    let loads = 0
    const captured = await setupCapturingCommands({
      loadAccountStorage: async (path) => {
        loads++
        if (loads === 2) throw new Error('one reload failed')
        return loadAccountStorage(path)
      },
    })
    try {
      const started = await captured.run({ name: 'account', args: 'add' })
      let outcome = await captured.operation({
        operationId: started.operationId!,
      })
      for (let i = 0; i < 100 && outcome.state === 'pending'; i++) {
        await Bun.sleep(10)
        outcome = await captured.operation({
          operationId: started.operationId!,
        })
      }
      expect(outcome.state).toBe('complete')
      const pool = await captured.run({ name: 'account', args: 'list' })
      if (pool.snapshot?.kind !== 'account')
        throw new Error('missing account panel')
      expect(pool.snapshot.accounts).toHaveLength(1)
      expect(loads).toBeGreaterThanOrEqual(3)
    } finally {
      await captured.cleanup()
    }
  })

  test('account list never leaks the email PII', async () => {
    seedPool([
      {
        email: 'secret-pii@example.test',
        refreshToken: 'pool-a',
        addedAt: 1,
        lastUsed: 1,
        enabled: true,
      },
    ])
    const captured = await setupCapturingCommands()
    try {
      const result = await captured.run({ name: 'account', args: 'list' })
      expect(result.snapshot?.kind).toBe('account')
      expect(JSON.stringify(result.snapshot)).not.toContain(
        'secret-pii@example.test',
      )
      expect(JSON.stringify(result.snapshot)).not.toContain('pool-a')
      await runCommand(captured, 'antigravity-account', 'list')
      const text = captured.outputs.at(-1)?.text ?? ''
      expect(text).toContain('Account 1')
      expect(text).not.toContain('secret-pii@example.test')
    } finally {
      await captured.cleanup()
    }
  })

  test('remove requires confirm and rewrites the shared pool file', async () => {
    const file = seedPool([
      {
        refreshToken: 'pool-a',
        addedAt: 1,
        lastUsed: 1,
        enabled: true,
      },
      {
        refreshToken: 'pool-b',
        addedAt: 1,
        lastUsed: 1,
        enabled: true,
      },
    ])
    const captured = await setupCapturingCommands()
    try {
      await runCommand(captured, 'antigravity-account', 'remove 1')
      const stillThere = JSON.parse(readFileSync(file, 'utf-8'))
      expect(stillThere.accounts).toHaveLength(2)

      await runCommand(captured, 'antigravity-account', 'remove 1 confirm')
      const after = JSON.parse(readFileSync(file, 'utf-8'))
      expect(
        after.accounts.map((a: { refreshToken: string }) => a.refreshToken),
      ).toEqual(['pool-b'])
    } finally {
      await captured.cleanup()
    }
  })

  test('quota view performs zero network fetches', async () => {
    seedPool([
      {
        refreshToken: 'pool-a',
        addedAt: 1,
        lastUsed: 1,
        enabled: true,
      },
    ])
    const captured = await setupCapturingCommands()
    try {
      await runCommand(captured, 'antigravity-quota', '')
      expect(captured.outputs.at(-1)?.text).toContain('cached')
    } finally {
      await captured.cleanup()
    }
  })
})
