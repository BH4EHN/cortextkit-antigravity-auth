import { describe, expect, it, jest } from 'bun:test'
import {
  AccountManager,
  AccountManagerPersistenceError,
} from './account-manager.ts'
import type { AccountStorageStore } from './account-storage.ts'
import { mergeAccountStorage } from './account-storage.ts'
import type { AccountStorageV4 } from './account-types.ts'

function createStore(initial: AccountStorageV4 | null = null) {
  let state = initial
  let mergedSaves = 0
  let mutations = 0
  const store: AccountStorageStore = {
    load: async () => state,
    saveMerged: async (_path, next) => {
      mergedSaves++
      state = next
      return next
    },
    mutate: async (_path, fn) => {
      mutations++
      const current = state ?? { version: 4, accounts: [], activeIndex: 0 }
      state = (await fn(current)) ?? current
      return state
    },
    clear: async () => {
      state = null
    },
  }
  return {
    store,
    state: () => state,
    mergedSaves: () => mergedSaves,
    mutations: () => mutations,
  }
}

const stored: AccountStorageV4 = {
  version: 4,
  accounts: [
    { refreshToken: 'r1', projectId: 'p1', addedAt: 1, lastUsed: 0 },
    { refreshToken: 'r2', projectId: 'p2', addedAt: 1, lastUsed: 0 },
  ],
  activeIndex: 0,
}

