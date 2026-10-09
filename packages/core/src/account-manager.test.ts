import { describe, expect, it, jest } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AccountManager,
  AccountManagerPersistenceError,
} from './account-manager.ts'
import type { AccountStorageStore } from './account-storage.ts'
import {
  AccountStorageLockContentionError,
  defaultAccountStorageStore,
  loadAccountStorage,
  mergeAccountStorage,
  mutateAccountStorage,
  saveAccountStorage,
} from './account-storage.ts'
import type { AccountStorageV4 } from './account-types.ts'
import { acquireFencedFileLock } from './file-lock.ts'
import { generateFingerprint } from './fingerprint.ts'

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
  it('lets independent B save while A has a known prewrite conflict, then recovers A after restoration', async () => {
    const initial = structuredClone(stored)
    const memory = createStore(initial)
    const manager = new AccountManager(undefined, initial, {
      store: {
        ...memory.store,
        saveMerged: async (path) => {
          throw new AccountStorageLockContentionError('typed contention', {
            path,
            attempts: 6,
          })
        },
      },
    })
    try {
      manager.getAccounts()[0]!.label = 'local A'
      await expect(manager.saveToDisk()).rejects.toBeInstanceOf(
        AccountStorageLockContentionError,
      )
      await memory.store.mutate('', (current) => ({
        ...current,
        accounts: current.accounts.map((account, index) =>
          index === 0 ? { ...account, label: 'external A' } : account,
        ),
      }))
      manager.getAccounts()[1]!.label = 'local B'
      await manager.saveToDisk()
      expect(memory.state()?.accounts.map((account) => account.label)).toEqual([
        'external A',
        'local B',
      ])
      expect(memory.state()?.accounts[0]?.fingerprint).toBeUndefined()
      expect(memory.state()?.accounts[1]?.fingerprint).toBeDefined()
      await expect(manager.flushAndStopSaving()).rejects.toMatchObject({
        state: 'unconfirmed',
      })
      await memory.store.mutate('', (current) => ({
        ...current,
        accounts: current.accounts.map((account, index) =>
          index === 0 ? { ...account, label: undefined } : account,
        ),
      }))
      await manager.flushAndStopSaving()
      expect(memory.state()?.accounts.map((account) => account.label)).toEqual([
        'local A',
        'local B',
      ])
      expect(memory.state()?.accounts[0]?.fingerprint).toBeDefined()
    } finally {
      await manager.stopSaving()
    }
  })

  it('retains two account conflicts while C saves and preserves later same-account order', async () => {
    const initial: AccountStorageV4 = {
      ...structuredClone(stored),
      accounts: [
        ...structuredClone(stored.accounts),
        { refreshToken: 'r3', addedAt: 1, lastUsed: 0 },
      ],
    }
    const memory = createStore(initial)
    const manager = new AccountManager(undefined, initial, {
      store: {
        ...memory.store,
        saveMerged: async (path) => {
          throw new AccountStorageLockContentionError('typed contention', {
            path,
            attempts: 6,
          })
        },
      },
    })
    try {
      manager.getAccounts()[0]!.label = 'first A'
      await expect(manager.saveToDisk()).rejects.toBeInstanceOf(
        AccountStorageLockContentionError,
      )
      await memory.store.mutate('', (current) => ({
        ...current,
        accounts: current.accounts.map((account, index) =>
          index < 2 ? { ...account, label: `external ${index}` } : account,
        ),
      }))
      manager.getAccounts()[1]!.label = 'local B'
      await expect(manager.saveToDisk()).rejects.toMatchObject({
        state: 'unconfirmed',
      })
      manager.getAccounts()[2]!.label = 'local C'
      await manager.saveToDisk()
      manager.getAccounts()[0]!.label = 'later A'
      await expect(manager.saveToDisk()).rejects.toMatchObject({
        state: 'unconfirmed',
      })
      expect(memory.state()?.accounts.map((account) => account.label)).toEqual([
        'external 0',
        'external 1',
        'local C',
      ])
      await expect(manager.flushAndStopSaving()).rejects.toMatchObject({
        state: 'unconfirmed',
      })
      await memory.store.mutate('', (current) => ({
        ...current,
        accounts: current.accounts.map((account, index) =>
          index < 2 ? structuredClone(initial.accounts[index]!) : account,
        ),
      }))
      await manager.flushAndStopSaving()
      expect(memory.state()?.accounts.map((account) => account.label)).toEqual([
        'later A',
        'local B',
        'local C',
      ])
    } finally {
      await manager.stopSaving()
    }
  })

  it('retains a skipped later A intent when independent B succeeds', async () => {
    const initial = structuredClone(stored)
    const memory = createStore(initial)
    const observedA: Array<string | undefined> = []
    const manager = new AccountManager(undefined, initial, {
      store: {
        ...memory.store,
        saveMerged: async (path) => {
          throw new AccountStorageLockContentionError('typed contention', {
            path,
            attempts: 6,
          })
        },
        mutate: async (path, update) => {
          const saved = await memory.store.mutate(path, update)
          observedA.push(saved.accounts[0]?.label)
          return saved
        },
      },
    })
    try {
      manager.getAccounts()[0]!.label = 'first A'
      await expect(manager.saveToDisk()).rejects.toBeInstanceOf(
        AccountStorageLockContentionError,
      )
      await memory.store.mutate('', (current) => ({
        ...current,
        accounts: current.accounts.map((account, index) =>
          index === 0 ? { ...account, label: 'external A' } : account,
        ),
      }))
      manager.getAccounts()[0]!.label = 'later A'
      await expect(manager.saveToDisk()).rejects.toMatchObject({
        state: 'unconfirmed',
      })
      manager.getAccounts()[1]!.label = 'independent B'
      await manager.saveToDisk()
      expect(memory.state()?.accounts.map((account) => account.label)).toEqual([
        'external A',
        'independent B',
      ])
      await memory.store.mutate('', (current) => ({
        ...current,
        accounts: current.accounts.map((account, index) =>
          index === 0 ? structuredClone(initial.accounts[0]!) : account,
        ),
      }))
      await manager.flushAndStopSaving()
      expect(observedA.slice(-2)).toEqual(['first A', 'later A'])
      expect(memory.state()?.accounts.map((account) => account.label)).toEqual([
        'later A',
        'independent B',
      ])
    } finally {
      await manager.stopSaving()
    }
  })

  it('rejects a strict requested flush when B saves but A remains conflicted', async () => {
    jest.useFakeTimers()
    try {
      const initial = structuredClone(stored)
      const memory = createStore(initial)
      const manager = new AccountManager(undefined, initial, {
        store: {
          ...memory.store,
          saveMerged: async (path) => {
            throw new AccountStorageLockContentionError('typed contention', {
              path,
              attempts: 6,
            })
          },
        },
      })
      manager.getAccounts()[0]!.label = 'local A'
      await expect(manager.saveToDisk()).rejects.toBeInstanceOf(
        AccountStorageLockContentionError,
      )
      await memory.store.mutate('', (current) => ({
        ...current,
        accounts: current.accounts.map((account, index) =>
          index === 0 ? { ...account, label: 'external A' } : account,
        ),
      }))
      manager.getAccounts()[1]!.label = 'local B'
      manager.requestSaveToDisk()
      const ordinary = manager.flushSaveToDisk()
      const strict = manager.flushSaveToDisk({ strict: true })
      void strict.catch(() => {})
      await jest.advanceTimersByTime(1000)
      await expect(ordinary).resolves.toBeUndefined()
      await expect(strict).rejects.toMatchObject({ state: 'unconfirmed' })
      expect(memory.state()?.accounts.map((account) => account.label)).toEqual([
        'external A',
        'local B',
      ])
      await expect(manager.flushAndStopSaving()).rejects.toMatchObject({
        state: 'unconfirmed',
      })
      await manager.dispose()
    } finally {
      jest.useRealTimers()
    }
  })

  it('validates every account in a captured intent before applying any part of it', async () => {
    const initial: AccountStorageV4 = {
      ...structuredClone(stored),
      accounts: [
        ...structuredClone(stored.accounts),
        { refreshToken: 'r3', addedAt: 1, lastUsed: 0 },
      ],
    }
    const memory = createStore(initial)
    const manager = new AccountManager(undefined, initial, {
      store: {
        ...memory.store,
        saveMerged: async (path) => {
          throw new AccountStorageLockContentionError('typed contention', {
            path,
            attempts: 6,
          })
        },
      },
    })
    try {
      manager.getAccounts()[0]!.label = 'first A'
      await expect(manager.saveToDisk()).rejects.toBeInstanceOf(
        AccountStorageLockContentionError,
      )
      await manager.saveToDisk()
      const durableB = structuredClone(memory.state()!.accounts[1]!)
      manager.getAccounts()[0]!.label = 'second A'
      manager.getAccounts()[1]!.label = 'local B'
      await memory.store.mutate('', (current) => ({
        ...current,
        accounts: current.accounts.map((account, index) =>
          index === 1 ? { ...account, label: 'external B' } : account,
        ),
      }))
      await expect(manager.saveToDisk()).rejects.toMatchObject({
        state: 'unconfirmed',
      })
      expect(memory.state()?.accounts.map((account) => account.label)).toEqual([
        'first A',
        'external B',
        undefined,
      ])
      manager.getAccounts()[2]!.label = 'local C'
      await manager.saveToDisk()
      expect(memory.state()?.accounts.map((account) => account.label)).toEqual([
        'first A',
        'external B',
        'local C',
      ])
      await memory.store.mutate('', (current) => ({
        ...current,
        accounts: current.accounts.map((account, index) =>
          index === 1 ? structuredClone(durableB) : account,
        ),
      }))
      await manager.flushAndStopSaving()
      expect(memory.state()?.accounts.map((account) => account.label)).toEqual([
        'second A',
        'local B',
        'local C',
      ])
    } finally {
      await manager.stopSaving()
    }
  })

  it('keeps a replacement and its later merge behind an older account conflict', async () => {
    const initial: AccountStorageV4 = {
      ...structuredClone(stored),
      accounts: [
        ...structuredClone(stored.accounts),
        { refreshToken: 'r3', addedAt: 1, lastUsed: 0 },
      ],
    }
    const memory = createStore(initial)
    const manager = new AccountManager(undefined, initial, {
      store: {
        ...memory.store,
        saveMerged: async (path) => {
          throw new AccountStorageLockContentionError('typed contention', {
            path,
            attempts: 6,
          })
        },
      },
    })
    try {
      manager.getAccounts()[0]!.label = 'local A'
      await expect(manager.saveToDisk()).rejects.toBeInstanceOf(
        AccountStorageLockContentionError,
      )
      await memory.store.mutate('', (current) => ({
        ...current,
        accounts: current.accounts.map((account, index) =>
          index === 0 ? { ...account, label: 'external A' } : account,
        ),
      }))
      manager.removeAccountByIndex(1)
      await expect(manager.saveToDiskReplace()).rejects.toMatchObject({
        state: 'unconfirmed',
      })
      manager.getAccounts()[1]!.label = 'later C'
      await expect(manager.saveToDisk()).rejects.toMatchObject({
        state: 'unconfirmed',
      })
      expect(
        memory.state()?.accounts.map((account) => account.refreshToken),
      ).toEqual(['r1', 'r2', 'r3'])
      await memory.store.mutate('', (current) => ({
        ...current,
        accounts: current.accounts.map((account, index) =>
          index === 0 ? structuredClone(initial.accounts[0]!) : account,
        ),
      }))
      await manager.flushAndStopSaving()
      expect(
        memory.state()?.accounts.map((account) => account.refreshToken),
      ).toEqual(['r1', 'r3'])
      expect(memory.state()?.accounts[1]?.label).toBe('later C')
    } finally {
      await manager.stopSaving()
    }
  })

  it('treats a wrapped prewrite validation error as ambiguous and blocks B', async () => {
    const initial = structuredClone(stored)
    const memory = createStore(initial)
    const manager = new AccountManager(undefined, initial, {
      store: {
        ...memory.store,
        saveMerged: async (path) => {
          throw new AccountStorageLockContentionError('typed contention', {
            path,
            attempts: 6,
          })
        },
        mutate: async (path, update) => {
          try {
            return await memory.store.mutate(path, update)
          } catch {
            throw new Error('wrapped validation result')
          }
        },
      },
    })
    try {
      manager.getAccounts()[0]!.label = 'local A'
      await expect(manager.saveToDisk()).rejects.toBeInstanceOf(
        AccountStorageLockContentionError,
      )
      await memory.store.mutate('', (current) => ({
        ...current,
        accounts: current.accounts.map((account, index) =>
          index === 0 ? { ...account, label: 'external A' } : account,
        ),
      }))
      manager.getAccounts()[1]!.label = 'local B'
      await expect(manager.saveToDisk()).rejects.toThrow(
        'wrapped validation result',
      )
      expect(memory.state()?.accounts.map((account) => account.label)).toEqual([
        'external A',
        undefined,
      ])
      await expect(manager.flushAndStopSaving()).rejects.toMatchObject({
        state: 'unconfirmed',
      })
    } finally {
      await manager.stopSaving()
    }
  })

  it('retains a conflicted A through recovery tail and disposal after B succeeds', async () => {
    const initial: AccountStorageV4 = {
      ...structuredClone(stored),
      accounts: [
        ...structuredClone(stored.accounts),
        { refreshToken: 'r3', addedAt: 1, lastUsed: 0 },
      ],
    }
    const memory = createStore(initial)
    const manager = new AccountManager(undefined, initial, {
      store: {
        ...memory.store,
        saveMerged: async (path) => {
          throw new AccountStorageLockContentionError('typed contention', {
            path,
            attempts: 6,
          })
        },
      },
    })
    manager.getAccounts()[0]!.label = 'local A'
    await expect(manager.saveToDisk()).rejects.toBeInstanceOf(
      AccountStorageLockContentionError,
    )
    await memory.store.mutate('', (current) => ({
      ...current,
      accounts: current.accounts.map((account, index) =>
        index === 0 ? { ...account, label: 'external A' } : account,
      ),
    }))
    manager.getAccounts()[1]!.label = 'local B'
    await manager.saveToDisk()
    await expect(manager.flushAndStopSaving()).rejects.toMatchObject({
      state: 'unconfirmed',
    })
    manager.enableSavingRecovery()
    manager.getAccounts()[2]!.label = 'pending C'
    manager.requestSaveToDisk()
    await expect(
      manager.flushSaveToDisk({ strict: true }),
    ).rejects.toMatchObject({
      state: 'unconfirmed',
    })
    expect(memory.state()?.accounts.map((account) => account.label)).toEqual([
      'external A',
      'local B',
      'pending C',
    ])
    await manager.dispose()
    expect(memory.state()?.accounts.map((account) => account.label)).toEqual([
      'external A',
      'local B',
      'pending C',
    ])
    await expect(manager.saveToDisk()).rejects.toThrow(
      'persistence has stopped',
    )
  })

  it('keeps a same-account recovery tail behind conflicted A until A is restored', async () => {
    const initial = structuredClone(stored)
    const memory = createStore(initial)
    const manager = new AccountManager(undefined, initial, {
      store: {
        ...memory.store,
        saveMerged: async (path) => {
          throw new AccountStorageLockContentionError('typed contention', {
            path,
            attempts: 6,
          })
        },
      },
    })
    try {
      manager.getAccounts()[0]!.label = 'first A'
      await expect(manager.saveToDisk()).rejects.toBeInstanceOf(
        AccountStorageLockContentionError,
      )
      await memory.store.mutate('', (current) => ({
        ...current,
        accounts: current.accounts.map((account, index) =>
          index === 0 ? { ...account, label: 'external A' } : account,
        ),
      }))
      await expect(manager.flushAndStopSaving()).rejects.toMatchObject({
        state: 'unconfirmed',
      })
      manager.enableSavingRecovery()
      manager.getAccounts()[0]!.label = 'later A'
      manager.requestSaveToDisk()
      await expect(
        manager.flushSaveToDisk({ strict: true }),
      ).rejects.toMatchObject({
        state: 'unconfirmed',
      })
      expect(memory.state()?.accounts[0]?.label).toBe('external A')
      await memory.store.mutate('', (current) => ({
        ...current,
        accounts: current.accounts.map((account, index) =>
          index === 0 ? structuredClone(initial.accounts[0]!) : account,
        ),
      }))
      await manager.flushSaveToDisk({ strict: true })
      expect(memory.state()?.accounts[0]?.label).toBe('later A')
      await manager.flushAndStopSaving()
    } finally {
      await manager.stopSaving()
    }
  })

  it('keeps an independent recovery tail behind a retained replacement', async () => {
    const initial: AccountStorageV4 = {
      ...structuredClone(stored),
      accounts: [
        ...structuredClone(stored.accounts),
        { refreshToken: 'r3', addedAt: 1, lastUsed: 0 },
      ],
    }
    const memory = createStore(initial)
    const manager = new AccountManager(undefined, initial, {
      store: {
        ...memory.store,
        saveMerged: async (path) => {
          throw new AccountStorageLockContentionError('typed contention', {
            path,
            attempts: 6,
          })
        },
      },
    })
    try {
      manager.getAccounts()[0]!.label = 'local A'
      await expect(manager.saveToDisk()).rejects.toBeInstanceOf(
        AccountStorageLockContentionError,
      )
      await memory.store.mutate('', (current) => ({
        ...current,
        accounts: current.accounts.map((account, index) =>
          index === 0 ? { ...account, label: 'external A' } : account,
        ),
      }))
      manager.removeAccountByIndex(1)
      await expect(manager.saveToDiskReplace()).rejects.toMatchObject({
        state: 'unconfirmed',
      })
      await expect(manager.flushAndStopSaving()).rejects.toMatchObject({
        state: 'unconfirmed',
      })
      manager.enableSavingRecovery()
      manager.getAccounts()[1]!.label = 'tail C'
      manager.requestSaveToDisk()
      await expect(
        manager.flushSaveToDisk({ strict: true }),
      ).rejects.toMatchObject({
        state: 'unconfirmed',
      })
      expect(
        memory.state()?.accounts.map((account) => account.refreshToken),
      ).toEqual(['r1', 'r2', 'r3'])
      expect(memory.state()?.accounts[2]?.label).toBeUndefined()
    } finally {
      await manager.dispose()
    }
  })

  it('keeps a recovery tail behind ambiguous persistence until read-back resolves', async () => {
    const initial: AccountStorageV4 = {
      ...structuredClone(stored),
      accounts: [
        ...structuredClone(stored.accounts),
        { refreshToken: 'r3', addedAt: 1, lastUsed: 0 },
      ],
    }
    const memory = createStore(initial)
    const manager = new AccountManager(undefined, initial, {
      store: {
        ...memory.store,
        saveMerged: async (path, snapshot) => {
          await memory.store.mutate(path, (current) =>
            mergeAccountStorage(current, snapshot),
          )
          throw new Error('response lost')
        },
      },
    })
    try {
      manager.getAccounts()[0]!.label = 'local A'
      await expect(manager.saveToDisk()).rejects.toThrow('response lost')
      await memory.store.mutate('', (current) => ({
        ...current,
        accounts: current.accounts.map((account, index) =>
          index === 1 ? { ...account, label: 'external B' } : account,
        ),
      }))
      await expect(manager.flushAndStopSaving()).rejects.toMatchObject({
        state: 'unconfirmed',
      })
      manager.enableSavingRecovery()
      manager.getAccounts()[2]!.label = 'tail C'
      manager.requestSaveToDisk()
      await expect(
        manager.flushSaveToDisk({ strict: true }),
      ).rejects.toMatchObject({
        state: 'unconfirmed',
      })
      expect(memory.state()?.accounts.map((account) => account.label)).toEqual([
        'local A',
        'external B',
        undefined,
      ])
    } finally {
      await manager.dispose()
    }
  })

  for (const externalChange of [
    'metadata',
    'rotation',
    'removal',
    'addition',
  ] as const) {
    it(`preserves independent B ${externalChange} through typed retry and later saves`, async () => {
      const initial = structuredClone(stored)
      const memory = createStore(initial)
      let firstSave = true
      let external!: AccountStorageV4
      const manager = new AccountManager(undefined, initial, {
        store: {
          ...memory.store,
          saveMerged: async (path, next) => {
            if (firstSave) {
              firstSave = false
              await memory.store.mutate(path, (current) => ({
                ...current,
                accounts:
                  externalChange === 'removal'
                    ? current.accounts.slice(0, 1)
                    : externalChange === 'addition'
                      ? [
                          ...current.accounts.map((account) =>
                            account.refreshToken === 'r2'
                              ? { ...account, label: 'external B' }
                              : account,
                          ),
                          {
                            refreshToken: 'external-new',
                            addedAt: 2,
                            lastUsed: 0,
                          },
                        ]
                      : current.accounts.map((account) =>
                          account.refreshToken === 'r2'
                            ? {
                                ...account,
                                label: 'external B',
                                projectId: 'external project',
                                refreshToken:
                                  externalChange === 'rotation'
                                    ? 'rotated-B'
                                    : account.refreshToken,
                              }
                            : account,
                        ),
                activeIndex: externalChange === 'removal' ? 0 : 1,
                activeIndexByFamily: {
                  claude: externalChange === 'removal' ? 0 : 1,
                  gemini: 0,
                },
              }))
              external = structuredClone(memory.state()!)
              throw new AccountStorageLockContentionError('typed contention', {
                path,
                attempts: 6,
              })
            }
            return memory.store.saveMerged(path, next)
          },
        },
      })
      manager.getAccounts()[0]!.label = 'local A'
      await expect(manager.saveToDisk()).rejects.toBeInstanceOf(
        AccountStorageLockContentionError,
      )
      await manager.saveToDisk()
      expect(memory.state()?.accounts[0]?.label).toBe('local A')
      expect(memory.state()?.accounts.slice(1)).toEqual(
        external.accounts.slice(1),
      )
      expect(memory.state()?.activeIndexByFamily).toEqual(
        external.activeIndexByFamily,
      )
      manager.getAccounts()[0]!.lastUsed = 321
      await manager.saveToDisk()
      expect(memory.state()?.accounts[0]?.lastUsed).toBe(321)
      expect(memory.state()?.accounts.slice(1)).toEqual(
        external.accounts.slice(1),
      )
      expect(memory.state()?.activeIndex).toBe(external.activeIndex)
      await manager.flushAndStopSaving()
      expect(memory.state()?.accounts.slice(1)).toEqual(
        external.accounts.slice(1),
      )
    })
  }

  it('retains omitted durable metadata on A and unchanged B during initialization maintenance', async () => {
    const retained = {
      cachedPerModelQuota: [
        { modelId: 'model', group: 'claude', remainingFraction: 0.5 },
      ],
      coolingDownUntil: 123_456,
      cooldownReason: 'network-error' as const,
      lastSwitchReason: 'rotation' as const,
    }
    const initial = structuredClone(stored)
    initial.accounts = initial.accounts.map((account) => ({
      ...account,
      ...structuredClone(retained),
    }))
    const memory = createStore(initial)
    const manager = new AccountManager(undefined, initial, {
      store: {
        ...memory.store,
        saveMerged: async (path) => {
          throw new AccountStorageLockContentionError('typed contention', {
            path,
            attempts: 6,
          })
        },
      },
    })
    try {
      manager.getAccounts()[0]!.label = 'local A'
      await expect(manager.saveToDisk()).rejects.toBeInstanceOf(
        AccountStorageLockContentionError,
      )
      await manager.saveToDisk()
      for (const account of memory.state()!.accounts)
        expect(account).toMatchObject(retained)
      manager.getAccounts()[0]!.lastUsed = 123
      await manager.saveToDisk()
      for (const account of memory.state()!.accounts)
        expect(account).toMatchObject(retained)
    } finally {
      await manager.stopSaving()
    }
  })

  it('keeps B changes that precede the failed save baseline read', async () => {
    const initial = structuredClone(stored)
    const memory = createStore(initial)
    let firstRead = true
    const manager = new AccountManager(undefined, initial, {
      store: {
        ...memory.store,
        load: async (path) => {
          if (firstRead) {
            firstRead = false
            await memory.store.mutate(path, (current) => ({
              ...current,
              accounts: current.accounts.map((account) =>
                account.refreshToken === 'r2'
                  ? {
                      ...account,
                      label: 'B before baseline',
                      fingerprint: generateFingerprint(),
                    }
                  : account,
              ),
            }))
          }
          return memory.store.load(path)
        },
        saveMerged: async (path) => {
          throw new AccountStorageLockContentionError('typed contention', {
            path,
            attempts: 6,
          })
        },
      },
    })
    manager.getAccounts()[0]!.label = 'local A'
    await expect(manager.saveToDisk()).rejects.toBeInstanceOf(
      AccountStorageLockContentionError,
    )
    const externalB = structuredClone(memory.state()!.accounts[1])
    await manager.saveToDisk()
    expect(memory.state()?.accounts[0]?.label).toBe('local A')
    expect(memory.state()?.accounts[1]).toEqual(externalB)
    await manager.stopSaving()
  })

  it('preserves B between a recovered intent and the queued newer intent', async () => {
    const initial = structuredClone(stored)
    const memory = createStore(initial)
    let enter!: () => void
    let release!: () => void
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let mutations = 0
    const observed: string[] = []
    const manager = new AccountManager(undefined, initial, {
      store: {
        ...memory.store,
        saveMerged: async (path) => {
          enter()
          await gate
          throw new AccountStorageLockContentionError('typed contention', {
            path,
            attempts: 6,
          })
        },
        mutate: async (path, fn) => {
          mutations++
          if (mutations === 2) {
            await memory.store.mutate(path, (current) => ({
              ...current,
              accounts: current.accounts.map((account) =>
                account.refreshToken === 'r2'
                  ? { ...account, label: 'B between intents' }
                  : account,
              ),
            }))
          }
          const result = await memory.store.mutate(path, fn)
          observed.push(result.accounts[0]!.label!)
          return result
        },
      },
    })
    manager.getAccounts()[0]!.label = 'first A'
    const first = manager.saveToDisk()
    void first.catch(() => {})
    await entered
    manager.getAccounts()[0]!.label = 'queued A'
    const queued = manager.saveToDisk()
    void queued.catch(() => {})
    await memory.store.mutate('', (current) => ({
      ...current,
      accounts: current.accounts.map((account) =>
        account.refreshToken === 'r2'
          ? { ...account, label: 'B while locked' }
          : account,
      ),
    }))
    release()
    await expect(first).rejects.toBeInstanceOf(
      AccountStorageLockContentionError,
    )
    await queued
    expect(observed).toEqual(['first A', 'queued A'])
    expect(memory.state()?.accounts[1]?.label).toBe('B between intents')
    await manager.flushAndStopSaving()
  })

  for (const conflict of ['metadata', 'rotation', 'removal'] as const) {
    it(`keeps a typed retry unconfirmed when A has an external ${conflict}`, async () => {
      const initial = structuredClone(stored)
      const memory = createStore(initial)
      const manager = new AccountManager(undefined, initial, {
        store: {
          ...memory.store,
          saveMerged: async (path) => {
            throw new AccountStorageLockContentionError('typed contention', {
              path,
              attempts: 6,
            })
          },
        },
      })
      manager.getAccounts()[0]!.label = 'local A'
      await expect(manager.saveToDisk()).rejects.toBeInstanceOf(
        AccountStorageLockContentionError,
      )
      await memory.store.mutate('', (current) => ({
        ...current,
        accounts:
          conflict === 'removal'
            ? current.accounts.slice(1)
            : current.accounts.map((account) =>
                account.refreshToken === 'r1'
                  ? {
                      ...account,
                      label: 'external A',
                      refreshToken:
                        conflict === 'rotation'
                          ? 'rotated-A'
                          : account.refreshToken,
                    }
                  : account,
              ),
      }))
      const external = structuredClone(memory.state())
      await expect(manager.flushAndStopSaving()).rejects.toMatchObject({
        state: 'unconfirmed',
      })
      expect(memory.state()).toEqual(external)
      await manager.stopSaving()
    })
  }

  for (const structural of ['replace', 'rotation', 'selection'] as const) {
    it(`guards a later ${structural} against preserved external B state`, async () => {
      const initial = structuredClone(stored)
      const memory = createStore(initial)
      const manager = new AccountManager(undefined, initial, {
        store: {
          ...memory.store,
          saveMerged: async (path) => {
            throw new AccountStorageLockContentionError('typed contention', {
              path,
              attempts: 6,
            })
          },
        },
      })
      manager.getAccounts()[0]!.label = 'local A'
      await expect(manager.saveToDisk()).rejects.toBeInstanceOf(
        AccountStorageLockContentionError,
      )
      await memory.store.mutate('', (current) => ({
        ...current,
        accounts: current.accounts.map((account) =>
          account.refreshToken === 'r2'
            ? { ...account, label: 'external B' }
            : account,
        ),
      }))
      await manager.saveToDisk()
      const external = structuredClone(memory.state())
      if (structural === 'replace') manager.removeAccountByIndex(1)
      if (structural === 'rotation')
        manager.updateFromAuth(manager.getAccounts()[0]!, {
          type: 'oauth',
          refresh: 'new-A|p1',
        })
      if (structural === 'selection') {
        manager.getCurrentOrNextForFamily('claude', null, 'round-robin')
        expect(
          manager.getCurrentOrNextForFamily('claude', null, 'round-robin')
            ?.index,
        ).toBe(1)
      }
      await expect(
        structural === 'replace'
          ? manager.saveToDiskReplace()
          : manager.saveToDisk(),
      ).rejects.toMatchObject({ state: 'unconfirmed' })
      expect(memory.state()).toEqual(external)
      await manager.stopSaving()
    })
  }

  it('retains typed retries across repeated contention without advancing disk provenance', async () => {
    const initial = structuredClone(stored)
    const memory = createStore(initial)
    let retryLocked = true
    const manager = new AccountManager(undefined, initial, {
      store: {
        ...memory.store,
        saveMerged: async (path) => {
          throw new AccountStorageLockContentionError('typed contention', {
            path,
            attempts: 6,
          })
        },
        mutate: async (path, fn) => {
          if (retryLocked)
            throw new AccountStorageLockContentionError('retry contention', {
              path,
              attempts: 6,
            })
          return memory.store.mutate(path, fn)
        },
      },
    })
    manager.getAccounts()[0]!.label = 'first A'
    await expect(manager.saveToDisk()).rejects.toBeInstanceOf(
      AccountStorageLockContentionError,
    )
    manager.getAccounts()[0]!.label = 'newer A'
    await expect(manager.saveToDisk()).rejects.toBeInstanceOf(
      AccountStorageLockContentionError,
    )
    expect(memory.state()?.accounts[0]?.label).toBeUndefined()
    await memory.store.mutate('', (current) => ({
      ...current,
      accounts: current.accounts.map((account) =>
        account.refreshToken === 'r2'
          ? { ...account, label: 'external B' }
          : account,
      ),
    }))
    retryLocked = false
    await manager.flushAndStopSaving()
    expect(memory.state()?.accounts[0]?.label).toBe('newer A')
    expect(memory.state()?.accounts[1]?.label).toBe('external B')
  })

  it('preserves B in the enabled recovery tail and after recovery reopens saves', async () => {
    const initial = structuredClone(stored)
    const memory = createStore(initial)
    let rejectBeforeCommit = true
    let scopedWrites = 0
    const manager = new AccountManager(undefined, initial, {
      store: {
        ...memory.store,
        saveMerged: async (path) => {
          throw new AccountStorageLockContentionError('typed contention', {
            path,
            attempts: 6,
          })
        },
        mutate: async (path, fn) => {
          if (rejectBeforeCommit) {
            rejectBeforeCommit = false
            await fn(structuredClone(memory.state()!))
            throw new Error('commit unavailable')
          }
          scopedWrites++
          if (scopedWrites === 2) {
            await memory.store.mutate(path, (current) => ({
              ...current,
              accounts: current.accounts.map((account) =>
                account.refreshToken === 'r2'
                  ? { ...account, label: 'B before recovery tail' }
                  : account,
              ),
            }))
          }
          return memory.store.mutate(path, fn)
        },
      },
    })
    manager.getAccounts()[0]!.label = 'accepted A'
    await expect(manager.saveToDisk()).rejects.toBeInstanceOf(
      AccountStorageLockContentionError,
    )
    await expect(manager.flushAndStopSaving()).rejects.toMatchObject({
      state: 'unconfirmed',
    })
    manager.enableSavingRecovery()
    manager.getAccounts()[0]!.label = 'late A'
    manager.requestSaveToDisk()
    await manager.flushSaveToDisk({ strict: true })
    expect(memory.state()?.accounts[0]?.label).toBe('late A')
    expect(memory.state()?.accounts[1]?.label).toBe('B before recovery tail')
    manager.getAccounts()[0]!.lastUsed = 456
    await manager.saveToDisk()
    expect(memory.state()?.accounts[0]?.lastUsed).toBe(456)
    expect(memory.state()?.accounts[1]?.label).toBe('B before recovery tail')
    await manager.flushAndStopSaving()
  })

  for (const concurrentAfterWrite of [false, true]) {
    it(`reconciles an ambiguous scoped write conservatively (externalAfterWrite=${concurrentAfterWrite})`, async () => {
      const initial = structuredClone(stored)
      const memory = createStore(initial)
      let writes = 0
      const manager = new AccountManager(undefined, initial, {
        store: {
          ...memory.store,
          saveMerged: async (path) => {
            throw new AccountStorageLockContentionError('typed contention', {
              path,
              attempts: 6,
            })
          },
          mutate: async (path, fn) => {
            writes++
            const result = await memory.store.mutate(path, fn)
            if (writes === 1) throw new Error('response lost after write')
            return result
          },
        },
      })
      manager.getAccounts()[0]!.label = 'local A'
      await expect(manager.saveToDisk()).rejects.toBeInstanceOf(
        AccountStorageLockContentionError,
      )
      await memory.store.mutate('', (current) => ({
        ...current,
        accounts: current.accounts.map((account) =>
          account.refreshToken === 'r2'
            ? { ...account, label: 'external B' }
            : account,
        ),
      }))
      await expect(manager.saveToDisk()).rejects.toThrow(
        'response lost after write',
      )
      expect(memory.state()?.accounts[0]?.label).toBe('local A')
      if (concurrentAfterWrite) {
        await memory.store.mutate('', (current) => ({
          ...current,
          accounts: current.accounts.map((account) =>
            account.refreshToken === 'r2'
              ? { ...account, label: 'B changed after ambiguous write' }
              : account,
          ),
        }))
        await expect(manager.flushAndStopSaving()).rejects.toMatchObject({
          state: 'unconfirmed',
        })
        expect(writes).toBe(1)
        await manager.stopSaving()
      } else {
        await manager.saveToDisk()
        manager.getAccounts()[0]!.lastUsed = 789
        await manager.saveToDisk()
        expect(memory.state()?.accounts[0]?.lastUsed).toBe(789)
        expect(memory.state()?.accounts[1]?.label).toBe('external B')
        await manager.flushAndStopSaving()
      }
    })
  }

  for (const initialKind of ['fallback', 'invalid', 'duplicate'] as const) {
    it(`retains the whole-pool guard for ${initialKind} initialization`, async () => {
      const initial = structuredClone(stored)
      if (initialKind === 'invalid')
        initial.accounts.push({ refreshToken: '', addedAt: 1, lastUsed: 0 })
      if (initialKind === 'duplicate')
        initial.accounts.push({ ...initial.accounts[0]! })
      const memory = createStore(initial)
      const manager = new AccountManager(
        initialKind === 'fallback'
          ? { type: 'oauth', refresh: 'fallback|project' }
          : undefined,
        initial,
        {
          store: {
            ...memory.store,
            saveMerged: async (path) => {
              throw new AccountStorageLockContentionError('typed contention', {
                path,
                attempts: 6,
              })
            },
          },
        },
      )
      manager.getAccounts()[0]!.label = 'local A'
      if (initialKind === 'duplicate')
        manager.getAccounts()[2]!.label = 'local A'
      await expect(manager.saveToDisk()).rejects.toBeInstanceOf(
        AccountStorageLockContentionError,
      )
      await manager.flushAndStopSaving()
      expect(memory.state()?.accounts[0]?.label).toBe('local A')
      const tokens = memory
        .state()
        ?.accounts.map((account) => account.refreshToken)
      expect(tokens).toEqual(
        initialKind === 'fallback' ? ['r1', 'r2', 'fallback'] : ['r1', 'r2'],
      )
    })
  }

  it('retries a real pre-write file-lock failure without replacing B or its fingerprint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agy-scoped-lock-'))
    const path = join(root, 'accounts.json')
    const initial = structuredClone(stored)
    initial.accounts[0]!.fingerprint = generateFingerprint()
    initial.accounts[0]!.fingerprint!.userAgent = 'old fingerprint version'
    let first = true
    let external!: AccountStorageV4
    let manager: AccountManager | undefined
    try {
      await saveAccountStorage(path, initial)
      const loaded = await loadAccountStorage(path)
      manager = new AccountManager(undefined, loaded, {
        storagePath: path,
        store: {
          ...defaultAccountStorageStore,
          saveMerged: async (target, snapshot) => {
            if (!first) return saveAccountStorage(target, snapshot)
            first = false
            const held = await acquireFencedFileLock({
              path: target,
              name: 'accounts',
              ttlMs: 10_000,
              renew: false,
            })
            expect(held).not.toBeNull()
            try {
              external = JSON.parse(
                await readFile(target, 'utf8'),
              ) as AccountStorageV4
              external.accounts[1] = {
                ...external.accounts[1]!,
                label: 'real external B',
                fingerprint: generateFingerprint(),
              }
              await writeFile(target, JSON.stringify(external))
              return await mutateAccountStorage(
                target,
                (current) => mergeAccountStorage(current, snapshot),
                { sleep: async () => {} },
              )
            } finally {
              await held!.release()
            }
          },
        },
      })
      manager.getAccounts()[0]!.label = 'real local A'
      await expect(manager.saveToDisk()).rejects.toBeInstanceOf(
        AccountStorageLockContentionError,
      )
      await manager.saveToDisk()
      const result = await loadAccountStorage(path)
      expect(result?.accounts[0]?.label).toBe('real local A')
      expect(result?.accounts[0]?.fingerprint?.userAgent).toBe(
        manager.getAccounts()[0]?.fingerprint?.userAgent,
      )
      expect(result?.accounts[1]).toEqual(external.accounts[1])
      manager.getAccounts()[0]!.lastUsed = 123
      await manager.saveToDisk()
      await manager.flushAndStopSaving()
      expect((await loadAccountStorage(path))?.accounts[1]).toEqual(
        external.accounts[1],
      )
    } finally {
      await manager?.stopSaving()
      await rm(root, { recursive: true, force: true })
    }
  })

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

  it('recovers a failed fence only after explicit enablement and a new flush', async () => {
    const memory = createStore(stored)
    let readable = false
    let reads = 0
    let writes = 0
    const manager = new AccountManager(undefined, stored, {
      store: {
        ...memory.store,
        load: async (path) => {
          reads++
          if (reads > 1 && !readable) throw new Error('read unavailable')
          return memory.store.load(path)
        },
        saveMerged: async (path, next) => {
          writes++
          await memory.store.mutate(path, (current) =>
            mergeAccountStorage(current, next),
          )
          if (writes === 1) throw new Error('response lost')
          return next
        },
      },
    })
    manager.getAccounts()[0]!.label = 'accepted'
    manager.requestSaveToDisk()
    await expect(manager.flushAndStopSaving()).rejects.toMatchObject({
      state: 'unconfirmed',
    })
    expect(writes).toBe(1)
    manager.enableSavingRecovery()
    readable = true
    manager.getAccounts()[0]!.label = 'latest'
    manager.requestSaveToDisk()
    await manager.flushSaveToDisk({ strict: true })
    expect(writes).toBe(1)
    expect(memory.state()?.accounts[0]?.label).toBe('latest')
    await manager.saveToDisk()
  })

  it('does not enable recovery while the first fence is still in progress', async () => {
    const memory = createStore(stored)
    let releaseWrite!: () => void
    let markWriteStarted!: () => void
    const writeStarted = new Promise<void>((resolve) => {
      markWriteStarted = resolve
    })
    let reads = 0
    const manager = new AccountManager(undefined, stored, {
      store: {
        ...memory.store,
        load: async (path) => {
          reads++
          if (reads > 1) throw new Error('read unavailable')
          return memory.store.load(path)
        },
        saveMerged: async () => {
          markWriteStarted()
          await new Promise<void>((resolve) => {
            releaseWrite = resolve
          })
          throw new Error('write lost')
        },
      },
    })
    manager.requestSaveToDisk()
    const fence = manager.flushAndStopSaving()
    await writeStarted
    manager.enableSavingRecovery()
    releaseWrite()
    await expect(fence).rejects.toMatchObject({ state: 'unconfirmed' })
    await expect(manager.flushSaveToDisk()).rejects.toThrow(
      'persistence has stopped',
    )
    await manager.dispose()
  })

  it('retries a missing accepted intent under a guarded baseline, then flushes without dirty memory', async () => {
    const memory = createStore(stored)
    let readable = false
    let reads = 0
    let writes = 0
    const manager = new AccountManager(undefined, stored, {
      store: {
        ...memory.store,
        load: async (path) => {
          reads++
          if (reads > 1 && !readable) throw new Error('read unavailable')
          return memory.store.load(path)
        },
        saveMerged: async () => {
          writes++
          throw new Error('write lost')
        },
      },
    })
    manager.getAccounts()[0]!.label = 'accepted'
    manager.requestSaveToDisk()
    await expect(manager.flushAndStopSaving()).rejects.toMatchObject({
      state: 'unconfirmed',
    })
    manager.enableSavingRecovery()
    readable = true
    await manager.flushSaveToDisk({ strict: true })
    expect(writes).toBe(1)
    expect(memory.mutations()).toBe(1)
    expect(memory.state()?.accounts[0]?.label).toBe('accepted')
  })

  it('starts enabled recovery from a requested save after the debounce', async () => {
    jest.useFakeTimers()
    try {
      const memory = createStore(stored)
      let readable = false
      let reads = 0
      let writes = 0
      let observeRecovery!: () => void
      const recoveryObserved = new Promise<void>((resolve) => {
        observeRecovery = resolve
      })
      const manager = new AccountManager(undefined, stored, {
        store: {
          ...memory.store,
          load: async (path) => {
            reads++
            if (reads > 1 && !readable) throw new Error('read unavailable')
            return memory.store.load(path)
          },
          mutate: async (path, fn) => {
            const saved = await memory.store.mutate(path, fn)
            observeRecovery()
            return saved
          },
          saveMerged: async (path, snapshot) => {
            writes++
            if (writes === 1) throw new Error('write lost')
            return memory.store.saveMerged(path, snapshot)
          },
        },
      })
      manager.requestSaveToDisk()
      await expect(manager.flushAndStopSaving()).rejects.toMatchObject({
        state: 'unconfirmed',
      })
      manager.enableSavingRecovery()
      readable = true
      manager.getAccounts()[0]!.label = 'latest'
      manager.requestSaveToDisk()
      await jest.advanceTimersByTime(1000)
      await recoveryObserved
      await manager.flushSaveToDisk({ strict: true })
      await manager.saveToDisk()
      expect(memory.state()?.accounts[0]?.label).toBe('latest')
    } finally {
      jest.useRealTimers()
    }
  })

  it('keeps a conflicting or unavailable failed baseline fenced without overwrite', async () => {
    for (const changed of [false, true]) {
      const memory = createStore(stored)
      let readable = false
      let reads = 0
      const manager = new AccountManager(undefined, stored, {
        store: {
          ...memory.store,
          load: async (path) => {
            reads++
            if (reads > 1 && !readable) throw new Error('read unavailable')
            return memory.store.load(path)
          },
          saveMerged: async () => {
            throw new Error('write lost')
          },
        },
      })
      manager.getAccounts()[0]!.label = 'accepted'
      manager.requestSaveToDisk()
      await expect(manager.flushAndStopSaving()).rejects.toMatchObject({
        state: 'unconfirmed',
      })
      manager.enableSavingRecovery()
      if (changed) {
        await memory.store.mutate('', (current) => ({
          ...current,
          accounts: current.accounts.map((account, index) =>
            index === 0 ? { ...account, label: 'external' } : account,
          ),
        }))
        readable = true
      }
      const before = memory.state()
      await expect(manager.flushSaveToDisk()).rejects.toMatchObject({
        state: 'unconfirmed',
      })
      expect(memory.state()).toEqual(before)
      await expect(manager.saveToDisk()).rejects.toThrow(
        'persistence has stopped',
      )
      await manager.dispose()
    }
  })

  it('does not replay a failed intent when its original baseline was unreadable', async () => {
    const memory = createStore(stored)
    let readable = false
    let writes = 0
    const manager = new AccountManager(undefined, stored, {
      store: {
        ...memory.store,
        load: async (path) => {
          if (!readable) throw new Error('read unavailable')
          return memory.store.load(path)
        },
        saveMerged: async () => {
          writes++
          throw new Error('write lost')
        },
      },
    })
    manager.requestSaveToDisk()
    await expect(manager.flushAndStopSaving()).rejects.toMatchObject({
      state: 'unconfirmed',
    })
    manager.enableSavingRecovery()
    readable = true
    await expect(manager.flushSaveToDisk()).rejects.toMatchObject({
      state: 'unconfirmed',
    })
    expect(writes).toBe(1)
    expect(memory.mutations()).toBe(0)
    await manager.dispose()
  })

  it('keeps repeated unreadable requests single-flight and waits for an explicit retry', async () => {
    jest.useFakeTimers()
    try {
      const memory = createStore(stored)
      let readable = false
      let reads = 0
      let writes = 0
      const manager = new AccountManager(undefined, stored, {
        store: {
          ...memory.store,
          load: async (path) => {
            reads++
            if (reads > 1 && !readable) throw new Error('read unavailable')
            return memory.store.load(path)
          },
          saveMerged: async () => {
            writes++
            throw new Error('write lost')
          },
        },
      })
      manager.requestSaveToDisk()
      await expect(manager.flushAndStopSaving()).rejects.toMatchObject({
        state: 'unconfirmed',
      })
      manager.enableSavingRecovery()
      for (let index = 0; index < 20; index++) manager.requestSaveToDisk()
      const first = manager.flushSaveToDisk()
      const second = manager.flushSaveToDisk()
      const failures = await Promise.allSettled([first, second])
      expect(failures.map((result) => result.status)).toEqual([
        'rejected',
        'rejected',
      ])
      const readsAfterFailure = reads
      await jest.advanceTimersByTime(5000)
      expect(reads).toBe(readsAfterFailure)
      expect(writes).toBe(1)
      readable = true
      await manager.flushSaveToDisk()
      expect(memory.state()?.accounts).toHaveLength(2)
    } finally {
      jest.useRealTimers()
    }
  })

  it('keeps changes made during the recovery write for the next ordinary save', async () => {
    jest.useFakeTimers()
    try {
      const memory = createStore(stored)
      let readable = false
      let reads = 0
      let releaseWrite!: () => void
      let markWriteStarted!: () => void
      const writeStarted = new Promise<void>((resolve) => {
        markWriteStarted = resolve
      })
      let blockRecoveryWrite = false
      let observeLateWrite!: () => void
      const lateWriteObserved = new Promise<void>((resolve) => {
        observeLateWrite = resolve
      })
      const manager = new AccountManager(undefined, stored, {
        store: {
          ...memory.store,
          load: async (path) => {
            reads++
            if (reads > 1 && !readable) throw new Error('read unavailable')
            return memory.store.load(path)
          },
          saveMerged: async (path, next) => {
            await memory.store.mutate(path, (current) =>
              mergeAccountStorage(current, next),
            )
            if (next.accounts[0]?.label === 'late') observeLateWrite()
            throw new Error('response lost')
          },
          mutate: async (path, fn) => {
            if (blockRecoveryWrite) {
              blockRecoveryWrite = false
              markWriteStarted()
              await new Promise<void>((resolve) => {
                releaseWrite = resolve
              })
            }
            return memory.store.mutate(path, fn)
          },
        },
      })
      manager.getAccounts()[0]!.label = 'accepted'
      manager.requestSaveToDisk()
      await expect(manager.flushAndStopSaving()).rejects.toMatchObject({
        state: 'unconfirmed',
      })
      manager.enableSavingRecovery()
      readable = true
      blockRecoveryWrite = true
      manager.getAccounts()[0]!.label = 'captured'
      manager.requestSaveToDisk()
      const recovery = manager.flushSaveToDisk()
      await writeStarted
      manager.getAccounts()[0]!.label = 'late'
      manager.requestSaveToDisk()
      releaseWrite()
      await recovery
      expect(memory.state()?.accounts[0]?.label).toBe('captured')
      await jest.advanceTimersByTime(1000)
      await lateWriteObserved
      expect(memory.state()?.accounts[0]?.label).toBe('late')
    } finally {
      jest.useRealTimers()
    }
  })

  it('holds a late flush until its dirty update after an active recovery write', async () => {
    jest.useFakeTimers()
    try {
      const memory = createStore(stored)
      let readable = false
      let reads = 0
      let releaseWrite!: () => void
      let markWriteStarted!: () => void
      const writeStarted = new Promise<void>((resolve) => {
        markWriteStarted = resolve
      })
      let blockRecoveryWrite = false
      let originalWrite = true
      const manager = new AccountManager(undefined, stored, {
        store: {
          ...memory.store,
          load: async (path) => {
            reads++
            if (reads > 1 && !readable) throw new Error('read unavailable')
            return memory.store.load(path)
          },
          saveMerged: async (path, next) => {
            if (originalWrite) {
              originalWrite = false
              await memory.store.mutate(path, (current) =>
                mergeAccountStorage(current, next),
              )
              throw new Error('response lost')
            }
            return memory.store.saveMerged(path, next)
          },
          mutate: async (path, fn) => {
            if (blockRecoveryWrite) {
              blockRecoveryWrite = false
              markWriteStarted()
              await new Promise<void>((resolve) => {
                releaseWrite = resolve
              })
            }
            return memory.store.mutate(path, fn)
          },
        },
      })
      manager.requestSaveToDisk()
      await expect(manager.flushAndStopSaving()).rejects.toMatchObject({
        state: 'unconfirmed',
      })
      manager.enableSavingRecovery()
      readable = true
      blockRecoveryWrite = true
      manager.getAccounts()[0]!.label = 'A'
      manager.requestSaveToDisk()
      const firstFlush = manager.flushSaveToDisk()
      await writeStarted
      manager.getAccounts()[0]!.label = 'B'
      manager.requestSaveToDisk()
      let lateResolved = false
      const lateFlush = manager.flushSaveToDisk().then(() => {
        lateResolved = true
      })
      releaseWrite()
      await firstFlush
      await Promise.resolve()
      expect(memory.state()?.accounts[0]?.label).toBe('A')
      expect(lateResolved).toBe(false)
      await jest.advanceTimersByTime(1000)
      await lateFlush
      expect(memory.state()?.accounts[0]?.label).toBe('B')
    } finally {
      jest.useRealTimers()
    }
  })

  it.each([
    undefined,
    false,
    true,
  ] as const)('preserves strict=%s for a late flush after recovery when the next save hits ELOCKED', async (strict) => {
    jest.useFakeTimers()
    try {
      const memory = createStore(stored)
      let readable = false
      let reads = 0
      let releaseWrite!: () => void
      let markWriteStarted!: () => void
      const writeStarted = new Promise<void>((resolve) => {
        markWriteStarted = resolve
      })
      let blockRecoveryWrite = false
      let firstWrite = true
      let lateAttempts = 0
      const manager = new AccountManager(undefined, stored, {
        store: {
          ...memory.store,
          load: async (path) => {
            reads++
            if (reads > 1 && !readable) throw new Error('read unavailable')
            return memory.store.load(path)
          },
          saveMerged: async (path, snapshot) => {
            if (firstWrite) {
              firstWrite = false
              await memory.store.mutate(path, (current) =>
                mergeAccountStorage(current, snapshot),
              )
              throw new Error('response lost')
            }
            lateAttempts++
            throw new Error('ELOCKED')
          },
          mutate: async (path, fn) => {
            if (blockRecoveryWrite) {
              blockRecoveryWrite = false
              markWriteStarted()
              await new Promise<void>((resolve) => {
                releaseWrite = resolve
              })
            }
            return memory.store.mutate(path, fn)
          },
        },
      })
      manager.requestSaveToDisk()
      await expect(manager.flushAndStopSaving()).rejects.toMatchObject({
        state: 'unconfirmed',
      })
      manager.enableSavingRecovery()
      readable = true
      blockRecoveryWrite = true
      manager.getAccounts()[0]!.label = 'A'
      manager.requestSaveToDisk()
      const firstFlush = manager.flushSaveToDisk()
      await writeStarted
      manager.getAccounts()[0]!.label = 'B'
      manager.requestSaveToDisk()
      const lateFlush = (
        strict === undefined
          ? manager.flushSaveToDisk()
          : manager.flushSaveToDisk({ strict })
      ).then(
        () => 'resolved',
        (error: unknown) => String(error),
      )
      releaseWrite()
      await firstFlush
      await jest.advanceTimersByTime(1000)
      const outcome = await lateFlush
      if (strict === true) expect(outcome).toContain('ELOCKED')
      else expect(outcome).toBe('resolved')
      expect(lateAttempts).toBe(1)
      expect(memory.state()?.accounts[0]?.label).toBe('A')
      await manager.stopSaving()
    } finally {
      jest.useRealTimers()
    }
  })

  it.each([
    undefined,
    false,
    true,
  ] as const)('rejects strict=%s flush on unconfirmed recovery read-back without another write', async (strict) => {
    const memory = createStore(stored)
    let reads = 0
    let writes = 0
    const manager = new AccountManager(undefined, stored, {
      store: {
        ...memory.store,
        load: async (path) => {
          reads++
          if (reads > 1) throw new Error('read unavailable')
          return memory.store.load(path)
        },
        saveMerged: async () => {
          writes++
          throw new Error('write lost')
        },
      },
    })
    manager.requestSaveToDisk()
    await expect(manager.flushAndStopSaving()).rejects.toMatchObject({
      state: 'unconfirmed',
    })
    manager.enableSavingRecovery()
    const flush =
      strict === undefined
        ? manager.flushSaveToDisk()
        : manager.flushSaveToDisk({ strict })
    await expect(flush).rejects.toMatchObject({ state: 'unconfirmed' })
    expect(writes).toBe(1)
    expect(memory.mutations()).toBe(0)
    await manager.dispose()
  })

  it.each([
    false,
    true,
  ])('confirms a committed recovery write before %s later dirty update', async (lateDirty) => {
    const memory = createStore(stored)
    let readable = false
    let reads = 0
    let writes = 0
    const manager = new AccountManager(undefined, stored, {
      store: {
        ...memory.store,
        load: async (path) => {
          reads++
          if (reads > 1 && !readable) throw new Error('read unavailable')
          return memory.store.load(path)
        },
        saveMerged: async () => {
          throw new Error('original write lost')
        },
        mutate: async (path, fn) => {
          writes++
          const saved = await memory.store.mutate(path, fn)
          if (writes === 2) {
            if (lateDirty) {
              manager.getAccounts()[0]!.label = 'B'
              manager.requestSaveToDisk()
            }
            throw new Error('recovery response lost')
          }
          return saved
        },
      },
    })
    manager.requestSaveToDisk()
    await expect(manager.flushAndStopSaving()).rejects.toMatchObject({
      state: 'unconfirmed',
    })
    manager.enableSavingRecovery()
    readable = true
    manager.getAccounts()[0]!.label = 'A'
    manager.requestSaveToDisk()
    await expect(manager.flushSaveToDisk()).rejects.toThrow(
      'recovery response lost',
    )
    expect(memory.state()?.accounts[0]?.label).toBe('A')
    await manager.flushSaveToDisk()
    expect(writes).toBe(lateDirty ? 3 : 2)
    expect(memory.state()?.accounts[0]?.label).toBe(lateDirty ? 'B' : 'A')
  })

  it('dispose preserves a late requested save accepted by an active ordinary fence', async () => {
    const memory = createStore(stored)
    let releaseSave!: () => void
    let markSaveStarted!: () => void
    const saveStarted = new Promise<void>((resolve) => {
      markSaveStarted = resolve
    })
    let first = true
    const manager = new AccountManager(undefined, stored, {
      store: {
        ...memory.store,
        saveMerged: async (path, snapshot) => {
          if (first) {
            first = false
            markSaveStarted()
            await new Promise<void>((resolve) => {
              releaseSave = resolve
            })
          }
          return memory.store.saveMerged(path, snapshot)
        },
      },
    })
    manager.requestSaveToDisk()
    const fence = manager.flushAndStopSaving()
    await saveStarted
    manager.getAccounts()[0]!.label = 'late'
    manager.requestSaveToDisk()
    const disposing = manager.dispose()
    releaseSave()
    await Promise.all([fence, disposing])
    expect(memory.state()?.accounts[0]?.label).toBe('late')
  })

  it('dispose drains a failed active fence after rejecting its late work', async () => {
    const sourceUrl =
      process.env.ANTIGRAVITY_MANAGER_DISPOSE_TEST_SOURCE ??
      new URL('./account-manager.ts', import.meta.url).href
    const script = `
      const { AccountManager } = await import(${JSON.stringify(sourceUrl)})
      const initial = {
        version: 4,
        accounts: [{ refreshToken: 'r1', projectId: 'p1', addedAt: 1, lastUsed: 0 }],
        activeIndex: 0,
      }
      let state = structuredClone(initial)
      let reads = 0
      let writes = 0
      let mutations = 0
      let releaseSave
      let markSaveStarted
      const saveStarted = new Promise((resolve) => { markSaveStarted = resolve })
      const store = {
        load: async () => {
          reads++
          if (reads > 1) throw new Error('read unavailable')
          return state
        },
        saveMerged: async () => {
          writes++
          markSaveStarted()
          await new Promise((resolve) => { releaseSave = resolve })
          throw new Error('response lost')
        },
        mutate: async (_path, fn) => {
          mutations++
          state = (await fn(state)) ?? state
          return state
        },
        clear: async () => { state = null },
      }
      const outcome = (promise) => promise.then(
        () => ({ status: 'fulfilled' }),
        (error) => ({ status: 'rejected', state: error?.state, message: String(error) }),
      )
      const manager = new AccountManager(undefined, initial, { store })
      manager.requestSaveToDisk()
      const firstFlush = outcome(manager.flushSaveToDisk({ strict: true }))
      const fence = outcome(manager.flushAndStopSaving())
      await saveStarted
      manager.getAccounts()[0].label = 'late'
      manager.requestSaveToDisk()
      const lateFlush = outcome(manager.flushSaveToDisk())
      const disposing = outcome(manager.dispose())
      process.stdout.write('entered\\n')
      releaseSave()
      const [first, late, fenced, disposed] = await Promise.all([
        firstFlush, lateFlush, fence, disposing,
      ])
      process.stdout.write(JSON.stringify({ first, late, fenced, disposed, writes, mutations }) + '\\n')
    `
    const child = spawn(process.execPath, ['-e', script], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let spawnError: Error | null = null
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.once('error', (error) => {
      spawnError = error
    })
    const closed = new Promise<{
      code: number | null
      signal: NodeJS.Signals | null
    }>((resolve) => {
      child.once('close', (code, signal) => resolve({ code, signal }))
    })
    let timedOut = false
    const deadline = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, 3000)
    try {
      const exit = await closed
      expect(timedOut).toBe(false)
      expect(spawnError).toBeNull()
      expect(exit).toEqual({ code: 0, signal: null })
      const lines = stdout.trim().split('\n')
      expect(lines[0]).toBe('entered')
      const result = JSON.parse(lines[1] ?? '')
      expect(result.first).toMatchObject({
        status: 'rejected',
        message: 'Error: response lost',
      })
      expect(result.late).toMatchObject({
        status: 'rejected',
        message: 'Error: Account manager persistence has stopped',
      })
      expect(result.fenced).toMatchObject({
        status: 'rejected',
        state: 'unconfirmed',
      })
      expect(result.disposed).toEqual({ status: 'fulfilled' })
      expect(result.writes).toBe(1)
      expect(result.mutations).toBe(0)
    } catch (error) {
      throw new Error(
        `Disposal child failed (timedOut=${timedOut}, entered=${stdout.includes('entered')}, stderr=${stderr.slice(0, 1000)}): ${String(error)}`,
      )
    } finally {
      clearTimeout(deadline)
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
      }
      await closed
      child.stdout.destroy()
      child.stderr.destroy()
    }
  })

  it('invalidates a started recovery on dispose and drains it across repeated calls', async () => {
    const memory = createStore(stored)
    let readable = false
    let reads = 0
    let releaseRead!: () => void
    let markReadStarted!: () => void
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve
    })
    let blockRecoveryRead = false
    const manager = new AccountManager(undefined, stored, {
      store: {
        ...memory.store,
        load: async (path) => {
          reads++
          if (blockRecoveryRead) {
            blockRecoveryRead = false
            markReadStarted()
            await new Promise<void>((resolve) => {
              releaseRead = resolve
            })
          }
          if (reads > 1 && !readable) throw new Error('read unavailable')
          return memory.store.load(path)
        },
        saveMerged: async () => {
          throw new Error('write lost')
        },
      },
    })
    manager.requestSaveToDisk()
    await expect(manager.flushAndStopSaving()).rejects.toMatchObject({
      state: 'unconfirmed',
    })
    manager.enableSavingRecovery()
    manager.requestSaveToDisk()
    blockRecoveryRead = true
    const recovery = manager.flushSaveToDisk()
    await readStarted
    let disposed = false
    const firstDispose = manager.dispose().then(() => {
      disposed = true
    })
    const secondDispose = manager.dispose()
    expect(disposed).toBe(false)
    readable = true
    releaseRead()
    await expect(recovery).rejects.toThrow('persistence has stopped')
    await Promise.all([firstDispose, secondDispose])
    expect(disposed).toBe(true)
    expect(memory.mutations()).toBe(0)
    await expect(manager.flushSaveToDisk()).rejects.toThrow(
      'persistence has stopped',
    )
  })

  it('invalidates a started recovery before stopSaving returns', async () => {
    const memory = createStore(stored)
    let readable = false
    let reads = 0
    let releaseRead!: () => void
    let markReadStarted!: () => void
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve
    })
    let blockRecoveryRead = false
    const manager = new AccountManager(undefined, stored, {
      store: {
        ...memory.store,
        load: async (path) => {
          reads++
          if (blockRecoveryRead) {
            blockRecoveryRead = false
            markReadStarted()
            await new Promise<void>((resolve) => {
              releaseRead = resolve
            })
          }
          if (reads > 1 && !readable) throw new Error('read unavailable')
          return memory.store.load(path)
        },
        saveMerged: async () => {
          throw new Error('write lost')
        },
      },
    })
    manager.requestSaveToDisk()
    await expect(manager.flushAndStopSaving()).rejects.toMatchObject({
      state: 'unconfirmed',
    })
    manager.enableSavingRecovery()
    manager.requestSaveToDisk()
    blockRecoveryRead = true
    const recovery = manager.flushSaveToDisk()
    await readStarted
    let stopped = false
    const stopping = manager.stopSaving().then(() => {
      stopped = true
    })
    expect(stopped).toBe(false)
    readable = true
    releaseRead()
    await expect(recovery).rejects.toThrow('persistence has stopped')
    await stopping
    expect(stopped).toBe(true)
    expect(memory.mutations()).toBe(0)
  })

  it('lets a new fence supersede recovery and keeps the retired manager closed', async () => {
    const memory = createStore(stored)
    let readable = false
    let reads = 0
    let releaseRead!: () => void
    let markReadStarted!: () => void
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve
    })
    let blockRecoveryRead = false
    const manager = new AccountManager(undefined, stored, {
      store: {
        ...memory.store,
        load: async (path) => {
          reads++
          if (blockRecoveryRead) {
            blockRecoveryRead = false
            markReadStarted()
            await new Promise<void>((resolve) => {
              releaseRead = resolve
            })
          }
          if (reads > 1 && !readable) throw new Error('read unavailable')
          return memory.store.load(path)
        },
        saveMerged: async () => {
          throw new Error('write lost')
        },
      },
    })
    manager.requestSaveToDisk()
    await expect(manager.flushAndStopSaving()).rejects.toMatchObject({
      state: 'unconfirmed',
    })
    manager.enableSavingRecovery()
    blockRecoveryRead = true
    const recovery = manager.flushSaveToDisk()
    await readStarted
    readable = true
    const fence = manager.flushAndStopSaving()
    releaseRead()
    await expect(recovery).rejects.toThrow('persistence has stopped')
    await fence
    const writes = memory.mutations()
    manager.enableSavingRecovery()
    manager.requestSaveToDisk()
    await expect(manager.flushSaveToDisk()).rejects.toThrow(
      'persistence has stopped',
    )
    expect(memory.mutations()).toBe(writes)
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
    // Authoritative read-back sees the rotation before a retry is attempted.
    expect(memory.mutations()).toBe(1)
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

  it('waits for a failed direct save to reconcile before retiring the old manager', async () => {
    const memory = createStore(stored)
    let releaseRetry!: () => void
    let retryStarted!: () => void
    const retrying = new Promise<void>((resolve) => {
      retryStarted = resolve
    })
    let writes = 0
    const manager = new AccountManager(undefined, stored, {
      store: {
        ...memory.store,
        saveMerged: async () => {
          writes++
          throw new Error('ELOCKED')
        },
        mutate: async (path, update) => {
          retryStarted()
          await new Promise<void>((resolve) => {
            releaseRetry = resolve
          })
          writes++
          return memory.store.mutate(path, update)
        },
      },
    })
    manager.getAccounts()[0]!.label = 'accepted before stop'
    await expect(manager.saveToDisk()).rejects.toThrow('ELOCKED')

    const fence = manager.flushAndStopSaving()
    await retrying
    let stopped = false
    const firstStop = manager.stopSaving().then(() => {
      stopped = true
    })
    const secondStop = manager.stopSaving()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(stopped).toBe(false)
    await expect(manager.saveToDisk()).rejects.toThrow(
      'persistence has stopped',
    )
    await expect(manager.flushSaveToDisk()).rejects.toThrow(
      'persistence has stopped',
    )

    releaseRetry()
    await Promise.all([fence, firstStop, secondStop])
    expect(memory.state()?.accounts[0]?.label).toBe('accepted before stop')
    await memory.store.mutate('', (current) => ({
      ...current,
      accounts: current.accounts.map((account, index) =>
        index === 0 ? { ...account, label: 'external successor' } : account,
      ),
    }))
    manager.getAccounts()[0]!.label = 'stale after stop'
    manager.requestSaveToDisk()
    await manager.dispose()
    expect(writes).toBe(2)
    expect(memory.state()?.accounts[0]?.label).toBe('external successor')
  })

  it('drains reconciliation enqueued by a fence after stop snapshots its queue', async () => {
    const memory = createStore(stored)
    let releaseRead!: () => void
    let readStarted!: () => void
    const reading = new Promise<void>((resolve) => {
      readStarted = resolve
    })
    let releaseReconciliation!: () => void
    let reconciliationStarted!: () => void
    const reconciling = new Promise<void>((resolve) => {
      reconciliationStarted = resolve
    })
    let loads = 0
    let writes = 0
    const manager = new AccountManager(undefined, stored, {
      store: {
        ...memory.store,
        load: async (path) => {
          loads++
          if (loads === 2) {
            readStarted()
            await new Promise<void>((resolve) => {
              releaseRead = resolve
            })
            throw new Error('read unavailable')
          }
          return memory.store.load(path)
        },
        saveMerged: async (path, next) => {
          writes++
          await memory.store.mutate(path, (current) =>
            mergeAccountStorage(current, next),
          )
          throw new Error('response lost')
        },
        mutate: async (path, update) => {
          reconciliationStarted()
          await new Promise<void>((resolve) => {
            releaseReconciliation = resolve
          })
          writes++
          return memory.store.mutate(path, update)
        },
      },
    })
    manager.getAccounts()[0]!.label = 'first accepted'
    await expect(manager.saveToDisk()).rejects.toThrow('response lost')
    manager.getAccounts()[1]!.label = 'second accepted'
    const second = manager.saveToDisk()
    await reading
    const fence = manager.flushAndStopSaving()
    let stopped = false
    const stopping = manager.stopSaving().then(() => {
      stopped = true
    })
    releaseRead()
    await expect(second).rejects.toMatchObject({ state: 'unconfirmed' })
    await reconciling
    expect(stopped).toBe(false)
    releaseReconciliation()
    await Promise.all([fence, stopping])
    expect(writes).toBe(2)
    expect(memory.state()?.accounts.map((account) => account.label)).toEqual([
      'first accepted',
      'second accepted',
    ])
    manager.getAccounts()[1]!.label = 'stale after stop'
    manager.requestSaveToDisk()
    await manager.dispose()
    expect(writes).toBe(2)
  })

  it.each([
    'domain retryable',
    'raw lock contention',
  ] as const)('keeps admission closed when an accepted fence ends in %s after stop', async (failurePath) => {
    const memory = createStore(stored)
    let releaseFailure!: () => void
    let failureStarted!: () => void
    const failing = new Promise<void>((resolve) => {
      failureStarted = resolve
    })
    let writes = 0
    const manager = new AccountManager(undefined, stored, {
      store: {
        ...memory.store,
        saveMerged: async () => {
          writes++
          if (failurePath === 'domain retryable') {
            failureStarted()
            await new Promise<void>((resolve) => {
              releaseFailure = resolve
            })
          }
          throw new Error('ELOCKED')
        },
        mutate: async () => {
          writes++
          failureStarted()
          await new Promise<void>((resolve) => {
            releaseFailure = resolve
          })
          throw new Error('ELOCKED')
        },
      },
    })
    manager.getAccounts()[0]!.label = 'accepted intent'
    const original = manager.saveToDisk()
    if (failurePath === 'raw lock contention') {
      await expect(original).rejects.toThrow('ELOCKED')
    }
    const fence = manager.flushAndStopSaving()
    await failing
    let stopped = false
    const stopping = manager.stopSaving().then(() => {
      stopped = true
    })
    expect(stopped).toBe(false)
    releaseFailure()
    if (failurePath === 'domain retryable') {
      await expect(original).rejects.toThrow('ELOCKED')
    }
    await expect(fence).rejects.toMatchObject({ state: 'retryable' })
    await stopping
    expect(stopped).toBe(true)
    await expect(manager.saveToDisk()).rejects.toThrow(
      'persistence has stopped',
    )
    await expect(manager.saveToDiskReplace()).rejects.toThrow(
      'persistence has stopped',
    )
    await expect(manager.flushSaveToDisk()).rejects.toThrow(
      'persistence has stopped',
    )
    await expect(manager.flushAndStopSaving()).rejects.toThrow(
      'persistence has stopped',
    )
    manager.requestSaveToDisk()
    await manager.dispose()
    expect(writes).toBe(failurePath === 'domain retryable' ? 1 : 2)
    expect(memory.state()?.accounts[0]?.label).toBeUndefined()
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
      const ordinary = manager.flushSaveToDisk().then(
        () => 'resolved',
        (error: unknown) => String(error),
      )
      const strict = manager.flushSaveToDisk({ strict: true }).then(
        () => 'resolved',
        (error: unknown) => String(error),
      )
      await jest.advanceTimersByTime(1000)
      expect(await ordinary).toBe('resolved')
      expect(await strict).toContain('ELOCKED')
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
