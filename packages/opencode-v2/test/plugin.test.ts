import { describe, expect, spyOn, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  AccountManagerPersistenceError,
  type AccountStorageV4,
  buildAntigravityHarnessUserAgent,
  defaultAccountStorageStore,
  loadAccountStorage,
  mutateAccountStorage,
  saveAccountStorage,
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

  test('shutdown drains an accepted pool transition and rejects late OAuth writes', async () => {
    seedPool([
      {
        email: 'a@example.test',
        refreshToken: 'old-a',
        addedAt: 1,
        lastUsed: 1,
        enabled: true,
      },
    ])
    const enteredMutation = deferred<void>()
    const releaseMutation = deferred<void>()
    let writes = 0
    let exchanges = 0
    let accepted: Promise<unknown> | undefined
    let cleanup: Promise<void> | undefined
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
        enteredMutation.resolve()
        await releaseMutation.promise
        return mutateAccountStorage(file, mutator)
      },
    })
    let cleanupFinished = false
    try {
      accepted = (await captured.oauth.authorize()).callback
      await enteredMutation.promise
      cleanup = Promise.resolve(captured.cleanup()).then(() => {
        cleanupFinished = true
      })
      await Bun.sleep(20)
      expect(cleanupFinished).toBe(false)
      releaseMutation.resolve()
      await accepted
      await cleanup

      await expect(captured.oauth.authorize()).rejects.toThrow()
      expect(writes).toBe(1)
      expect(exchanges).toBe(1)
    } finally {
      releaseMutation.resolve()
      await accepted?.catch(() => {})
      await cleanup?.catch(() => {})
      if (!cleanupFinished) await captured.cleanup()
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
      const callback = (await captured.oauth.authorize()).callback
      await expect(callback).rejects.toBeInstanceOf(
        AccountManagerPersistenceError,
      )
      await expect(callback).rejects.toMatchObject({
        state: 'retryable',
        originalError: expect.objectContaining({ message: 'ELOCKED' }),
      })
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

  test('keeps dirty account state and the live pool after a retryable OAuth fence failure', async () => {
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
      send: async ({ auth }) => {
        sent.push(auth.access ?? '')
        return sent.length === 1
          ? new Response(JSON.stringify({ error: { message: 'limited' } }), {
              status: 429,
              headers: { 'retry-after': '120' },
            })
          : successResponse()
      },
    })
    const save = spyOn(defaultAccountStorageStore, 'saveMerged')
      .mockRejectedValueOnce(new Error('ELOCKED'))
      .mockImplementation((file, next) =>
        mutateAccountStorage(file, () => next),
      )
    try {
      const requestStartedAt = Date.now()
      expect((await titleRequest(captured.hook)).ok).toBe(true)
      expect(sent).toEqual(['old-a', 'token-b'])
      const callback = (await captured.oauth.authorize()).callback
      await expect(callback).rejects.toBeInstanceOf(
        AccountManagerPersistenceError,
      )
      await expect(callback).rejects.toMatchObject({ state: 'retryable' })
      expect(mutations).toBe(0)
      expect(readPool(path).accounts[0]?.lastUsed).toBe(1)

      expect((await titleRequest(captured.hook)).ok).toBe(true)
      expect(sent.slice(2)).toEqual(['token-b'])
      await expect(
        (await captured.oauth.authorize()).callback,
      ).resolves.toBeDefined()
      expect(mutations).toBe(1)
      const persisted = readPool(path)
      expect(persisted.accounts.map((account) => account.refreshToken)).toEqual(
        ['new-a', 'token-b'],
      )
      expect(
        Object.values(persisted.accounts[0]?.rateLimitResetTimes ?? {}).some(
          (resetAt) =>
            typeof resetAt === 'number' && resetAt > requestStartedAt,
        ),
      ).toBe(true)
    } finally {
      save.mockRestore()
      await captured.cleanup()
    }
  })

  for (const failedWrite of ['missing', 'already-committed'] as const) {
    test(`recovers a failed OAuth fence on the next successful request when storage becomes readable (${failedWrite})`, async () => {
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
      let oauthMutations = 0
      let storeLoadCalls = 0
      let unreadableLoadCalls = 0
      let saveCalls = 0
      let recoveryMutations = 0
      let storageReadable = true
      const persisted = deferred<void>()
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
          oauthMutations++
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
          return sent.length === 1
            ? new Response(JSON.stringify({ error: { message: 'limited' } }), {
                status: 429,
                headers: { 'retry-after': '120' },
              })
            : successResponse()
        },
      })
      const storeLoad = spyOn(
        defaultAccountStorageStore,
        'load',
      ).mockImplementation(async (file) => {
        storeLoadCalls++
        if (!storageReadable) {
          unreadableLoadCalls++
          throw new Error('temporary account state readback failure')
        }
        return loadAccountStorage(file)
      })
      const save = spyOn(
        defaultAccountStorageStore,
        'saveMerged',
      ).mockImplementation(async (file, next) => {
        saveCalls++
        if (saveCalls === 1) {
          if (failedWrite === 'already-committed')
            await saveAccountStorage(file, next)
          storageReadable = false
          throw new Error('account state save result unknown')
        }
        return saveAccountStorage(file, next)
      })
      const storeMutate = spyOn(
        defaultAccountStorageStore,
        'mutate',
      ).mockImplementation(async (file, mutator, options) => {
        const result = await mutateAccountStorage(file, mutator, options)
        recoveryMutations++
        persisted.resolve()
        return result
      })
      try {
        expect((await titleRequest(captured.hook)).ok).toBe(true)
        expect(sent).toEqual(['old-a', 'token-b'])
        const callback = (await captured.oauth.authorize()).callback
        let fenceError: unknown
        try {
          await callback
        } catch (error) {
          fenceError = error
        }
        expect(fenceError).toBeInstanceOf(AccountManagerPersistenceError)
        expect(fenceError).toMatchObject({
          state: 'unconfirmed',
          originalError: expect.objectContaining({
            message: 'temporary account state readback failure',
          }),
        })
        expect(oauthMutations).toBe(0)
        expect(unreadableLoadCalls).toBeGreaterThan(0)
        expect(readPool(path).accounts[1]?.enabled).toBe(true)
        if (failedWrite === 'missing')
          expect(
            readPool(path).accounts[0]?.rateLimitResetTimes,
          ).toBeUndefined()
        else
          expect(
            Object.values(
              readPool(path).accounts[0]?.rateLimitResetTimes ?? {},
            ).some((resetAt) => typeof resetAt === 'number'),
          ).toBe(true)

        const idleLoadCount = storeLoadCalls
        const idleSaveCount = saveCalls
        await Bun.sleep(1050)
        expect(storeLoadCalls).toBe(idleLoadCount)
        expect(saveCalls).toBe(idleSaveCount)

        storageReadable = true
        expect((await titleRequest(captured.hook)).ok).toBe(true)
        expect(sent.slice(-1)).toEqual(['token-b'])
        await Promise.race([
          persisted.promise,
          Bun.sleep(3000).then(() => {
            throw new Error('successful request did not recover account state')
          }),
        ])
        await Bun.sleep(10)
        expect(oauthMutations).toBe(0)
        if (failedWrite === 'already-committed')
          expect(recoveryMutations).toBe(1)
        else expect(recoveryMutations).toBeGreaterThan(0)
        const recovered = readPool(path)
        expect(
          Object.values(recovered.accounts[0]?.rateLimitResetTimes ?? {}).some(
            (resetAt) => typeof resetAt === 'number',
          ),
        ).toBe(true)
        expect(recovered.accounts[1]?.lastUsed).toBeGreaterThan(2)
      } finally {
        storeLoad.mockRestore()
        save.mockRestore()
        storeMutate.mockRestore()
        await captured.cleanup()
      }
    })
  }

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

  test('keeps B available when account-state write and readback fail before OAuth mutation', async () => {
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
    let mutations = 0
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
        if (loads > 1) throw new Error('unexpected pool reload')
        return loadAccountStorage(file)
      },
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
      send: async ({ auth }) => {
        sent.push(auth.access ?? '')
        return sent.length === 1
          ? new Response(JSON.stringify({ error: { message: 'limited' } }), {
              status: 429,
              headers: { 'retry-after': '120' },
            })
          : successResponse()
      },
    })
    const storeLoad = spyOn(
      defaultAccountStorageStore,
      'load',
    ).mockRejectedValue(new Error('account-state readback failed'))
    const save = spyOn(
      defaultAccountStorageStore,
      'saveMerged',
    ).mockImplementation(async (file, next) => {
      await mutateAccountStorage(file, () => next)
      throw new Error('account-state write result lost')
    })
    try {
      const requestStartedAt = Date.now()
      expect((await titleRequest(captured.hook)).ok).toBe(true)
      expect(sent).toEqual(['old-a', 'token-b'])
      const callback = (await captured.oauth.authorize()).callback
      await expect(callback).rejects.toMatchObject({
        state: 'unconfirmed',
        originalError: expect.objectContaining({
          message: 'account-state readback failed',
        }),
      })
      expect((await titleRequest(captured.hook)).ok).toBe(true)
      expect(sent.slice(2)).toEqual(['token-b'])
      expect(mutations).toBe(0)
      expect(loads).toBe(1)
      expect(readPool(path).accounts[0]?.refreshToken).toBe('old-a')
      expect(
        Object.values(
          readPool(path).accounts[0]?.rateLimitResetTimes ?? {},
        ).some(
          (resetAt) =>
            typeof resetAt === 'number' && resetAt > requestStartedAt,
        ),
      ).toBe(true)
    } finally {
      storeLoad.mockRestore()
      save.mockRestore()
      await captured.cleanup()
    }
  })

  for (const reason of ['ACCOUNT_INELIGIBLE', 'VALIDATION_REQUIRED'] as const) {
    test(`continues with B after ${reason} while account persistence is unconfirmed`, async () => {
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
      const sent: string[] = []
      let loads = 0
      let saveAttempts = 0
      let oauthMutations = 0
      let accountStateBeforeOAuth:
        | AccountStorageV4['accounts'][number]
        | undefined
      const captured = await setupPoolAdapter({
        authorizeAntigravity: async () => ({
          url: 'https://accounts.example/authorize?state=pool-state',
          verifier: 'verifier',
          projectId: '',
        }),
        waitForAntigravityCode: async () => 'code',
        exchangeAntigravity: async () => ({
          type: 'success',
          refresh: 'token-c',
          access: 'access-c',
          expires: Date.now() + 600_000,
          email: 'c@example.test',
          projectId: 'project',
        }),
        mutateAccountStorage: async (file, mutator) => {
          oauthMutations++
          const current = await loadAccountStorage(file)
          accountStateBeforeOAuth = current?.accounts.find(
            (account) => account.email === 'a@example.test',
          )
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
          if (sent.length === 2)
            return new Response(
              JSON.stringify({
                error: { status: reason, message: 'account blocked' },
              }),
              { status: 403 },
            )
          return successResponse()
        },
      })

      const storeLoad = spyOn(
        defaultAccountStorageStore,
        'load',
      ).mockImplementation(async (file) => {
        loads++
        if (loads === 2) throw new Error('state readback unavailable')
        return loadAccountStorage(file)
      })
      const save = spyOn(
        defaultAccountStorageStore,
        'saveMerged',
      ).mockImplementation(async (file, next) => {
        saveAttempts++
        await saveAccountStorage(file, next)
        throw new Error('state write result unknown')
      })

      try {
        expect((await titleRequest(captured.hook)).ok).toBe(true)
        expect(sent).toEqual(['old-a'])

        await expect(
          (await captured.oauth.authorize()).callback,
        ).rejects.toMatchObject({ state: 'unconfirmed' })
        expect(oauthMutations).toBe(0)
        expect(saveAttempts).toBe(1)

        expect((await titleRequest(captured.hook)).ok).toBe(true)
        expect(sent).toEqual(['old-a', 'old-a', 'token-b'])
        expect((await titleRequest(captured.hook)).ok).toBe(true)
        expect(sent.slice(-1)).toEqual(['token-b'])
        expect(saveAttempts).toBe(1)
        expect(oauthMutations).toBe(0)

        storeLoad.mockRestore()
        save.mockRestore()
        await expect(
          (await captured.oauth.authorize()).callback,
        ).resolves.toBeDefined()
        expect(oauthMutations).toBe(1)
        expect(accountStateBeforeOAuth).toMatchObject(
          reason === 'ACCOUNT_INELIGIBLE'
            ? {
                enabled: false,
                accountIneligible: true,
                accountIneligibleReason: reason,
              }
            : {
                enabled: false,
                verificationRequired: true,
                verificationRequiredReason: reason,
              },
        )
        const finalPool = readPool(path)
        expect(
          finalPool.accounts.map((account) => account.refreshToken),
        ).toEqual(['old-a', 'token-b', 'token-c'])
        expect(finalPool.accounts[0]).toMatchObject(
          reason === 'ACCOUNT_INELIGIBLE'
            ? {
                enabled: false,
                accountIneligible: true,
                accountIneligibleReason: reason,
              }
            : {
                enabled: false,
                verificationRequired: true,
                verificationRequiredReason: reason,
              },
        )
      } finally {
        storeLoad.mockRestore()
        save.mockRestore()
        await captured.cleanup()
      }
    })
  }

  test('continues with B after an ordinary eligibility-save failure and persists A when saving succeeds', async () => {
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
        return sent.length === 1
          ? new Response(
              JSON.stringify({
                error: { status: 'ACCOUNT_INELIGIBLE', message: 'blocked' },
              }),
              { status: 403 },
            )
          : successResponse()
      },
    })
    const save = spyOn(
      defaultAccountStorageStore,
      'saveMerged',
    ).mockRejectedValue(new Error('ordinary account-state save failure'))
    try {
      expect((await titleRequest(captured.hook)).ok).toBe(true)
      expect(sent).toEqual(['old-a', 'token-b'])
      expect(readPool(path).accounts[0]?.accountIneligible).toBeUndefined()
    } finally {
      save.mockRestore()
      await captured.cleanup()
    }

    const savedPath = seedPool([
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
    const savedSent: string[] = []
    const saved = await setupPoolAdapter({
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
        savedSent.push(auth.access ?? '')
        return savedSent.length === 1
          ? new Response(
              JSON.stringify({
                error: { status: 'ACCOUNT_INELIGIBLE', message: 'blocked' },
              }),
              { status: 403 },
            )
          : successResponse()
      },
    })
    try {
      expect((await titleRequest(saved.hook)).ok).toBe(true)
      expect(savedSent).toEqual(['old-a', 'token-b'])
      expect(readPool(savedPath).accounts[0]).toMatchObject({
        enabled: false,
        accountIneligible: true,
        accountIneligibleReason: 'ACCOUNT_INELIGIBLE',
      })
    } finally {
      await saved.cleanup()
    }
  })

  test('preserves A’s upstream eligibility error when no B account exists', async () => {
    seedPool([
      {
        email: 'a@example.test',
        refreshToken: 'old-a',
        addedAt: 1,
        lastUsed: 1,
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
      refreshAntigravityToken: async (refresh) => ({
        refresh,
        access: refresh,
        expires: Date.now() + 600_000,
      }),
      send: async ({ auth }) => {
        sent.push(auth.access ?? '')
        return new Response(
          JSON.stringify({
            error: { status: 'ACCOUNT_INELIGIBLE', message: 'blocked' },
          }),
          { status: 403 },
        )
      },
    })
    const save = spyOn(
      defaultAccountStorageStore,
      'saveMerged',
    ).mockRejectedValue(new Error('ordinary account-state save failure'))
    try {
      const response = await titleRequest(captured.hook)
      expect(response.status).toBe(502)
      expect(await response.text()).toContain(
        'Antigravity account is ineligible',
      )
      expect(sent).toEqual(['old-a'])
    } finally {
      save.mockRestore()
      await captured.cleanup()
    }
  })

  test('keeps a sent 403 terminal when its account-state flush crosses OAuth transition', async () => {
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
    const saveStarted = deferred<void>()
    const releaseSave = deferred<void>()
    const sent: string[] = []
    let sendCount = 0
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
      send: async ({ auth }) => {
        sendCount++
        sent.push(auth.access ?? '')
        if (sendCount === 2)
          return new Response(
            JSON.stringify({
              error: {
                status: 'ACCOUNT_INELIGIBLE',
                message: 'account blocked',
              },
            }),
            { status: 403 },
          )
        return successResponse()
      },
    })
    const save = spyOn(
      defaultAccountStorageStore,
      'saveMerged',
    ).mockImplementation(async (file, next) => {
      saveStarted.resolve()
      await releaseSave.promise
      return saveAccountStorage(file, next)
    })
    try {
      expect((await titleRequest(captured.hook)).ok).toBe(true)
      const pending403 = titleRequest(captured.hook)
      await saveStarted.promise
      const oauthCallback = (await captured.oauth.authorize()).callback
      await Bun.sleep(10)
      releaseSave.resolve()

      const response = await pending403
      await oauthCallback
      expect(response.status).toBe(502)
      expect(await response.text()).toContain(
        'Antigravity HTTP 403 (ACCOUNT_INELIGIBLE)',
      )
      expect(sent).toEqual(['old-a', 'old-a'])
    } finally {
      releaseSave.resolve()
      save.mockRestore()
      await captured.cleanup()
    }
  })

  test('continues to B after a retryable pool retirement fence fails', async () => {
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
    const saveStarted = deferred<void>()
    const releaseSave = deferred<void>()
    const sent: string[] = []
    let saveCalls = 0
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
      send: async ({ auth }) => {
        sent.push(auth.access ?? '')
        if (sent.length === 1) {
          return new Response(
            JSON.stringify({
              error: { status: 'ACCOUNT_INELIGIBLE', message: 'blocked' },
            }),
            { status: 403 },
          )
        }
        return successResponse()
      },
    })
    const save = spyOn(
      defaultAccountStorageStore,
      'saveMerged',
    ).mockImplementation(async () => {
      saveCalls++
      saveStarted.resolve()
      await releaseSave.promise
      throw new Error('retryable save failure')
    })
    try {
      const pendingRequest = titleRequest(captured.hook)
      await saveStarted.promise
      const oauthCallback = (await captured.oauth.authorize()).callback
      releaseSave.reject(new Error('retryable save failure'))
      await expect(oauthCallback).rejects.toThrow('persistence retryable')
      expect((await pendingRequest).ok).toBe(true)
      expect(sent).toEqual(['old-a', 'token-b'])
      expect(saveCalls).toBe(1)
      expect(mutations).toBe(0)
    } finally {
      releaseSave.resolve()
      save.mockRestore()
      await captured.cleanup()
    }
  })

  test('does not dispatch B after cancellation while persisting a 403 account flag', async () => {
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
    const saveStarted = deferred<void>()
    const releaseSave = deferred<void>()
    const sent: string[] = []
    let sendCount = 0
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
      send: async ({ auth }) => {
        sendCount++
        sent.push(auth.access ?? '')
        return sendCount === 2
          ? new Response(
              JSON.stringify({
                error: {
                  status: 'ACCOUNT_INELIGIBLE',
                  message: 'account blocked',
                },
              }),
              { status: 403 },
            )
          : successResponse()
      },
    })
    const save = spyOn(
      defaultAccountStorageStore,
      'saveMerged',
    ).mockImplementation(async (file, next) => {
      saveStarted.resolve()
      await releaseSave.promise
      return saveAccountStorage(file, next)
    })
    const controller = new AbortController()
    try {
      expect((await titleRequest(captured.hook)).ok).toBe(true)
      const pending403 = titleRequest(captured.hook, controller.signal)
      await saveStarted.promise
      controller.abort()
      releaseSave.resolve()
      await expect(pending403).rejects.toThrow()
      expect(sent).toEqual(['old-a', 'old-a'])
    } finally {
      releaseSave.resolve()
      save.mockRestore()
      await captured.cleanup()
    }
  })

  test('does not persist request success from a pool while its retirement is pending', async () => {
    seedPool([
      {
        email: 'a@example.test',
        refreshToken: 'old-a',
        addedAt: 1,
        lastUsed: 1,
        enabled: true,
      },
    ])
    const saveStarted = deferred<void>()
    const releaseSave = deferred<void>()
    const sentAgain = deferred<void>()
    const releaseSecondResponse = deferred<Response>()
    let sendCount = 0
    let saveCount = 0
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
      send: async () => {
        sendCount++
        if (sendCount === 2) {
          sentAgain.resolve()
          return releaseSecondResponse.promise
        }
        return successResponse()
      },
    })
    const save = spyOn(
      defaultAccountStorageStore,
      'saveMerged',
    ).mockImplementation(async (file, next) => {
      saveCount++
      if (saveCount === 1) {
        saveStarted.resolve()
        await releaseSave.promise
      }
      return saveAccountStorage(file, next)
    })
    try {
      expect((await titleRequest(captured.hook)).ok).toBe(true)
      await saveStarted.promise
      const pendingRequest = titleRequest(captured.hook)
      await sentAgain.promise
      const oauthCallback = (await captured.oauth.authorize()).callback
      await Bun.sleep(10)
      releaseSecondResponse.resolve(successResponse())
      expect((await pendingRequest).ok).toBe(true)
      expect(saveCount).toBe(1)
      releaseSave.resolve()
      await oauthCallback
      expect(saveCount).toBe(1)
    } finally {
      releaseSave.resolve()
      releaseSecondResponse.resolve(successResponse())
      save.mockRestore()
      await captured.cleanup()
    }
  })

  test('aborts a sent failure while it is waiting for pool retirement', async () => {
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
    const saveStarted = deferred<void>()
    const releaseSave = deferred<void>()
    const failureStarted = deferred<void>()
    const releaseFailure = deferred<Response>()
    const sent: string[] = []
    let sendCount = 0
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
        sendCount++
        sent.push(auth.access ?? '')
        if (sendCount === 2) {
          failureStarted.resolve()
          return releaseFailure.promise
        }
        return successResponse()
      },
    })
    const save = spyOn(
      defaultAccountStorageStore,
      'saveMerged',
    ).mockImplementation(async (file, next) => {
      saveStarted.resolve()
      await releaseSave.promise
      return saveAccountStorage(file, next)
    })
    const cancelled = new AbortController()
    try {
      expect((await titleRequest(captured.hook)).ok).toBe(true)
      await saveStarted.promise
      const pendingRequest = titleRequest(captured.hook, cancelled.signal)
      await failureStarted.promise
      const oauthCallback = (await captured.oauth.authorize()).callback
      await Bun.sleep(10)
      releaseFailure.resolve(
        new Response(JSON.stringify({ error: { message: 'limited' } }), {
          status: 429,
        }),
      )
      await Bun.sleep(10)
      cancelled.abort()
      await expect(pendingRequest).rejects.toThrow()
      releaseSave.resolve()
      await oauthCallback
      expect(sent).toEqual(['old-a', 'old-a'])
    } finally {
      cancelled.abort()
      releaseFailure.resolve(successResponse())
      releaseSave.resolve()
      save.mockRestore()
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

  test('does not install a rejected OAuth readback or leave its fingerprint saver orphaned', async () => {
    const path = seedPool([
      {
        email: 'a@example.test',
        refreshToken: 'old-a',
        addedAt: 1,
        lastUsed: 1,
        enabled: true,
        fingerprint: {
          deviceId: 'device',
          sessionToken: 'session',
          userAgent: buildAntigravityHarnessUserAgent(),
          apiClient: 'antigravity-cli',
          clientMetadata: {
            ideType: 'ANTIGRAVITY',
            platform: 'MACOS',
            pluginType: 'ANTIGRAVITY',
          },
          createdAt: 1,
        },
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
    let writes = 0
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
        const loaded = await loadAccountStorage(file)
        if (loads !== 2 || !loaded) return loaded
        return {
          ...loaded,
          accounts: loaded.accounts.map((account) =>
            account.email === 'a@example.test'
              ? {
                  ...account,
                  fingerprint: {
                    deviceId: 'stale-device',
                    sessionToken: 'stale-session',
                    userAgent: 'antigravity/cli/1.0.0 (legacy)',
                    apiClient: 'antigravity-cli',
                    clientMetadata: {
                      ideType: 'ANTIGRAVITY',
                      platform: 'MACOS',
                      pluginType: 'ANTIGRAVITY',
                    },
                    createdAt: 2,
                  },
                }
              : account,
          ),
        }
      },
      mutateAccountStorage: async (file, mutator) => {
        writes++
        if (writes === 1) return (await loadAccountStorage(file))!
        return mutateAccountStorage(file, mutator)
      },
    })
    try {
      await expect((await captured.oauth.authorize()).callback).rejects.toThrow(
        'not confirmed on disk',
      )
      await expect(
        (await captured.oauth.authorize()).callback,
      ).resolves.toBeDefined()
      await Bun.sleep(1100)
      expect(
        readPool(path).accounts.map((account) => account.refreshToken),
      ).toEqual(['new-a', 'token-b'])
      expect(writes).toBe(2)
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

  test('keeps a populated pool unavailable after missing OAuth readback until concrete recovery', async () => {
    seedPool([
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
    const recoveredPool: AccountStorageV4 = {
      version: 4,
      accounts: [],
      activeIndex: 0,
    }
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
        if (loads > 1 && !readable) return null
        if (readable && loads === 5) return recoveredPool
        return loadAccountStorage(file)
      },
      mutateAccountStorage: async (file, mutator) => {
        writes++
        return mutateAccountStorage(file, mutator)
      },
      send: async () => {
        sends++
        return successResponse()
      },
    })
    try {
      await expect(
        (await captured.oauth.authorize()).callback,
      ).rejects.toMatchObject({
        message: 'Antigravity account pool is unavailable',
        cause: expect.objectContaining({
          message: 'Antigravity OAuth account was not confirmed on disk',
        }),
      })
      await expect((await captured.oauth.authorize()).callback).rejects.toThrow(
        'unavailable',
      )
      expect(writes).toBe(1)
      expect(sends).toBe(0)
      readable = true
      await expect(
        (await captured.oauth.authorize()).callback,
      ).resolves.toBeDefined()
      expect(writes).toBe(2)
      expect(
        readPool(
          join(
            process.env.OPENCODE_CONFIG_DIR ?? '',
            'antigravity-accounts.json',
          ),
        ).accounts.map((account) => account.refreshToken),
      ).toEqual(['token-b', 'new-a'])
    } finally {
      await captured.cleanup()
    }
  })

  test('keeps known-empty first-run recovery compatible with missing reads', async () => {
    let loads = 0
    let writes = 0
    const captured = await setupPoolAdapter({
      loadAccountStorage: async (file) => {
        loads++
        if (loads === 1 || loads === 2 || loads === 3) return null
        return loadAccountStorage(file)
      },
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
        return mutateAccountStorage(file, mutator)
      },
    })
    try {
      await expect((await captured.oauth.authorize()).callback).rejects.toThrow(
        'not confirmed',
      )
      await expect(
        (await captured.oauth.authorize()).callback,
      ).resolves.toBeDefined()
      expect(writes).toBe(2)
      expect(loads).toBe(4)
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
