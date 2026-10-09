import { afterEach, expect, it, mock } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AccountStorageLockContentionError,
  type AccountStorageStore,
  type AccountStorageV4,
} from '@cortexkit/antigravity-auth-core'

const realStorage = await import('./storage')
const realCreateAccountStorageStore = realStorage.createAccountStorageStore
const realSaveAccountsReplace = realStorage.saveAccountsReplace

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

let storagePath = ''
let managerCallbackArmed = false
let managerCallbackEntered = deferred()
let releaseManagerCallback = deferred()
let legacyReplaceArmed = false
let legacyReplaceEntered = deferred()
let releaseLegacyReplace = deferred()

mock.module('./storage', () => ({
  ...realStorage,
  getStoragePath: () => storagePath,
  saveAccountsReplace: async (next: AccountStorageV4) => {
    if (legacyReplaceArmed) {
      legacyReplaceEntered.resolve()
      await releaseLegacyReplace.promise
    }
    return realSaveAccountsReplace(next)
  },
  createAccountStorageStore: () => {
    const store = realCreateAccountStorageStore()
    const wrappedStore: AccountStorageStore = {
      ...store,
      mutate: (path, mutate, options) =>
        store.mutate(
          path,
          async (current) => {
            if (managerCallbackArmed) {
              managerCallbackArmed = false
              managerCallbackEntered.resolve()
              await releaseManagerCallback.promise
            }
            return mutate(current)
          },
          options,
        ),
    }
    return wrappedStore
  },
}))

const { AccountManager } = await import('./accounts')

afterEach(() => {
  managerCallbackArmed = false
  managerCallbackEntered = deferred()
  releaseManagerCallback = deferred()
  legacyReplaceArmed = false
  legacyReplaceEntered = deferred()
  releaseLegacyReplace = deferred()
})

it('keeps scoped manager and concurrent writer changes after the first lock contention', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'antigravity-manager-race-'))
  storagePath = join(configDir, 'antigravity-accounts.json')
  const previousConfigDir = process.env.OPENCODE_CONFIG_DIR
  process.env.OPENCODE_CONFIG_DIR = configDir
  const realStore = realCreateAccountStorageStore()
  const initial: AccountStorageV4 = {
    version: 4,
    accounts: [
      { refreshToken: 'a', addedAt: 1, lastUsed: 0 },
      { refreshToken: 'b', addedAt: 1, lastUsed: 0 },
    ],
    activeIndex: 0,
  }
  const lockEntered = deferred()
  const releaseLock = deferred()
  const manager = new AccountManager(undefined, initial, { storagePath })

  try {
    await realStore.mutate(storagePath, () => initial)
    manager.getAccounts()[0]!.label = 'A updated'

    const initialLock = realStore.mutate(storagePath, async (current) => {
      lockEntered.resolve()
      await releaseLock.promise
      return current
    })
    await lockEntered.promise
    await expect(manager.saveToDisk()).rejects.toBeInstanceOf(
      AccountStorageLockContentionError,
    )

    releaseLock.resolve()
    await initialLock
    managerCallbackArmed = true
    legacyReplaceArmed = true

    const secondSaveDone = deferred()
    const secondSave = manager
      .saveToDisk()
      .finally(() => secondSaveDone.resolve())

    const progress = await Promise.race([
      managerCallbackEntered.promise.then(() => 'locked-callback' as const),
      legacyReplaceEntered.promise.then(() => 'legacy-overwrite' as const),
    ])

    const externalContention = deferred()
    const externalWrite = realStore.mutate(
      storagePath,
      (current) => {
        current.accounts[1]!.label = 'B updated'
        current.accounts.push({
          refreshToken: 'oauth-added',
          addedAt: 2,
          lastUsed: 0,
        })
        return current
      },
      {
        sleep: async () => {
          externalContention.resolve()
          await secondSaveDone.promise
        },
      },
    )

    if (progress === 'locked-callback') {
      await externalContention.promise
      releaseManagerCallback.resolve()
      await secondSave
      await externalWrite
    } else {
      await externalWrite
      releaseLegacyReplace.resolve()
      await secondSave
    }

    const persisted = await realStore.load(storagePath)
    expect(persisted?.accounts).toEqual([
      expect.objectContaining({ refreshToken: 'a', label: 'A updated' }),
      expect.objectContaining({ refreshToken: 'b', label: 'B updated' }),
      expect.objectContaining({ refreshToken: 'oauth-added' }),
    ])
  } finally {
    releaseLock.resolve()
    releaseManagerCallback.resolve()
    releaseLegacyReplace.resolve()
    await manager.dispose()
    if (previousConfigDir === undefined) {
      delete process.env.OPENCODE_CONFIG_DIR
    } else {
      process.env.OPENCODE_CONFIG_DIR = previousConfigDir
    }
    await rm(configDir, { recursive: true, force: true })
  }
})