describe('core AccountManager', () => {
  it('constructs from stored and fallback auth', () => {
    const memory = createStore(stored)
    const manager = new AccountManager(
      { type: 'oauth', refresh: 'r3|p3' },
      stored,
      { store: memory.store },
    )
    expect(
      manager.getAccounts().map((account) => account.parts.refreshToken),
    ).toEqual(['r1', 'r2', 'r3'])
  })

  it('normalizes persisted legacy quota keys for soft-quota and proactive-rotation reads', () => {
    const now = 1_700_000_000_000
    const legacy: AccountStorageV4 = {
      version: 4,
      accounts: [
        {
          refreshToken: 'legacy-token',
          addedAt: 1,
          lastUsed: 0,
          cachedQuota: {
            claude: { remainingFraction: 0.4, modelCount: 1 },
          },
          cachedQuotaUpdatedAt: now,
        },
        {
          refreshToken: 'other-token',
          addedAt: 1,
          lastUsed: 0,
        },
      ],
      activeIndex: 0,
    }
    const memory = createStore(legacy)
    const manager = new AccountManager(undefined, legacy, {
      store: memory.store,
      now: () => now,
    })
    const account = manager.getAccounts()[0]!

    expect(
      manager.isAccountOverSoftQuota(
        account,
        'claude',
        50,
        60_000,
        'claude-sonnet',
      ),
    ).toBe(true)
    expect(
      manager.shouldProactivelyRotate('claude', 'claude-sonnet', 50, 60_000),
    ).toBe(true)
  })

  it.each([
    'sticky',
    'round-robin',
    'hybrid',
  ] as const)('selects an account with %s strategy', (strategy) => {
    const memory = createStore(stored)
    const manager = new AccountManager(undefined, stored, {
      store: memory.store,
      now: () => 10_000,
    })
    expect(
      manager.getCurrentOrNextForFamily('gemini', 'gemini-3-pro', strategy),
    ).not.toBeNull()
  })

  it('hybrid skips the active Gemini account limited on the antigravity header style', () => {
    const now = 1_700_000_000_000
    const hybridStored: AccountStorageV4 = {
      version: 4,
      accounts: [
        { refreshToken: 'r1', projectId: 'p1', addedAt: 1, lastUsed: 0 },
        { refreshToken: 'r2', projectId: 'p2', addedAt: 1, lastUsed: 0 },
        { refreshToken: 'r3', projectId: 'p3', addedAt: 1, lastUsed: 0 },
        { refreshToken: 'r4', projectId: 'p4', addedAt: 1, lastUsed: 0 },
      ],
      activeIndex: 1,
      activeIndexByFamily: { gemini: 1 },
    }
    const memory = createStore(hybridStored)
    const manager = new AccountManager(undefined, hybridStored, {
      store: memory.store,
      now: () => now,
      random: () => 0.5,
    })
    const limited = manager.getAccounts()[1]!
    manager.markRateLimitedWithReason(
      limited,
      'gemini',
      'antigravity',
      'antigravity-gemini-3.6-flash',
      'RATE_LIMIT_EXCEEDED',
    )

    const selected = manager.getCurrentOrNextForFamily(
      'gemini',
      'antigravity-gemini-3.6-flash',
      'hybrid',
      'antigravity',
    )

    expect(selected?.index).toBe(0)
  })

  it('hybrid returns null when every Gemini account is limited on the antigravity header style', () => {
    const now = 1_700_000_000_000
    const hybridStored: AccountStorageV4 = {
      version: 4,
      accounts: [
        { refreshToken: 'r1', projectId: 'p1', addedAt: 1, lastUsed: 0 },
        { refreshToken: 'r2', projectId: 'p2', addedAt: 1, lastUsed: 0 },
        { refreshToken: 'r3', projectId: 'p3', addedAt: 1, lastUsed: 0 },
        { refreshToken: 'r4', projectId: 'p4', addedAt: 1, lastUsed: 0 },
      ],
      activeIndex: 1,
      activeIndexByFamily: { gemini: 1 },
    }
    const memory = createStore(hybridStored)
    const manager = new AccountManager(undefined, hybridStored, {
      store: memory.store,
      now: () => now,
      random: () => 0.5,
    })
    for (const account of manager.getAccounts()) {
      manager.markRateLimitedWithReason(
        account,
        'gemini',
        'antigravity',
        'antigravity-gemini-3.6-flash',
        'RATE_LIMIT_EXCEEDED',
      )
    }

    const selected = manager.getCurrentOrNextForFamily(
      'gemini',
      'antigravity-gemini-3.6-flash',
      'hybrid',
      'antigravity',
    )

    expect(selected).toBeNull()
  })

  it('tracks model-specific limits independently', () => {
    let now = 1_000
    const memory = createStore(stored)
    const manager = new AccountManager(undefined, stored, {
      store: memory.store,
      now: () => now,
      random: () => 0.5,
    })
    const first = manager.getAccounts()[0]!
    manager.markRateLimitedWithReason(
      first,
      'gemini',
      'antigravity',
      'gemini-3-pro',
      'RATE_LIMIT_EXCEEDED',
    )
    expect(
      manager.isRateLimitedForHeaderStyle(
        first,
        'gemini',
        'antigravity',
        'gemini-3-pro',
      ),
    ).toBe(true)
    expect(
      manager.isRateLimitedForHeaderStyle(
        first,
        'gemini',
        'antigravity',
        'gemini-3-flash',
      ),
    ).toBe(false)
    now += 30_001
    expect(
      manager.isRateLimitedForHeaderStyle(
        first,
        'gemini',
        'antigravity',
        'gemini-3-pro',
      ),
    ).toBe(false)
  })

  it('isolates child selection from its exact parent', () => {
    const memory = createStore(stored)
    const manager = new AccountManager(undefined, stored, {
      store: memory.store,
    })
    const select = (id: string, parentId?: string) =>
      manager.getCurrentOrNextForFamily(
        'gemini',
        null,
        'round-robin',
        'antigravity',
        false,
        100,
        600_000,
        { id, parentId },
      )?.index
    expect(select('root')).toBe(0)
    expect(select('child', 'root')).toBe(1)
  })

  it('uses destructive store mutation for replacement saves', async () => {
    const memory = createStore(stored)
    const manager = new AccountManager(undefined, stored, {
      store: memory.store,
    })
    manager.removeAccountByIndex(0)
    await manager.saveToDiskReplace()
    expect(memory.mutations()).toBe(1)
    expect(memory.state()?.accounts).toHaveLength(1)
  })

  it('persists and restores the cachedQuotaAccountId stamp across save→loadFromDisk', async () => {
    const seeded: AccountStorageV4 = {
      version: 4,
      accounts: [
        { refreshToken: 'r1', projectId: 'p1', addedAt: 1, lastUsed: 0 },
        { refreshToken: 'r2', projectId: 'p2', addedAt: 1, lastUsed: 0 },
      ],
      activeIndex: 0,
    }
    const memory = createStore(seeded)
    const manager = new AccountManager(undefined, seeded, {
      store: memory.store,
      now: () => 1_700_000_000_000,
    })
    // Seed a cached quota for the first account — this also stamps it with
    // the opaque identity derived from `r1`.
    manager.updateQuotaCache(0, {
      gemini: { remainingFraction: 0.42, modelCount: 1 },
    })
    expect(manager.getAccounts()[0]?.cachedQuotaAccountId).toMatch(
      /^[a-f0-9]{16}$/,
    )
    const expectedStamp = manager.getAccounts()[0]?.cachedQuotaAccountId

    await manager.saveToDiskReplace()

    const persisted = memory.state()
    expect(persisted?.accounts[0]?.cachedQuota).toEqual({
      gemini: { remainingFraction: 0.42, modelCount: 1 },
    })
    expect(persisted?.accounts[0]?.cachedQuotaAccountId).toBe(expectedStamp)

    // Roundtrip: a fresh manager built from the persisted snapshot must
    // surface the same stamp on the same account (same refresh token).
    const reloaded = new AccountManager(undefined, persisted ?? undefined, {
      store: memory.store,
      now: () => 1_700_000_001_000,
    })
    expect(reloaded.getAccounts()[0]?.cachedQuotaAccountId).toBe(expectedStamp)
    // Stamp mismatch path: a roundtripped account whose stored stamp no
    // longer matches its current refresh token is dropped at projection
    // time (no quota rendered) — see `toCommandAccountRow` /
    // `updateQuotaCache`. Here we just confirm the in-memory stamp is
    // present so the projection can decide.
    const tampered: AccountStorageV4 = {
      version: 4,
      accounts: [
        {
          refreshToken: 'r1',
          addedAt: 1,
          lastUsed: 0,
          // Stale stamp captured for a different refresh token.
          cachedQuotaAccountId: 'deadbeefcafebabe',
          cachedQuota: { gemini: { remainingFraction: 0.42, modelCount: 1 } },
        },
      ],
      activeIndex: 0,
    }
    const tamperedMemory = createStore(tampered)
    const tamperedManager = new AccountManager(undefined, tampered, {
      store: tamperedMemory.store,
    })
    expect(tamperedManager.getAccounts()[0]?.cachedQuotaAccountId).toBe(
      'deadbeefcafebabe',
    )
    // The next legitimate update rewrites the stamp from the current
    // refresh token, so a write to the same account cannot persist the
    // stale stamp forward.
    tamperedManager.updateQuotaCache(0, {
      gemini: { remainingFraction: 0.5, modelCount: 1 },
    })
    expect(tamperedManager.getAccounts()[0]?.cachedQuotaAccountId).not.toBe(
      'deadbeefcafebabe',
    )
  })

  it('persists and restores the captured tier schema marker across save→loadFromDisk', async () => {
    const seeded = {
      version: 4,
      accounts: [
        {
          refreshToken: 'r1',
          projectId: 'p1',
          addedAt: 1,
          lastUsed: 0,
          capturedTierId: 'free-tier',
          capturedTierAt: 1_700_000_000_000,
          capturedTierSchemaVersion: 1,
        },
      ],
      activeIndex: 0,
    } as AccountStorageV4 & {
      accounts: Array<{ capturedTierSchemaVersion?: number }>
    }
    const memory = createStore(seeded)
    const manager = new AccountManager(undefined, seeded, {
      store: memory.store,
    })

    await manager.saveToDiskReplace()

    expect(memory.state()?.accounts[0]).toMatchObject({
      capturedTierSchemaVersion: 1,
    })
    const reloaded = new AccountManager(
      undefined,
      memory.state() ?? undefined,
      { store: memory.store },
    )
    expect(
      (reloaded.getAccounts()[0] as { capturedTierSchemaVersion?: number })
        ?.capturedTierSchemaVersion,
    ).toBe(1)
  })

  it('drops the quota write when the refresh token captured at refresh time is gone (remove-during-refresh race)', () => {
    // Race: an async quota refresh is in flight for account A while the
    // user removes account A from the pool. When the refresh resolves,
    // index 0 now points at a different account (B). Without the
    // identity check the quota would be written onto B's slot — exactly
    // the cross-account misattribution P1#3 fixes.
    const seeded: AccountStorageV4 = {
      version: 4,
      accounts: [
        { refreshToken: 'r1', projectId: 'p1', addedAt: 1, lastUsed: 0 },
        { refreshToken: 'r2', projectId: 'p2', addedAt: 1, lastUsed: 0 },
      ],
      activeIndex: 0,
    }
    const memory = createStore(seeded)
    const manager = new AccountManager(undefined, seeded, {
      store: memory.store,
    })

    // Capture the refresh token BEFORE the (simulated) async refresh
    // resolves. The caller is expected to pass this as
    // `expectedRefreshToken` so the write is bound to the right account.
    const refreshTokenForA = manager.getAccounts()[0]?.parts.refreshToken
    expect(refreshTokenForA).toBe('r1')

    // Concurrent user action: remove account A. Account B (r2) now sits
    // at index 0.
    expect(manager.removeAccountByIndex(0)).toBe(true)
    expect(manager.getAccounts()[0]?.parts.refreshToken).toBe('r2')

    // The async refresh finally resolves. The caller re-resolves the
    // live index for `r1` (which is now `-1`) and the quota write is
    // then attempted via `updateQuotaCache` at index 0 with the
    // captured `expectedRefreshToken`. The guard MUST drop the write
    // because the captured token no longer matches the account at
    // index 0 — B would otherwise receive A's quota percentages.
    const liveIndex = manager
      .getAccounts()
      .findIndex((entry) => entry.parts.refreshToken === refreshTokenForA)
    expect(liveIndex).toBe(-1)
    manager.updateQuotaCache(
      0,
      { gemini: { remainingFraction: 0.42, modelCount: 1 } },
      refreshTokenForA,
    )
    // No quota should have landed on whichever account shifted into
    // index 0.
    expect(manager.getAccounts()[0]?.cachedQuota).toBeUndefined()
    expect(manager.getAccounts()[0]?.cachedQuotaAccountId).toBeUndefined()
  })

  it('coalesces requested saves and dispose flushes immediately', async () => {
    const memory = createStore(stored)
    const manager = new AccountManager(undefined, stored, {
      store: memory.store,
    })
    manager.requestSaveToDisk()
    manager.requestSaveToDisk()
    await manager.dispose()
    expect(memory.mergedSaves()).toBe(1)
  })

  it.each([
    ['merge', (manager: AccountManager) => manager.saveToDisk()],
    ['replace', (manager: AccountManager) => manager.saveToDiskReplace()],
  ] as const)('dispose waits for an in-flight direct %s save', async (_kind, save) => {
    let release!: () => void
    let started!: () => void
    const saveStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    const memory = createStore(stored)
    const manager = new AccountManager(undefined, stored, {
      store: {
        ...memory.store,
        saveMerged: async (path, next) => {
          started()
          await new Promise<void>((resolve) => {
            release = resolve
          })
          return memory.store.saveMerged(path, next)
        },
        mutate: async (path, fn) => {
          started()
          await new Promise<void>((resolve) => {
            release = resolve
          })
          return memory.store.mutate(path, fn)
        },
      },
    })

    const saving = save(manager)
    await saveStarted
    let disposed = false
    const disposing = manager.dispose().then(() => {
      disposed = true
    })
    for (let turn = 0; turn < 5; turn++) await Promise.resolve()
    expect(disposed).toBe(false)

    release()
    await Promise.all([saving, disposing])
    expect(disposed).toBe(true)
  })

  it('dispose drains queued direct saves across repeated calls', async () => {
    let releaseFirst!: () => void
    let startedFirst!: () => void
    let startedSecond!: () => void
    const firstStarted = new Promise<void>((resolve) => {
      startedFirst = resolve
    })
    const secondStarted = new Promise<void>((resolve) => {
      startedSecond = resolve
    })
    let calls = 0
    const memory = createStore(stored)
    const manager = new AccountManager(undefined, stored, {
      store: {
        ...memory.store,
        saveMerged: async (path, next) => {
          calls++
          startedFirst()
          await new Promise<void>((resolve) => {
            releaseFirst = resolve
          })
          return memory.store.saveMerged(path, next)
        },
        mutate: async (path, fn) => {
          calls++
          startedSecond()
          return memory.store.mutate(path, fn)
        },
      },
    })

    const firstSave = manager.saveToDisk()
    const queuedSave = manager.saveToDiskReplace()
    await firstStarted
    let firstDisposeDone = false
    const firstDispose = manager.dispose().then(() => {
      firstDisposeDone = true
    })
    for (let turn = 0; turn < 5; turn++) await Promise.resolve()
    const secondDispose = manager.dispose()
    for (let turn = 0; turn < 5; turn++) await Promise.resolve()
    expect(firstDisposeDone).toBe(false)
    releaseFirst()
    await secondStarted
    let secondDisposeDone = false
    const observedSecondDispose = secondDispose.then(() => {
      secondDisposeDone = true
    })
    for (let turn = 0; turn < 5; turn++) await Promise.resolve()
    expect(secondDisposeDone).toBe(false)
    await Promise.all([
      firstSave,
      queuedSave,
      firstDispose,
      observedSecondDispose,
    ])
    expect(calls).toBe(2)
  })

  it('dispose waits through a failed direct save without adding another write', async () => {
    let release!: () => void
    let started!: () => void
    const saveStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    const memory = createStore(stored)
    let calls = 0
    const manager = new AccountManager(undefined, stored, {
      store: {
        ...memory.store,
        saveMerged: async () => {
          calls++
          started()
          await new Promise<void>((resolve) => {
            release = resolve
          })
          throw new Error('direct save failed')
        },
      },
    })

    const saving = manager.saveToDisk()
    await saveStarted
    let disposed = false
    const disposing = manager.dispose().then(() => {
      disposed = true
    })
    for (let turn = 0; turn < 5; turn++) await Promise.resolve()
    expect(disposed).toBe(false)
    release()
    await expect(saving).rejects.toThrow('direct save failed')
    await disposing
    expect(disposed).toBe(true)
    expect(calls).toBe(1)
    expect(memory.mergedSaves()).toBe(0)
  })

  it.each([
    true,
    false,
  ])('dispose waits for an accepted fence reconciliation (retrySucceeds=%s)', async (retrySucceeds) => {
    const memory = createStore(stored)
    let releaseRetry!: () => void
    let retryStarted!: () => void
    const retryStartedPromise = new Promise<void>((resolve) => {
      retryStarted = resolve
    })
    let mergeAttempts = 0
    let retryAttempts = 0
    const manager = new AccountManager(undefined, stored, {
      store: {
        ...memory.store,
        saveMerged: async () => {
          mergeAttempts++
          throw new Error('ELOCKED')
        },
        mutate: async (path, fn) => {
          retryAttempts++
          retryStarted()
          await new Promise<void>((resolve, reject) => {
            releaseRetry = () => {
              if (!retrySucceeds) {
                reject(new Error('retry failed'))
                return
              }
              resolve()
            }
          })
          return memory.store.mutate(path, fn)
        },
      },
    })

    await expect(manager.saveToDisk()).rejects.toThrow('ELOCKED')
    const fence = manager.flushAndStopSaving()
    await retryStartedPromise
    let fenceSettled = false
    const observedFence = fence.then(
      () => {
        fenceSettled = true
        return 'resolved'
      },
      () => {
        fenceSettled = true
        return 'rejected'
      },
    )
    let disposed = false
    const disposing = manager.dispose().then(() => {
      disposed = true
    })
    for (let turn = 0; turn < 5; turn++) await Promise.resolve()
    expect(fenceSettled).toBe(false)
    expect(disposed).toBe(false)

    releaseRetry()
    expect(await observedFence).toBe(retrySucceeds ? 'resolved' : 'rejected')
    await disposing
    expect(disposed).toBe(true)
    expect(mergeAttempts).toBe(1)
    expect(retryAttempts).toBe(1)
    expect(memory.mutations()).toBe(retrySucceeds ? 1 : 0)
  })

  it('retires a clean manager without rewriting external pool metadata', async () => {
    const memory = createStore(stored)
    const manager = new AccountManager(undefined, stored, {
      store: memory.store,
    })
    await memory.store.mutate('', (current) => ({
      ...current,
      accounts: current.accounts.map((account, index) =>
        index === 0 ? { ...account, label: 'external edit' } : account,
      ),
    }))
    await manager.flushAndStopSaving()
    expect(memory.mergedSaves()).toBe(0)
    expect(memory.state()?.accounts[0]?.label).toBe('external edit')
    await expect(manager.saveToDisk()).rejects.toThrow(
      'persistence has stopped',
    )
  })

  it('keeps a lock-failed deferred save retryable on the same manager', async () => {
    const memory = createStore(stored)
    let locked = true
    const manager = new AccountManager(undefined, stored, {
      store: {
        ...memory.store,
        saveMerged: async (path, next) => {
          if (locked) throw new Error('ELOCKED')
          return memory.store.saveMerged(path, next)
        },
      },
    })
    manager.requestSaveToDisk()
    await expect(manager.flushAndStopSaving()).rejects.toBeInstanceOf(
      AccountManagerPersistenceError,
    )
    locked = false
    await manager.flushAndStopSaving()
    expect(memory.mutations()).toBe(1)
    expect(memory.state()?.accounts).toHaveLength(2)
  })

  it('lets an ordinary save continue after a retryable fence', async () => {
    jest.useFakeTimers()
    try {
      const memory = createStore(stored)
      let locked = true
      const manager = new AccountManager(undefined, stored, {
        store: {
          ...memory.store,
          saveMerged: async (path, next) => {
            if (locked) throw new Error('ELOCKED')
            return memory.store.saveMerged(path, next)
          },
        },
      })
      manager.requestSaveToDisk()
      await expect(manager.flushAndStopSaving()).rejects.toMatchObject({
        state: 'retryable',
      })
      locked = false
      manager.requestSaveToDisk()
      const ordinary = manager.flushSaveToDisk({ strict: true })
      await jest.advanceTimersByTime(1000)
      await expect(ordinary).resolves.toBeUndefined()
      await manager.flushAndStopSaving()
      expect(memory.state()?.accounts).toHaveLength(2)
    } finally {
      jest.useRealTimers()
    }
  })

  it('confirms a post-write error by read-back without replaying it', async () => {
    const memory = createStore(stored)
    let calls = 0
    const manager = new AccountManager(undefined, stored, {
      store: {
        ...memory.store,
        saveMerged: async (path, next) => {
          calls++
          await memory.store.mutate(path, (current) =>
            mergeAccountStorage(current, next),
          )
          throw new Error('response lost')
        },
      },
    })
    manager.requestSaveToDisk()
    await manager.flushAndStopSaving()
    expect(calls).toBe(1)
  })

  it('holds an ambiguous write fenced until read-back can confirm it', async () => {
    const memory = createStore(stored)
    let readable = false
    let loadCalls = 0
    let calls = 0
    const manager = new AccountManager(undefined, stored, {
      store: {
        ...memory.store,
        load: async (path) => {
          loadCalls++
          if (loadCalls === 1) return memory.store.load(path)
          if (!readable) throw new Error('read unavailable')
          return memory.store.load(path)
        },
        saveMerged: async (path, next) => {
          calls++
          await memory.store.mutate(path, (current) =>
            mergeAccountStorage(current, next),
          )
          throw new Error('response lost')
        },
      },
    })
    manager.requestSaveToDisk()
    await expect(manager.flushAndStopSaving()).rejects.toMatchObject({
      state: 'unconfirmed',
    })
    await expect(manager.saveToDisk()).rejects.toThrow(
      'persistence has stopped',
    )
    readable = true
    await manager.flushAndStopSaving()
    expect(calls).toBe(1)
  })

  it('confirms the original nested snapshot and then saves late intent', async () => {
    const memory = createStore(stored)
    let releaseRead!: () => void
    let readStarted!: () => void
    const reading = new Promise<void>((resolve) => {
      readStarted = resolve
    })
    let loadCalls = 0
    let saves = 0
    const manager = new AccountManager(undefined, stored, {
      store: {
        ...memory.store,
        load: async (path) => {
          loadCalls++
          if (loadCalls === 2) {
            readStarted()
            await new Promise<void>((resolve) => {
              releaseRead = resolve
            })
          }
          return memory.store.load(path)
        },
        saveMerged: async (path, next) => {
          saves++
          await memory.store.mutate(path, (current) =>
            mergeAccountStorage(current, next),
          )
          if (saves === 1) throw new Error('response lost')
          return next
        },
      },
    })
    manager.requestSaveToDisk()
    const fence = manager.flushAndStopSaving()
    await reading
    manager.getAccounts()[0]!.rateLimitResetTimes.claude = 999
    manager.requestSaveToDisk()
    releaseRead()
    await fence
    expect(saves).toBe(2)
    expect(memory.state()?.accounts[0]?.rateLimitResetTimes?.claude).toBe(999)
  })

  it('does not require a readable baseline for an ordinary successful save', async () => {
    const memory = createStore(stored)
    const manager = new AccountManager(undefined, stored, {
      store: {
        ...memory.store,
        load: async () => {
          throw new Error('read unavailable')
        },
      },
    })
    manager.requestSaveToDisk()
    await manager.flushAndStopSaving()
    expect(memory.mergedSaves()).toBe(1)
  })

  it('does not infer a failed write from read-back without its baseline', async () => {
    const memory = createStore(stored)
    let loadCalls = 0
    let saves = 0
    const manager = new AccountManager(undefined, stored, {
      store: {
        ...memory.store,
        load: async (path) => {
          loadCalls++
          if (loadCalls === 1) throw new Error('baseline unavailable')
          return memory.store.load(path)
        },
        saveMerged: async (path, next) => {
          saves++
          await memory.store.mutate(path, (current) =>
            mergeAccountStorage(current, next),
          )
          throw new Error('response lost')
        },
      },
    })
    manager.requestSaveToDisk()
    await expect(manager.flushAndStopSaving()).rejects.toMatchObject({
      state: 'unconfirmed',
    })
    await expect(manager.flushAndStopSaving()).rejects.toMatchObject({
      state: 'unconfirmed',
    })
    expect(saves).toBe(1)
  })

  it('closes direct-save admission and drains a late requested save', async () => {
    const memory = createStore(stored)
    let release!: () => void
    let started!: () => void
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    let calls = 0
    const manager = new AccountManager(undefined, stored, {
      store: {
        ...memory.store,
        saveMerged: async (path, next) => {
          calls++
          if (calls === 1) {
            started()
            await new Promise<void>((resolve) => {
              release = resolve
            })
          }
          await memory.store.mutate(path, (current) =>
            mergeAccountStorage(current, next),
          )
          return next
        },
      },
    })
    const direct = manager.saveToDisk()
    await firstStarted
    const fence = manager.flushAndStopSaving()
    await expect(manager.saveToDisk()).rejects.toThrow(
      'persistence has stopped',
    )
    manager.getAccounts()[0]!.label = 'late'
    manager.requestSaveToDisk()
    release()
    await Promise.all([direct, fence])
    expect(calls).toBe(2)
    expect(memory.state()?.accounts[0]?.label).toBe('late')
  })

  it('keeps a failed replacement fenced when read-back differs from both states', async () => {
    const memory = createStore(stored)
    const manager = new AccountManager(undefined, stored, {
      store: {
        ...memory.store,
        mutate: async (path, fn) => {
          await memory.store.mutate(path, fn)
          await memory.store.mutate(path, (current) => ({
            ...current,
            accounts: current.accounts.map((account, index) =>
              index === 0 ? { ...account, label: 'external' } : account,
            ),
          }))
          throw new Error('response lost')
        },
      },
    })
    const replacement = manager.saveToDiskReplace()
    await expect(replacement).rejects.toThrow('response lost')
    await expect(manager.flushAndStopSaving()).rejects.toMatchObject({
      state: 'unconfirmed',
    })
    expect(memory.state()?.accounts[0]?.label).toBe('external')
    await expect(manager.saveToDiskReplace()).rejects.toThrow(
      'persistence has stopped',
    )
  })

  it('does not replay a failed replacement over a changed pool', async () => {
    const memory = createStore(stored)
    let locked = true
    const manager = new AccountManager(undefined, stored, {
      store: {
        ...memory.store,
        mutate: async (path, fn) => {
          if (locked) throw new Error('ELOCKED')
          return memory.store.mutate(path, fn)
        },
      },
    })
    manager.removeAccountByIndex(0)
    await expect(manager.saveToDiskReplace()).rejects.toThrow('ELOCKED')
    await memory.store.mutate('', (current) => ({
      ...current,
      accounts: current.accounts.map((account, index) =>
        index === 0 ? { ...account, label: 'external' } : account,
      ),
    }))
    locked = false
    await expect(manager.flushAndStopSaving()).rejects.toMatchObject({
      state: 'unconfirmed',
    })
    expect(
      memory.state()?.accounts.map((account) => account.refreshToken),
    ).toEqual(['r1', 'r2'])
    expect(memory.state()?.accounts[0]?.label).toBe('external')
  })

  it('retries the exact failed replacement and keeps the removal', async () => {
    const memory = createStore(stored)
    let locked = true
    const manager = new AccountManager(undefined, stored, {
      store: {
        ...memory.store,
        mutate: async (path, fn) => {
          if (locked) throw new Error('ELOCKED')
          return memory.store.mutate(path, fn)
        },
      },
    })
    manager.removeAccountByIndex(0)
    await expect(manager.saveToDiskReplace()).rejects.toThrow('ELOCKED')
    locked = false
    await manager.flushAndStopSaving()
    expect(
      memory.state()?.accounts.map((account) => account.refreshToken),
    ).toEqual(['r2'])
    expect(memory.mergedSaves()).toBe(0)
  })

  it('rejects a failed merge retry after external token rotation', async () => {
    const memory = createStore(stored)
    const manager = new AccountManager(undefined, stored, {
      store: {
        ...memory.store,
        saveMerged: async () => {
          throw new Error('ELOCKED')
        },
      },
    })
    manager.requestSaveToDisk()
    await expect(manager.flushAndStopSaving()).rejects.toMatchObject({
      state: 'retryable',
    })
    await memory.store.mutate('', (current) => ({
      ...current,
      accounts: current.accounts.map((account, index) =>
        index === 0 ? { ...account, refreshToken: 'rotated' } : account,
      ),
    }))
    await expect(manager.flushAndStopSaving()).rejects.toMatchObject({
      state: 'unconfirmed',
    })
    expect(
      memory.state()?.accounts.map((account) => account.refreshToken),
    ).toEqual(['rotated', 'r2'])
    expect(memory.mutations()).toBe(2)
  })

  for (const kind of ['merge', 'replace'] as const) {
    it(`retains a newer ${kind} intent when reconciliation fails again`, async () => {
      const memory = createStore(stored)
      let locked = true
      const manager = new AccountManager(undefined, stored, {
        store: {
          ...memory.store,
          saveMerged: async (path, next) => {
            if (locked) throw new Error('ELOCKED')
            return memory.store.saveMerged(path, next)
          },
          mutate: async (path, fn) => {
            if (locked) throw new Error('ELOCKED')
            return memory.store.mutate(path, fn)
          },
        },
      })
      await expect(manager.saveToDisk()).rejects.toThrow('ELOCKED')
      manager.getAccounts()[1]!.label = 'retained newer intent'
      manager.getAccounts()[1]!.rateLimitResetTimes.claude = 999
      if (kind === 'replace') manager.removeAccountByIndex(0)
      const newer =
        kind === 'replace' ? manager.saveToDiskReplace() : manager.saveToDisk()
      await expect(newer).rejects.toThrow('ELOCKED')
      locked = false
      await manager.flushAndStopSaving()
      expect(
        memory
          .state()
          ?.accounts.find((account) => account.refreshToken === 'r2'),
      ).toMatchObject({
        label: 'retained newer intent',
        rateLimitResetTimes: { claude: 999 },
      })
      expect(
        memory.state()?.accounts.map((account) => account.refreshToken),
      ).toEqual(kind === 'replace' ? ['r2'] : ['r1', 'r2'])
    })
  }

  it('keeps a deferred replacement from overwriting a concurrent edit after recovery', async () => {
    const memory = createStore(stored)
    let locked = true
    let mutations = 0
    const manager = new AccountManager(undefined, stored, {
      store: {
        ...memory.store,
        saveMerged: async () => {
          throw new Error('ELOCKED')
        },
        mutate: async (path, fn) => {
          if (locked) throw new Error('ELOCKED')
          mutations++
          if (mutations === 2) {
            await memory.store.mutate(path, (current) => ({
              ...current,
              accounts: current.accounts.map((account, index) =>
                index === 0
                  ? { ...account, refreshToken: 'externally-rotated' }
                  : account,
              ),
            }))
          }
          return memory.store.mutate(path, fn)
        },
      },
    })
    await expect(manager.saveToDisk()).rejects.toThrow('ELOCKED')
    manager.removeAccountByIndex(0)
    await expect(manager.saveToDiskReplace()).rejects.toThrow('ELOCKED')
    locked = false
    await expect(manager.flushAndStopSaving()).rejects.toMatchObject({
      state: 'unconfirmed',
    })
    expect(
      memory.state()?.accounts.map((account) => account.refreshToken),
    ).toEqual(['externally-rotated', 'r2'])
    expect(manager.getAccounts()[0]?.parts.refreshToken).toBe('r2')
    await expect(manager.saveToDisk()).rejects.toThrow(
      'persistence has stopped',
    )
  })

  it('serializes a queued new save with fence reconciliation of an older failure', async () => {
    const memory = createStore(stored)
    let retryCalls = 0
    let mergedCalls = 0
    let releaseRetry!: () => void
    let retryStarted!: () => void
    const retrying = new Promise<void>((resolve) => {
      retryStarted = resolve
    })
    const gate = new Promise<void>((resolve) => {
      releaseRetry = resolve
    })
    const manager = new AccountManager(undefined, stored, {
      store: {
        ...memory.store,
        saveMerged: async (path, next) => {
          mergedCalls++
          if (mergedCalls === 1) throw new Error('ELOCKED')
          await memory.store.mutate(path, (current) =>
            mergeAccountStorage(current, next),
          )
          return next
        },
        mutate: async (path, fn) => {
          retryCalls++
          if (retryCalls === 1) {
            retryStarted()
            await gate
          }
          return memory.store.mutate(path, fn)
        },
      },
    })
    await expect(manager.saveToDisk()).rejects.toThrow('ELOCKED')
    manager.getAccounts()[0]!.label = 'new intent'
    const second = manager.saveToDisk()
    const fence = manager.flushAndStopSaving()
    await retrying
    await Promise.resolve()
    await Promise.resolve()
    const callsBeforeRelease = retryCalls
    releaseRetry()
    const results = await Promise.allSettled([second, fence])
    expect(callsBeforeRelease).toBe(1)
    expect(results.map((result) => result.status)).toEqual([
      'fulfilled',
      'fulfilled',
    ])
    expect(memory.state()?.accounts[0]?.label).toBe('new intent')
  })

  for (const kind of ['merge', 'replace'] as const) {
    it(`captures queued ${kind} save snapshots at invocation time`, async () => {
      const initial: AccountStorageV4 = {
        version: 4,
        accounts: [
          ...stored.accounts,
          { refreshToken: 'r3', projectId: 'p3', addedAt: 1, lastUsed: 0 },
        ],
        activeIndex: 0,
      }
      const memory = createStore(initial)
      let releaseFirst!: () => void
      let firstStarted!: () => void
      const firstStartedPromise = new Promise<void>((resolve) => {
        firstStarted = resolve
      })
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve
      })
      const writes: Array<{ operation: string; state: AccountStorageV4 }> = []
      const record = async (
        operation: string,
        state: AccountStorageV4,
      ): Promise<void> => {
        const attempt = writes.length + 1
        writes.push({ operation, state: structuredClone(state) })
        if (attempt === 1) {
          firstStarted()
          await firstGate
        }
        if (attempt === 2) throw new Error('ELOCKED')
      }
      const manager = new AccountManager(undefined, initial, {
        store: {
          ...memory.store,
          saveMerged: async (path, next) => {
            await record('merge', next)
            await memory.store.mutate(path, (current) =>
              mergeAccountStorage(current, next),
            )
            return next
          },
          mutate: async (path, fn) => {
            const current = memory.state() ?? {
              version: 4 as const,
              accounts: [],
              activeIndex: 0,
            }
            const next = await fn(current)
            if (!next) return current
            await record('replace', next)
            return memory.store.mutate(path, () => next)
          },
        },
      })
      // Keep collection edits local to the explicit saves under observation.
      manager.requestSaveToDisk = () => {}

      const first = manager.saveToDisk()
      await firstStartedPromise

      if (kind === 'replace') manager.removeAccountByIndex(0)
      const secondAccount = manager
        .getAccounts()
        .find((account) => account.parts.refreshToken === 'r3')!
      secondAccount.label = 'second snapshot'
      secondAccount.rateLimitResetTimes.claude = 333
      const second =
        kind === 'replace' ? manager.saveToDiskReplace() : manager.saveToDisk()
      const secondExpectedTokens =
        kind === 'replace' ? ['r2', 'r3'] : ['r1', 'r2', 'r3']
      manager.removeAccountByIndex(0)
      const thirdAccount = manager
        .getAccounts()
        .find((account) => account.parts.refreshToken === 'r3')!
      thirdAccount.label = 'third snapshot'
      thirdAccount.rateLimitResetTimes.claude = 777
      const third =
        kind === 'replace' ? manager.saveToDiskReplace() : manager.saveToDisk()
      const fence = manager.flushAndStopSaving()

      releaseFirst()
      const results = await Promise.allSettled([first, second, third, fence])
      expect(results.map((result) => result.status)).toEqual([
        'fulfilled',
        'rejected',
        'fulfilled',
        'fulfilled',
      ])
      expect((results[1] as PromiseRejectedResult).reason).toMatchObject({
        message: 'ELOCKED',
      })
      expect(writes.map((write) => write.operation)).toEqual(
        kind === 'merge'
          ? ['merge', 'merge', 'replace', 'replace']
          : ['merge', 'replace', 'replace', 'replace'],
      )
      expect(
        writes[1]!.state.accounts.map((account) => account.refreshToken),
      ).toEqual(secondExpectedTokens)
      expect(
        writes[2]!.state.accounts.find(
          (account) => account.refreshToken === 'r3',
        )?.label,
      ).toBe('second snapshot')
      expect(
        writes[3]!.state.accounts.map((account) => account.refreshToken),
      ).toEqual(kind === 'replace' ? ['r3'] : ['r1', 'r2', 'r3'])
      expect(
        writes[3]!.state.accounts.find(
          (account) => account.refreshToken === 'r3',
        ),
      ).toMatchObject({
        label: 'third snapshot',
        rateLimitResetTimes: { claude: 777 },
      })
      expect(
        memory.state()?.accounts.map((account) => account.refreshToken),
      ).toEqual(kind === 'replace' ? ['r3'] : ['r1', 'r2', 'r3'])
      expect(
        memory
          .state()
          ?.accounts.find((account) => account.refreshToken === 'r3'),
      ).toMatchObject({
        label: 'third snapshot',
        rateLimitResetTimes: { claude: 777 },
      })
    })
  }

  for (const kind of ['merge', 'replace'] as const) {
    it(`fence retry keeps a failed ${kind} intent after later memory changes`, async () => {
      const initial: AccountStorageV4 = {
        version: 4,
        accounts: [
          ...stored.accounts,
          { refreshToken: 'r3', projectId: 'p3', addedAt: 1, lastUsed: 0 },
        ],
        activeIndex: 0,
      }
      const memory = createStore(initial)
      let releaseFirst!: () => void
      let firstStarted!: () => void
      const firstStartedPromise = new Promise<void>((resolve) => {
        firstStarted = resolve
      })
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve
      })
      const writes: Array<{ operation: string; state: AccountStorageV4 }> = []
      const record = async (
        operation: string,
        state: AccountStorageV4,
      ): Promise<void> => {
        const attempt = writes.length + 1
        writes.push({ operation, state: structuredClone(state) })
        if (attempt === 1) {
          firstStarted()
          await firstGate
        }
        if (attempt === 2) throw new Error('ELOCKED')
      }
      const manager = new AccountManager(undefined, initial, {
        store: {
          ...memory.store,
          saveMerged: async (path, next) => {
            await record('merge', next)
            await memory.store.mutate(path, (current) =>
              mergeAccountStorage(current, next),
            )
            return next
          },
          mutate: async (path, fn) => {
            const current = memory.state() ?? {
              version: 4 as const,
              accounts: [],
              activeIndex: 0,
            }
            const next = await fn(current)
            if (!next) return current
            await record('replace', next)
            return memory.store.mutate(path, () => next)
          },
        },
      })
      manager.requestSaveToDisk = () => {}

      const first = manager.saveToDisk()
      await firstStartedPromise

      if (kind === 'replace') manager.removeAccountByIndex(0)
      const secondAccount = manager
        .getAccounts()
        .find((account) => account.parts.refreshToken === 'r3')!
      secondAccount.label = 'second snapshot'
      secondAccount.rateLimitResetTimes.claude = 333
      const second =
        kind === 'replace' ? manager.saveToDiskReplace() : manager.saveToDisk()
      const secondExpectedTokens =
        kind === 'replace' ? ['r2', 'r3'] : ['r1', 'r2', 'r3']

      // These edits happen after the second intent is frozen and before it
      // reaches its failing write.
      manager.removeAccountByIndex(0)
      const changedAccount = manager
        .getAccounts()
        .find((account) => account.parts.refreshToken === 'r3')!
      changedAccount.label = 'changed before failure'
      changedAccount.rateLimitResetTimes.claude = 555

      releaseFirst()
      await first
      await expect(second).rejects.toThrow('ELOCKED')

      // Mutate again after ELOCKED, without admitting another direct save.
      changedAccount.label = 'changed after failure'
      changedAccount.rateLimitResetTimes.claude = 999
      await manager.flushAndStopSaving()

      expect(writes.map((write) => write.operation)).toEqual(
        kind === 'merge'
          ? ['merge', 'merge', 'replace']
          : ['merge', 'replace', 'replace'],
      )
      expect(
        writes[1]!.state.accounts.map((account) => account.refreshToken),
      ).toEqual(secondExpectedTokens)
      expect(
        writes[1]!.state.accounts.find(
          (account) => account.refreshToken === 'r3',
        ),
      ).toMatchObject({
        label: 'second snapshot',
        rateLimitResetTimes: { claude: 333 },
      })
      expect(
        writes[2]!.state.accounts.map((account) => account.refreshToken),
      ).toEqual(secondExpectedTokens)
      expect(
        writes[2]!.state.accounts.find(
          (account) => account.refreshToken === 'r3',
        ),
      ).toMatchObject({
        label: 'second snapshot',
        rateLimitResetTimes: { claude: 333 },
      })
      expect(
        memory.state()?.accounts.map((account) => account.refreshToken),
      ).toEqual(kind === 'replace' ? ['r2', 'r3'] : ['r1', 'r2', 'r3'])
      expect(
        memory
          .state()
          ?.accounts.find((account) => account.refreshToken === 'r3'),
      ).toMatchObject({
        label: 'second snapshot',
        rateLimitResetTimes: { claude: 333 },
      })
    })
  }

  it('accepts a later successful save after an earlier admitted save fails', async () => {
    const memory = createStore(stored)
    let releaseFirst!: () => void
    let firstStarted!: () => void
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve
    })
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let saves = 0
    const manager = new AccountManager(undefined, stored, {
      store: {
        ...memory.store,
        saveMerged: async (path, next) => {
          saves++
          if (saves === 1) {
            firstStarted()
            await gate
            throw new Error('ELOCKED')
          }
          await memory.store.mutate(path, (current) =>
            mergeAccountStorage(current, next),
          )
          return next
        },
      },
    })
    const first = manager.saveToDisk()
    await started
    manager.getAccounts()[0]!.label = 'later intent'
    const second = manager.saveToDisk()
    const fence = manager.flushAndStopSaving()
    releaseFirst()
    const results = await Promise.allSettled([first, second, fence])
    expect(results.map((result) => result.status)).toEqual([
      'rejected',
      'fulfilled',
      'fulfilled',
    ])
    expect(memory.state()?.accounts[0]?.label).toBe('later intent')
  })

  it('stops stale deferred saves before an external pool mutation', async () => {
    const memory = createStore(stored)
    const manager = new AccountManager(undefined, stored, {
      store: memory.store,
    })
    manager.requestSaveToDisk()
    const pendingFlush = manager.flushSaveToDisk().then(
      () => 'resolved',
      (error: unknown) => String(error),
    )

    await manager.stopSaving()
    expect(await pendingFlush).toContain('persistence has stopped')
    manager.requestSaveToDisk()
    await expect(manager.flushSaveToDisk()).rejects.toThrow(
      'persistence has stopped',
    )
    await manager.dispose()
    expect(memory.mergedSaves()).toBe(0)
  })

  it('waits for an in-flight save before stopping persistence', async () => {
    jest.useFakeTimers()
    try {
      let saveCalls = 0
      let releaseSave!: () => void
      let markSaveStarted!: () => void
      const saveStarted = new Promise<void>((resolve) => {
        markSaveStarted = resolve
      })
      const store: AccountStorageStore = {
        load: async () => stored,
        saveMerged: async (_path, next) => {
          saveCalls++
          markSaveStarted()
          await new Promise<void>((resolve) => {
            releaseSave = resolve
          })
          return next
        },
        mutate: async (_path, fn) => (await fn(stored)) ?? stored,
        clear: async () => {},
      }
      const manager = new AccountManager(undefined, stored, { store })
      manager.requestSaveToDisk()
      await jest.advanceTimersByTime(1000)
      await saveStarted

      let stopped = false
      const stopping = manager.stopSaving().then(() => {
        stopped = true
      })
      await Promise.resolve()
      expect(stopped).toBe(false)

      releaseSave()
      await stopping
      expect(stopped).toBe(true)
      expect(saveCalls).toBe(1)

      manager.requestSaveToDisk()
      await expect(manager.flushSaveToDisk()).rejects.toThrow(
        'persistence has stopped',
      )
      await jest.advanceTimersByTime(1000)
      expect(saveCalls).toBe(1)
    } finally {
      jest.useRealTimers()
    }
  })

  it('waits for direct saves and rejects both direct save APIs after retirement', async () => {
    let release!: () => void
    let started!: () => void
    const saveStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    let calls = 0
    const memory = createStore(stored)
    const store: AccountStorageStore = {
      ...memory.store,
      saveMerged: async (_path, snapshot) => {
        calls++
        started()
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return snapshot
      },
    }
    const manager = new AccountManager(undefined, stored, { store })
    const saving = manager.saveToDisk()
    await saveStarted
    let stopped = false
    const firstStop = manager.stopSaving().then(() => {
      stopped = true
    })
    const secondStop = manager.stopSaving()
    await Promise.resolve()
    expect(stopped).toBe(false)
    await expect(manager.saveToDisk()).rejects.toThrow(
      'persistence has stopped',
    )
    await expect(manager.saveToDiskReplace()).rejects.toThrow(
      'persistence has stopped',
    )
    release()
    await Promise.all([saving, firstStop, secondStop])
    expect(calls).toBe(1)
    expect(memory.mutations()).toBe(0)
  })

  it('preserves non-fatal lock contention for ordinary flushes and rejects strict transition flushes', async () => {
    jest.useFakeTimers()
    try {
      const memory = createStore(stored)
      const manager = new AccountManager(undefined, stored, {
        store: {
          ...memory.store,
          saveMerged: async () => {
            throw new Error('ELOCKED')
          },
        },
      })
      manager.requestSaveToDisk()
      const ordinary = manager.flushSaveToDisk()
      const strict = manager.flushSaveToDisk({ strict: true })
      await jest.advanceTimersByTime(1000)
      await expect(ordinary).resolves.toBeUndefined()
      await expect(strict).rejects.toThrow('ELOCKED')
      await expect(manager.flushSaveToDisk()).resolves.toBeUndefined()
      await expect(manager.flushSaveToDisk({ strict: true })).rejects.toThrow(
        'ELOCKED',
      )
      await manager.stopSaving()
    } finally {
      jest.useRealTimers()
    }
  })

  it('inspects retained non-contention failures only for strict flushes', async () => {
    jest.useFakeTimers()
    try {
      const memory = createStore(stored)
      const manager = new AccountManager(undefined, stored, {
        store: {
          ...memory.store,
          saveMerged: async () => {
            throw new Error('disk full')
          },
        },
      })
      manager.requestSaveToDisk()
      await jest.advanceTimersByTime(1000)
      await expect(manager.flushSaveToDisk()).resolves.toBeUndefined()
      await expect(manager.flushSaveToDisk({ strict: true })).rejects.toThrow(
        'disk full',
      )
      await manager.stopSaving()
    } finally {
      jest.useRealTimers()
    }
  })
})

