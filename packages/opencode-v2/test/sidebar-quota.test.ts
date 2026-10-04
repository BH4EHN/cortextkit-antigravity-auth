import { describe, expect, test } from 'bun:test'

import type {
  AccountQuotaResult,
  ManagedAccount,
} from '@cortexkit/antigravity-auth-core'

import { quotaAccountIdentity } from '../src/commands.ts'
import { SidebarQuotaCoordinator } from '../src/sidebar-quota.ts'

function account(
  token: string,
  overrides: Partial<ManagedAccount> = {},
): ManagedAccount {
  return {
    index: 0,
    parts: { refreshToken: token },
    addedAt: 1,
    lastUsed: 1,
    enabled: true,
    rateLimitResetTimes: {},
    touchedForQuota: {},
    ...overrides,
  }
}

function success(
  groups: NonNullable<AccountQuotaResult['quota']>['groups'],
): AccountQuotaResult {
  return { index: 0, status: 'ok', quota: { groups, modelCount: 1 } }
}

describe('sidebar quota coordinator', () => {
  test('legacy attempt time does not become a quota-success timestamp', async () => {
    const accounts = [
      account('legacy', {
        cachedQuota: { gemini: { remainingFraction: 0.35, modelCount: 1 } },
        cachedQuotaUpdatedAt: 12_000,
      }),
      account('mismatch', {
        cachedQuota: { gemini: { remainingFraction: 0.95, modelCount: 1 } },
        cachedQuotaAccountId: quotaAccountIdentity('someone-else'),
        cachedQuotaUpdatedAt: 13_000,
        enabled: false,
      }),
    ]
    let calls = 0
    const coordinator = new SidebarQuotaCoordinator({
      accounts: () => accounts,
      active: () => ({ claude: 0, gemini: 0 }),
      logicalToken: (token) => token,
      now: () => 100_000,
      fetch: async () => {
        calls += 1
        return { index: 0, status: 'error', error: 'private upstream error' }
      },
    })
    const initial = coordinator.snapshot('cache').accounts
    expect(initial[0]?.gemini).toMatchObject({
      remainingPercent: 35,
      source: 'cache',
    })
    expect(Object.hasOwn(initial[0]!.gemini, 'updatedAt')).toBe(false)
    expect(initial[0]?.cacheUpdatedAt).toBe(12_000)
    expect(initial[1]?.gemini.remainingPercent).toBeNull()
    expect(initial[1]?.cacheUpdatedAt).toBeUndefined()
    expect(calls).toBe(0)
    coordinator.snapshot('ensure')
    await coordinator.query('legacy', false)
    const failed = coordinator.snapshot('cache').accounts
    expect(failed[0]?.gemini).toMatchObject({
      remainingPercent: 35,
      source: 'cache',
      refreshState: 'error',
    })
    expect(Object.hasOwn(failed[0]!.gemini, 'updatedAt')).toBe(false)
    expect(failed[1]?.state).toBe('disabled')
    expect(calls).toBe(1)
    await coordinator.dispose()
  })

  test('time zero is a valid successful receipt and live percentages stay bounded', async () => {
    let now = 0
    let calls = 0
    const accounts = [account('a')]
    const coordinator = new SidebarQuotaCoordinator({
      accounts: () => accounts,
      active: () => ({ claude: 0, gemini: 0 }),
      logicalToken: (token) => token,
      now: () => now,
      fetch: async () => {
        calls += 1
        return success({ gemini: { remainingFraction: 1.5, modelCount: 1 } })
      },
    })
    coordinator.snapshot('cache')
    await coordinator.query('a', false)
    expect(
      coordinator.snapshot('cache').accounts[0]?.gemini.remainingPercent,
    ).toBe(100)
    coordinator.snapshot('ensure')
    await coordinator.query('a', false)
    expect(calls).toBe(1)
    now = 5 * 60_000
    await coordinator.query('a', false)
    expect(calls).toBe(2)
    await coordinator.dispose()
  })

  test('cache reads make no requests; initial ensure validates even recent disk cache and five minute expiry', async () => {
    let now = 1_700_000_000_000
    let calls = 0
    const accounts = [
      account('a', {
        cachedQuota: { gemini: { remainingFraction: 0.2, modelCount: 1 } },
        cachedQuotaAccountId: quotaAccountIdentity('a'),
        cachedQuotaUpdatedAt: now,
        cachedQuotaSuccessAt: now - 10_000,
      }),
    ]
    const coordinator = new SidebarQuotaCoordinator({
      accounts: () => accounts,
      active: () => ({ claude: 0, gemini: 0 }),
      logicalToken: (token) => token,
      now: () => now,
      fetch: async () => {
        calls += 1
        return success({ gemini: { remainingFraction: 0.7, modelCount: 1 } })
      },
    })
    expect(
      coordinator.snapshot('cache').accounts[0]?.gemini.remainingPercent,
    ).toBe(20)
    expect(calls).toBe(0)
    coordinator.snapshot('ensure')
    await coordinator.query('a', false)
    expect(calls).toBe(1)
    expect(
      coordinator.snapshot('cache').accounts[0]?.gemini.remainingPercent,
    ).toBe(70)
    expect(
      coordinator.snapshot('cache').accounts[0]?.nonGemini.refreshState,
    ).toBe('unavailable')
    coordinator.snapshot('ensure')
    await coordinator.query('a', false)
    expect(calls).toBe(1)
    now += 5 * 60_000
    await coordinator.query('a', false)
    expect(calls).toBe(2)
    await coordinator.dispose()
  })

  test('failed account retains cached age and does not block another account', async () => {
    let now = 100_000
    const old = 10_000
    const accounts = [
      account('a', {
        cachedQuota: { gemini: { remainingFraction: 0.4, modelCount: 1 } },
        cachedQuotaAccountId: quotaAccountIdentity('a'),
        cachedQuotaUpdatedAt: old,
        cachedQuotaSuccessAt: old - 5_000,
      }),
      account('b'),
    ]
    const calls: string[] = []
    const coordinator = new SidebarQuotaCoordinator({
      accounts: () => accounts,
      active: () => ({ claude: 0, gemini: 1 }),
      logicalToken: (token) => token,
      now: () => now,
      fetch: async (item) => {
        calls.push(item.refreshToken)
        return item.refreshToken === 'a'
          ? {
              index: 0,
              status: 'ok',
              quota: {
                groups: {},
                modelCount: 0,
                error: 'private upstream error',
              },
            }
          : success({ 'non-gemini': { remainingFraction: 0.8, modelCount: 1 } })
      },
    })
    coordinator.snapshot('ensure')
    await coordinator.query('b', false)
    const rows = coordinator.snapshot('cache').accounts
    expect(calls).toEqual(['a', 'b'])
    expect(rows[0]?.gemini).toMatchObject({
      remainingPercent: 40,
      updatedAt: old - 5_000,
      refreshState: 'error',
    })
    expect(rows[1]?.nonGemini).toMatchObject({
      remainingPercent: 80,
      refreshState: 'idle',
    })
    coordinator.snapshot('ensure')
    await coordinator.query('a', false)
    expect(calls).toHaveLength(2)
    now += 60_000
    await coordinator.query('a', false)
    expect(calls).toHaveLength(3)
    await coordinator.dispose()
  })

  test('automatic success updates memory success time and later failure preserves it', async () => {
    let now = 100_000
    let calls = 0
    const persisted = account('a', {
      cachedQuota: { gemini: { remainingFraction: 0.4, modelCount: 1 } },
      cachedQuotaAccountId: quotaAccountIdentity('a'),
      cachedQuotaUpdatedAt: 90_000,
      cachedQuotaSuccessAt: 80_000,
    })
    const coordinator = new SidebarQuotaCoordinator({
      accounts: () => [persisted],
      active: () => ({ claude: 0, gemini: 0 }),
      logicalToken: (token) => token,
      now: () => now,
      fetch: async () => {
        calls += 1
        return calls === 1
          ? success({ gemini: { remainingFraction: 0.7, modelCount: 1 } })
          : { index: 0, status: 'error', error: 'offline' }
      },
    })
    const initial = coordinator.snapshot('cache').accounts[0]!
    expect(initial.gemini.updatedAt).toBe(80_000)
    expect(initial.cacheUpdatedAt).toBe(90_000)
    await coordinator.query('a', true)
    now = 110_000
    const live = coordinator.snapshot('cache').accounts[0]!
    expect(live.gemini).toMatchObject({
      remainingPercent: 70,
      source: 'live',
      updatedAt: 100_000,
    })
    await coordinator.query('a', true)
    const failed = coordinator.snapshot('cache').accounts[0]!
    expect(failed.gemini).toMatchObject({
      remainingPercent: 70,
      source: 'live',
      updatedAt: 100_000,
      refreshState: 'error',
    })
    expect(failed.cacheUpdatedAt).toBe(90_000)
    expect(persisted.cachedQuotaSuccessAt).toBe(80_000)
    await coordinator.dispose()
  })

  test('manual joins automatic query and can force a fresh account', async () => {
    const accounts = [account('a')]
    let calls = 0
    let release: (() => void) | undefined
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const coordinator = new SidebarQuotaCoordinator({
      accounts: () => accounts,
      active: () => ({ claude: 0, gemini: 0 }),
      logicalToken: (token) => token,
      now: () => 100_000,
      fetch: async () => {
        calls += 1
        await blocked
        return success({})
      },
    })
    coordinator.snapshot('ensure')
    const manual = coordinator.refreshAll([
      { refreshToken: 'a', addedAt: 1, lastUsed: 1 },
    ])
    release?.()
    await manual
    expect(calls).toBe(1)
    await coordinator.refreshAll([
      { refreshToken: 'a', addedAt: 1, lastUsed: 1 },
    ])
    expect(calls).toBe(2)
    await coordinator.dispose()
  })

  test('rotation aliases keep a queued result on the logical account, while removal discards it', async () => {
    const accounts = [account('old'), account('removed')]
    const aliases = new Map<string, string>()
    let release: (() => void) | undefined
    let started: (() => void) | undefined
    const began = new Promise<void>((resolve) => {
      started = resolve
    })
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const coordinator = new SidebarQuotaCoordinator({
      accounts: () => accounts,
      active: () => ({ claude: 0, gemini: 0 }),
      logicalToken: (token) => aliases.get(token) ?? token,
      now: () => 100_000,
      fetch: async (item) => {
        started?.()
        await blocked
        return success({
          gemini: {
            remainingFraction: item.refreshToken === 'old' ? 0.6 : 0.1,
            modelCount: 1,
          },
        })
      },
    })
    coordinator.snapshot('cache')
    const old = coordinator.query('old', false)
    const removed = coordinator.query('removed', false)
    await began
    accounts.splice(0, 2, account('new'))
    aliases.set('new', 'old')
    release?.()
    await Promise.all([old, removed])
    const rows = coordinator.snapshot('cache').accounts
    expect(rows).toHaveLength(1)
    expect(rows[0]?.gemini.remainingPercent).toBe(60)
    await coordinator.dispose()
  })

  test('reorder uses identity, disabled accounts are skipped, and disposal fences late results', async () => {
    const accounts = [account('a'), account('b')]
    let release: (() => void) | undefined
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const calls: string[] = []
    const coordinator = new SidebarQuotaCoordinator({
      accounts: () => accounts,
      active: () => ({ claude: 0, gemini: 1 }),
      logicalToken: (token) => token,
      now: () => 100_000,
      fetch: async (item) => {
        calls.push(item.refreshToken)
        if (item.refreshToken === 'a') await blocked
        return success({ gemini: { remainingFraction: 0.9, modelCount: 1 } })
      },
    })
    coordinator.snapshot('ensure')
    accounts.reverse()
    accounts[1] = account('a', { enabled: false })
    release?.()
    await coordinator.query('b', false)
    const rows = coordinator.snapshot('cache').accounts
    expect(rows[0]?.label).toBe('Account 1')
    expect(rows[0]?.gemini.remainingPercent).toBe(90)
    expect(rows[1]?.state).toBe('disabled')
    const pending = coordinator.query('b', true)
    await coordinator.dispose()
    await pending
    expect(coordinator.snapshot('cache').accounts[0]?.gemini.source).toBe(
      'cache',
    )
    expect(calls).toEqual(['b'])
  })
})
