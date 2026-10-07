import { describe, expect, spyOn, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type AccountStorageV4,
  defaultAccountStorageStore,
  loadAccountStorage,
  mutateAccountStorage,
} from '@cortexkit/antigravity-auth-core'
import type { SessionHttpRequest } from '@opencode-ai/plugin/promise/session'

import plugin, {
  createOpenCodeV2AntigravityPlugin,
  upsertOAuthAccount,
} from '../src/plugin.ts'

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

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function seedPool(accounts: AccountStorageV4['accounts']): string {
  const dir = process.env.OPENCODE_CONFIG_DIR
  if (!dir) throw new Error('OPENCODE_CONFIG_DIR is not set')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'antigravity-accounts.json')
  writeFileSync(
    path,
    `${JSON.stringify({ version: 4, accounts, activeIndex: 0 })}\n`,
  )
  return path
}

function readPool(path: string): AccountStorageV4 {
  return JSON.parse(readFileSync(path, 'utf8')) as AccountStorageV4
}

async function setupPoolAdapter(
  overrides: Parameters<typeof createOpenCodeV2AntigravityPlugin>[0],
) {
  type OAuthMethod = {
    authorize: () => Promise<{ callback: Promise<unknown> }>
  }
  let oauth: OAuthMethod | undefined
  let hook: ((event: SessionHttpRequest) => Promise<void>) | undefined
  const registration = { dispose: async () => {} }
  const adapter = createOpenCodeV2AntigravityPlugin(overrides)
  const cleanup = await adapter.setup({
    session: {
      hook: async (name: string, callback: unknown) => {
        if (name === 'http.request') hook = callback as typeof hook
        return registration
      },
    },
    integration: {
      transform: async (transform: unknown) => {
        ;(
          transform as (draft: {
            method: { update: (method: OAuthMethod) => void }
          }) => void
        )({
          method: {
            update: (method) => {
              oauth = method
            },
          },
        })
        return registration
      },
    },
  } as never)
  if (!oauth || !hook || !cleanup) throw new Error('plugin setup incomplete')
  return { oauth, hook, cleanup }
}