describe('AccountManager instance dependencies', () => {
  it('keeps injected clocks isolated between manager instances', () => {
    const firstMemory = createStore(stored)
    const secondMemory = createStore(stored)
    const first = new AccountManager(undefined, stored, {
      store: firstMemory.store,
      now: () => 1_000,
    })
    const second = new AccountManager(undefined, stored, {
      store: secondMemory.store,
      now: () => 9_000,
    })

    first.markAccountCoolingDown(first.getAccounts()[0]!, 500, 'auth-failure')
    second.markAccountCoolingDown(second.getAccounts()[0]!, 500, 'auth-failure')

    expect(first.getAccounts()[0]?.coolingDownUntil).toBe(1_500)
    expect(second.getAccounts()[0]?.coolingDownUntil).toBe(9_500)
  })
})

describe('managedProjectId projection', () => {
  it('getAccountsForQuotaCheck falls back to record managedProjectId when parts lack it', () => {
    const stored: AccountStorageV4 = {
      version: 4,
      accounts: [
        {
          email: 'test@example.com',
          refreshToken: 'bare-refresh-token',
          projectId: 'my-project',
          managedProjectId: 'my-managed-project',
          addedAt: 1_000,
          lastUsed: 2_000,
        },
      ],
      activeIndex: 0,
    }
    const manager = new AccountManager(undefined, stored, {
      store: createStore(stored).store,
      now: () => 1_000,
    })
    // Simulate a bare-token rotation that strips managedProjectId from
    // parts — the record-level field is the only remaining source.
    const allAccounts = manager.getAccounts()
    allAccounts[0]!.parts.managedProjectId = undefined

    const accounts = manager.getAccountsForQuotaCheck()
    expect(accounts).toHaveLength(1)
    expect(accounts[0]!.projectId).toBe('my-project')
    expect(accounts[0]!.managedProjectId).toBe('my-managed-project')
  })

  it('save→reload round-trip preserves managedProjectId from the record', async () => {
    const { store, state } = createStore(null)
    const stored: AccountStorageV4 = {
      version: 4,
      accounts: [
        {
          email: 'test@example.com',
          refreshToken: 'bare-refresh-token',
          projectId: 'my-project',
          managedProjectId: 'my-managed-project',
          addedAt: 1_000,
          lastUsed: 2_000,
        },
      ],
      activeIndex: 0,
    }
    const manager = new AccountManager(undefined, stored, {
      store,
      now: () => 1_000,
    })
    // Trigger a save — dispose clears the debounce and forces it immediately.
    manager.requestSaveToDisk()
    await manager.dispose()
    const saved = state()
    expect(saved?.accounts[0]?.managedProjectId).toBe('my-managed-project')

    // Reload and verify getAccountsForQuotaCheck still returns it.
    const manager2 = new AccountManager(undefined, saved, {
      store,
      now: () => 1_000,
    })
    const accounts = manager2.getAccountsForQuotaCheck()
    expect(accounts[0]!.managedProjectId).toBe('my-managed-project')
  })
})
