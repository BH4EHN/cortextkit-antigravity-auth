import { describe, expect, test } from 'bun:test'
import type { ManagedAccount } from '@cortexkit/antigravity-auth-core'

import {
  projectPanelAccounts,
  projectRows,
  quotaAccountIdentity,
} from '../src/commands.ts'
import { panelSnapshot, sidebarQuotaSnapshot } from '../src/rpc.ts'
import { SidebarQuotaCoordinator } from '../src/sidebar-quota.ts'
import { encodeRpcOutput } from './rpc-output-codec.ts'

const account = {
  label: 'Account 1',
  state: 'active' as const,
  current: 'both' as const,
  gemini: { remainingPercent: 70, windows: [] },
  nonGemini: { remainingPercent: 30, windows: [] },
  cacheUpdatedAt: 200,
  cacheSuccessAt: 100,
}

function managedAccount(
  refreshToken: string,
  overrides: Partial<ManagedAccount> = {},
): ManagedAccount {
  return {
    index: 0,
    parts: { refreshToken },
    addedAt: 1,
    lastUsed: 1,
    enabled: true,
    rateLimitResetTimes: {},
    touchedForQuota: {},
    ...overrides,
  }
}

describe('v2 account RPC success timestamps', () => {
  test('panel and sidebar account rows accept the optional cacheSuccessAt field', () => {
    const panel = panelSnapshot.parse({ kind: 'account', accounts: [account] })
    expect(panel.kind).toBe('account')
    if (panel.kind === 'account')
      expect(panel.accounts[0]?.cacheSuccessAt).toBe(100)

    const sidebar = sidebarQuotaSnapshot.parse({
      accounts: [
        {
          ...account,
          gemini: { ...account.gemini, source: 'cache', refreshState: 'idle' },
          nonGemini: {
            ...account.nonGemini,
            source: 'cache',
            refreshState: 'idle',
          },
        },
      ],
      notices: [],
    })
    expect(sidebar.accounts[0]?.cacheSuccessAt).toBe(100)
  })

  test('panel projection encodes absent and historical optionals and preserves zero timestamps', async () => {
    const rows = projectPanelAccounts(
      projectRows(
        [
          managedAccount('empty'),
          managedAccount('historical', {
            cachedQuota: {
              gemini: { remainingFraction: 0.45, modelCount: 1 },
            },
            cachedQuotaAccountId: quotaAccountIdentity('historical'),
            cachedQuotaUpdatedAt: 200,
          }),
          managedAccount('zero', {
            cachedQuota: {
              gemini: {
                remainingFraction: 0,
                modelCount: 1,
                resetTime: new Date(0).toISOString(),
                windows: [
                  {
                    window: '5h',
                    remainingFraction: 0,
                    resetTime: new Date(0).toISOString(),
                  },
                ],
              },
            },
            cachedQuotaAccountId: quotaAccountIdentity('zero'),
            cachedQuotaUpdatedAt: 0,
            cachedQuotaSuccessAt: 0,
          }),
        ],
        { claude: 0, gemini: 0 },
      ),
    )
    const output = { kind: 'account', accounts: rows }

    await expect(encodeRpcOutput(output)).resolves.toBeDefined()
    expect(Object.hasOwn(rows[0]!.gemini, 'resetAt')).toBe(false)
    expect(Object.hasOwn(rows[0]!, 'cacheUpdatedAt')).toBe(false)
    expect(Object.hasOwn(rows[1]!, 'cacheSuccessAt')).toBe(false)
    expect(rows[2]?.cacheUpdatedAt).toBe(0)
    expect(rows[2]?.cacheSuccessAt).toBe(0)
    expect(rows[2]?.gemini.resetAt).toBe(0)
    expect(rows[2]?.gemini.windows[0]?.resetAt).toBe(0)
  })

  test('sidebar coordinator encodes empty cache, legacy cache, and zero success timestamp', async () => {
    const coordinator = new SidebarQuotaCoordinator({
      accounts: () => [
        managedAccount('empty'),
        managedAccount('legacy', {
          cachedQuota: {
            gemini: { remainingFraction: 0.35, modelCount: 1 },
          },
          cachedQuotaAccountId: quotaAccountIdentity('legacy'),
          cachedQuotaUpdatedAt: 300,
        }),
        managedAccount('zero', {
          cachedQuota: {
            gemini: {
              remainingFraction: 0.5,
              modelCount: 1,
              resetTime: new Date(0).toISOString(),
            },
          },
          cachedQuotaAccountId: quotaAccountIdentity('zero'),
          cachedQuotaUpdatedAt: 0,
          cachedQuotaSuccessAt: 0,
        }),
      ],
      active: () => ({ claude: 0, gemini: 0 }),
      logicalToken: (token) => token,
      fetch: async () => ({ index: 0, status: 'disabled' }),
      now: () => 500,
    })
    try {
      const output = coordinator.snapshot('cache')
      await expect(encodeRpcOutput(output)).resolves.toBeDefined()
      expect(output.accounts[0]?.gemini.remainingPercent).toBeNull()
      expect(output.accounts[0]?.gemini.windows).toEqual([])
      expect(Object.hasOwn(output.accounts[0]!.gemini, 'resetAt')).toBe(false)
      expect(Object.hasOwn(output.accounts[0]!, 'cacheUpdatedAt')).toBe(false)
      expect(Object.hasOwn(output.accounts[1]!.gemini, 'updatedAt')).toBe(false)
      expect(Object.hasOwn(output.accounts[1]!, 'cacheSuccessAt')).toBe(false)
      expect(output.accounts[2]?.cacheUpdatedAt).toBe(0)
      expect(output.accounts[2]?.gemini.updatedAt).toBe(0)
      expect(output.accounts[2]?.gemini.resetAt).toBe(0)
    } finally {
      await coordinator.dispose()
    }
  })

  test('installed RPC JSON codec rejects an explicitly undefined nested field', async () => {
    await expect(encodeRpcOutput({ invalid: undefined })).rejects.toThrow(
      'Expected JSON value',
    )
  })
})