async function titleRequest(
  hook: (event: SessionHttpRequest) => Promise<void>,
  signal?: AbortSignal,
): Promise<Response> {
  const event = {
    sessionID: 'pool-test-session',
    agent: 'pool-test-agent',
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
  await hook(event as never)
  return fetch(event.request, { signal })
}

describe('opencode-v2-antigravity-auth plugin entry', () => {
  test('serializes same-email OAuth saves and keeps the other enabled account', async () => {
    const path = seedPool([
      {
        email: 'a@example.test',
        refreshToken: 'old-a',
        addedAt: 1,
        lastUsed: 1,
        enabled: true,
      },
      {
        email: 'b@example.test',
        refreshToken: 'token-b',
        addedAt: 2,
        lastUsed: 2,
        enabled: true,
      },
    ])
    const firstMutation = deferred<void>()
    const enteredMutation = deferred<void>()
    let writes = 0
    let exchanges = 0
    const sent: string[] = []
    const captured = await setupPoolAdapter({
      authorizeAntigravity: async () => ({
        url: 'https://accounts.example/authorize?state=pool-state',
        verifier: 'verifier',
        projectId: '',
      }),
      waitForAntigravityCode: async () => 'code',
      exchangeAntigravity: async () => {
        exchanges++
        return {
          type: 'success',
          refresh: `new-a-${exchanges}`,
          access: 'access',
          expires: Date.now() + 600_000,
          email: 'a@example.test',
          projectId: 'project',
        }
      },
      mutateAccountStorage: async (file, mutator) => {
        writes++
        if (writes === 1) {
          enteredMutation.resolve()
          await firstMutation.promise
        }
        return mutateAccountStorage(file, mutator)
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
      expect((await titleRequest(captured.hook)).ok).toBe(true)
      const first = (await captured.oauth.authorize()).callback
      await enteredMutation.promise
      const cancelled = new AbortController()
      const waitingRequest = titleRequest(captured.hook, cancelled.signal)
      await Bun.sleep(20)
      cancelled.abort()
      await expect(waitingRequest).rejects.toThrow()
      expect(sent).toEqual(['old-a'])
      const second = (await captured.oauth.authorize()).callback
      firstMutation.resolve()
      await Promise.all([first, second])
      await Bun.sleep(1100)
      expect(
        readPool(path).accounts.map((account) => account.refreshToken),
      ).toEqual(['new-a-2', 'token-b'])
      expect(readPool(path).accounts[1]?.enabled).toBe(true)
      expect(writes).toBe(2)
      expect((await titleRequest(captured.hook)).ok).toBe(true)
      expect(sent.slice(1)).not.toContain('old-a')
    } finally {
      firstMutation.resolve()
      await captured.cleanup()
    }
  })

  test('recovers the live pool from disk after a failed OAuth write', async () => {
    const path = seedPool([
      {
        email: 'a@example.test',
        refreshToken: 'old-a',
        addedAt: 1,
        lastUsed: 1,
        enabled: false,
      },
      {
        email: 'b@example.test',
        refreshToken: 'token-b',
        addedAt: 2,
        lastUsed: 2,
        enabled: true,
      },
    ])
    const sent: string[] = []
    const captured = await setupPoolAdapter({
      authorizeAntigravity: async () => ({
        url: 'https://accounts.example/authorize?state=pool-state',
        verifier: 'verifier',
        projectId: '',
      }),
      waitForAntigravityCode: async () => 'code',
      exchangeAntigravity: async () => ({
        type: 'success',
        refresh: 'new-a',
        access: 'access',
        expires: Date.now() + 600_000,
        email: 'a@example.test',
        projectId: 'project',
      }),
      mutateAccountStorage: async () => {
        throw new Error('disk write failed')
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
      await expect((await captured.oauth.authorize()).callback).rejects.toThrow(
        'disk write failed',
      )
      expect(
        readPool(path).accounts.map((account) => account.refreshToken),
      ).toEqual(['old-a', 'token-b'])
      expect((await titleRequest(captured.hook)).ok).toBe(true)
      expect(sent).toEqual(['token-b'])
    } finally {
      await captured.cleanup()
    }
  })

  test('strict OAuth flush stops before mutation when queued state hits storage contention', async () => {
    const path = seedPool([
      {
        email: 'a@example.test',
        refreshToken: 'old-a',
        addedAt: 1,
        lastUsed: 1,
        enabled: true,
      },
      {
        email: 'b@example.test',
        refreshToken: 'token-b',
        addedAt: 2,
        lastUsed: 2,
        enabled: true,
      },
    ])
    let mutations = 0
    const captured = await setupPoolAdapter({
      authorizeAntigravity: async () => ({
        url: 'https://accounts.example/authorize?state=pool-state',
        verifier: 'verifier',
        projectId: '',
      }),
      waitForAntigravityCode: async () => 'code',
      exchangeAntigravity: async () => ({
        type: 'success',
        refresh: 'new-a',
        access: 'access',
        expires: Date.now() + 600_000,
        email: 'a@example.test',
        projectId: 'project',
      }),
      mutateAccountStorage: async (file, mutator) => {
        mutations++
        return mutateAccountStorage(file, mutator)
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
      send: async () => successResponse(),
    })
    const save = spyOn(
      defaultAccountStorageStore,
      'saveMerged',
    ).mockRejectedValue(new Error('ELOCKED'))
    try {
      expect((await titleRequest(captured.hook)).ok).toBe(true)
      await expect((await captured.oauth.authorize()).callback).rejects.toThrow(
        'ELOCKED',
      )
      expect(mutations).toBe(0)
      expect(
        readPool(path).accounts.map((account) => account.refreshToken),
      ).toEqual(['old-a', 'token-b'])
      expect(readPool(path).accounts[1]?.enabled).toBe(true)
    } finally {
      save.mockRestore()
      await captured.cleanup()
    }
  })

  test('reconciles a write-then-error without replaying OAuth mutation', async () => {
    const path = seedPool([
      {
        email: 'a@example.test',
        refreshToken: 'old-a',
        addedAt: 1,
        lastUsed: 1,
        enabled: true,
      },
      {
        email: 'b@example.test',
        refreshToken: 'token-b',
        addedAt: 2,
        lastUsed: 2,
        enabled: true,
      },
    ])
    let writes = 0
    const sent: string[] = []
    const captured = await setupPoolAdapter({
      authorizeAntigravity: async () => ({
        url: 'https://accounts.example/authorize?state=pool-state',
        verifier: 'verifier',
        projectId: '',
      }),
      waitForAntigravityCode: async () => 'code',
      exchangeAntigravity: async () => ({
        type: 'success',
        refresh: 'new-a',
        access: 'access',
        expires: Date.now() + 600_000,
        email: 'a@example.test',
        projectId: 'project',
      }),
      mutateAccountStorage: async (file, mutator) => {
        writes++
        await mutateAccountStorage(file, mutator)
        throw new Error('write result lost')
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
      await expect((await captured.oauth.authorize()).callback).rejects.toThrow(
        'write result lost',
      )
      expect(writes).toBe(1)
      expect(
        readPool(path).accounts.map((account) => account.refreshToken),
      ).toEqual(['new-a', 'token-b'])
      expect((await titleRequest(captured.hook)).ok).toBe(true)
      expect(sent).not.toContain('old-a')
    } finally {
      await captured.cleanup()
    }
  })

  test('does not report OAuth success when storage returns without the new account', async () => {
    const path = seedPool([
      {
        email: 'b@example.test',
        refreshToken: 'token-b',
        addedAt: 2,
        lastUsed: 2,
        enabled: true,
      },
    ])
    const captured = await setupPoolAdapter({
      authorizeAntigravity: async () => ({
        url: 'https://accounts.example/authorize?state=pool-state',
        verifier: 'verifier',
        projectId: '',
      }),
      waitForAntigravityCode: async () => 'code',
      exchangeAntigravity: async () => ({
        type: 'success',
        refresh: 'new-a',
        access: 'access',
        expires: Date.now() + 600_000,
        email: 'a@example.test',
        projectId: 'project',
      }),
      mutateAccountStorage: async (file) => (await loadAccountStorage(file))!,
    })
    try {
      await expect((await captured.oauth.authorize()).callback).rejects.toThrow(
        'not confirmed on disk',
      )
      expect(
        readPool(path).accounts.map((account) => account.refreshToken),
      ).toEqual(['token-b'])
    } finally {
      await captured.cleanup()
    }
  })

  test('reload failure reads back the durable OAuth write before serving requests', async () => {
    const path = seedPool([
      {
        email: 'a@example.test',
        refreshToken: 'old-a',
        addedAt: 1,
        lastUsed: 1,
        enabled: true,
      },
      {
        email: 'b@example.test',
        refreshToken: 'token-b',
        addedAt: 2,
        lastUsed: 2,
        enabled: true,
      },
    ])
    let loads = 0
    const sent: string[] = []
    const captured = await setupPoolAdapter({
      authorizeAntigravity: async () => ({
        url: 'https://accounts.example/authorize?state=pool-state',
        verifier: 'verifier',
        projectId: '',
      }),
      waitForAntigravityCode: async () => 'code',
      exchangeAntigravity: async () => ({
        type: 'success',
        refresh: 'new-a',
        access: 'access',
        expires: Date.now() + 600_000,
        email: 'a@example.test',
        projectId: 'project',
      }),
      loadAccountStorage: async (file) => {
        loads++
        if (loads === 2) throw new Error('reload failed')
        return loadAccountStorage(file)
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
      await expect((await captured.oauth.authorize()).callback).rejects.toThrow(
        'reload failed',
      )
      expect(loads).toBe(3)
      expect(
        readPool(path).accounts.map((account) => account.refreshToken),
      ).toEqual(['new-a', 'token-b'])
      expect((await titleRequest(captured.hook)).ok).toBe(true)
      expect(sent).not.toContain('old-a')
    } finally {
      await captured.cleanup()
    }
  })

  test('discards a refresh result from a retired pool before sending', async () => {
    seedPool([
      {
        email: 'a@example.test',
        refreshToken: 'old-a',
        addedAt: 1,
        lastUsed: 1,
        enabled: true,
      },
      {
        email: 'b@example.test',
        refreshToken: 'token-b',
        addedAt: 2,
        lastUsed: 2,
        enabled: true,
      },
    ])
    const refreshStarted = deferred<void>()
    const releaseRefresh = deferred<void>()
    const sent: string[] = []
    const captured = await setupPoolAdapter({
      authorizeAntigravity: async () => ({
        url: 'https://accounts.example/authorize?state=pool-state',
        verifier: 'verifier',
        projectId: '',
      }),
      waitForAntigravityCode: async () => 'code',
      exchangeAntigravity: async () => ({
        type: 'success',
        refresh: 'new-a',
        access: 'access',
        expires: Date.now() + 600_000,
        email: 'a@example.test',
        projectId: 'project',
      }),
      refreshAntigravityToken: async (refresh) => {
        if (refresh === 'old-a') {
          refreshStarted.resolve()
          await releaseRefresh.promise
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
        return successResponse()
      },
    })
    try {
      const pendingRequest = titleRequest(captured.hook)
      await refreshStarted.promise
      await (await captured.oauth.authorize()).callback
      releaseRefresh.resolve()
      expect((await pendingRequest).ok).toBe(true)
      expect(sent).not.toContain('old-a')
    } finally {
      releaseRefresh.resolve()
      await captured.cleanup()
    }
  })

  for (const outcome of ['http-error', 'transport-error'] as const) {
    test(`does not replay an already sent request after ${outcome} crosses OAuth transition`, async () => {
      const path = seedPool([
        {
          email: 'a@example.test',
          refreshToken: 'old-a',
          addedAt: 1,
          lastUsed: 1,
          enabled: true,
        },
        {
          email: 'b@example.test',
          refreshToken: 'token-b',
          addedAt: 2,
          lastUsed: 2,
          enabled: true,
        },
      ])
      const sent = deferred<void>()
      const upstream = deferred<Response>()
      const accesses: string[] = []
      const captured = await setupPoolAdapter({
        authorizeAntigravity: async () => ({
          url: 'https://accounts.example/authorize?state=pool-state',
          verifier: 'verifier',
          projectId: '',
        }),
        waitForAntigravityCode: async () => 'code',
        exchangeAntigravity: async () => ({
          type: 'success',
          refresh: 'new-a',
          access: 'access',
          expires: Date.now() + 600_000,
          email: 'a@example.test',
          projectId: 'project',
        }),
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
          accesses.push(auth.access ?? '')
          sent.resolve()
          return upstream.promise
        },
      })
      try {
        const pendingRequest = titleRequest(captured.hook)
        await sent.promise
        expect(accesses).toEqual(['old-a'])
        await (await captured.oauth.authorize()).callback
        if (outcome === 'http-error')
          upstream.resolve(
            new Response(JSON.stringify({ error: { message: 'limited' } }), {
              status: 429,
            }),
          )
        else upstream.reject(new Error('transport failed'))
        const response = await pendingRequest
        expect(response.status).toBe(502)
        expect(await response.text()).toContain(
          outcome === 'http-error'
            ? 'Antigravity HTTP 429'
            : 'transport failed',
        )
        expect(accesses).toEqual(['old-a'])
        expect(
          readPool(path).accounts.map((account) => account.refreshToken),
        ).toEqual(['new-a', 'token-b'])
        expect(readPool(path).accounts[1]?.enabled).toBe(true)
      } finally {
        upstream.resolve(successResponse())
        await captured.cleanup()
      }
    })
  }

  test('does not retry a sent 401 after forced refresh crosses OAuth transition', async () => {
    const path = seedPool([
      {
        email: 'a@example.test',
        refreshToken: 'old-a',
        addedAt: 1,
        lastUsed: 1,
        enabled: true,
      },
      {
        email: 'b@example.test',
        refreshToken: 'token-b',
        addedAt: 2,
        lastUsed: 2,
        enabled: true,
      },
    ])
    const forcedStarted = deferred<void>()
    const releaseForced = deferred<void>()
    let refreshes = 0
    const sent: string[] = []
    const captured = await setupPoolAdapter({
      authorizeAntigravity: async () => ({
        url: 'https://accounts.example/authorize?state=pool-state',
        verifier: 'verifier',
        projectId: '',
      }),
      waitForAntigravityCode: async () => 'code',
      exchangeAntigravity: async () => ({
        type: 'success',
        refresh: 'new-a',
        access: 'access',
        expires: Date.now() + 600_000,
        email: 'a@example.test',
        projectId: 'project',
      }),
      refreshAntigravityToken: async (refresh) => {
        refreshes++
        if (refresh === 'old-a' && refreshes === 2) {
          forcedStarted.resolve()
          await releaseForced.promise
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
        return new Response(JSON.stringify({ error: { message: 'expired' } }), {
          status: 401,
        })
      },
    })
    try {
      const pendingRequest = titleRequest(captured.hook)
      await forcedStarted.promise
      await (await captured.oauth.authorize()).callback
      releaseForced.resolve()
      const response = await pendingRequest
      expect(response.status).toBe(502)
      expect(await response.text()).toContain('Antigravity HTTP 401')
      expect(sent).toEqual(['old-a'])
      expect(
        readPool(path).accounts.map((account) => account.refreshToken),
      ).toEqual(['new-a', 'token-b'])
      expect(readPool(path).accounts[1]?.enabled).toBe(true)
    } finally {
      releaseForced.resolve()
      await captured.cleanup()
    }
  })

  for (const status of [404, 503]) {
    test(`does not send a fallback endpoint after a sent ${status} crosses OAuth transition`, async () => {
      const path = seedPool([
        {
          email: 'a@example.test',
          refreshToken: 'old-a',
          addedAt: 1,
          lastUsed: 1,
          enabled: true,
        },
        {
          email: 'b@example.test',
          refreshToken: 'token-b',
          addedAt: 2,
          lastUsed: 2,
          enabled: true,
        },
      ])
      const sent = deferred<void>()
      const releaseBody = deferred<void>()
      const accesses: string[] = []
      const captured = await setupPoolAdapter({
        authorizeAntigravity: async () => ({
          url: 'https://accounts.example/authorize?state=pool-state',
          verifier: 'verifier',
          projectId: '',
        }),
        waitForAntigravityCode: async () => 'code',
        exchangeAntigravity: async () => ({
          type: 'success',
          refresh: 'new-a',
          access: 'access',
          expires: Date.now() + 600_000,
          email: 'a@example.test',
          projectId: 'project',
        }),
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
          accesses.push(auth.access ?? '')
          const response = new Response(
            new ReadableStream({
              async start(controller) {
                await releaseBody.promise
                controller.enqueue(
                  new TextEncoder().encode(
                    JSON.stringify({
                      error: { message: 'upstream unavailable' },
                    }),
                  ),
                )
                controller.close()
              },
            }),
            { status },
          )
          sent.resolve()
          return response
        },
      })
      try {
        const pendingRequest = titleRequest(captured.hook)
        await sent.promise
        await (await captured.oauth.authorize()).callback
        releaseBody.resolve()
        const response = await pendingRequest
        expect(response.status).toBe(502)
        expect(await response.text()).toContain(`Antigravity HTTP ${status}`)
        expect(accesses).toEqual(['old-a'])
        expect(
          readPool(path).accounts.map((account) => account.refreshToken),
        ).toEqual(['new-a', 'token-b'])
        expect(readPool(path).accounts[1]?.enabled).toBe(true)
      } finally {
        releaseBody.resolve()
        await captured.cleanup()
      }
    })
  }

  test('reports pool unavailable when OAuth write and authoritative readback both fail', async () => {
    const path = seedPool([
      {
        email: 'b@example.test',
        refreshToken: 'token-b',
        addedAt: 2,
        lastUsed: 2,
        enabled: true,
      },
    ])
    let loads = 0
    let writes = 0
    let readable = false
    let sends = 0
    const captured = await setupPoolAdapter({
      authorizeAntigravity: async () => ({
        url: 'https://accounts.example/authorize?state=pool-state',
        verifier: 'verifier',
        projectId: '',
      }),
      waitForAntigravityCode: async () => 'code',
      exchangeAntigravity: async () => ({
        type: 'success',
        refresh: 'new-a',
        access: 'access',
        expires: Date.now() + 600_000,
        email: 'a@example.test',
        projectId: 'project',
      }),
      loadAccountStorage: async (file) => {
        loads++
        if (loads > 1 && !readable) throw new Error('readback failed')
        return loadAccountStorage(file)
      },
      mutateAccountStorage: async (file, mutator) => {
        writes++
        if (writes === 1) throw new Error('disk write failed')
        return mutateAccountStorage(file, mutator)
      },
      send: async () => {
        sends++
        return successResponse()
      },
    })
    try {
      await expect((await captured.oauth.authorize()).callback).rejects.toThrow(
        'pool is unavailable',
      )
      const response = await titleRequest(captured.hook)
      expect(response.status).toBe(502)
      expect(await response.text()).toContain('pool is unavailable')
      expect(sends).toBe(0)
      await expect((await captured.oauth.authorize()).callback).rejects.toThrow(
        'pool is unavailable',
      )
      expect(writes).toBe(1)
      readable = true
      await expect(
        (await captured.oauth.authorize()).callback,
      ).resolves.toBeDefined()
      expect(writes).toBe(2)
      expect(
        readPool(path).accounts.map((account) => account.refreshToken),
      ).toEqual(['token-b', 'new-a'])
    } finally {
      await captured.cleanup()
    }
  })
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
      await expect(authorization.callback).rejects.toThrow('disk write failed')
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
