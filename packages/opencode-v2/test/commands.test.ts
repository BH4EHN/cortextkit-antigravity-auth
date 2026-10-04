import { describe, expect, test } from 'bun:test'

import type {
  AccountMetadataV3,
  AccountQuotaResult,
  AccountStorageV4,
  ManagedAccount,
} from '@cortexkit/antigravity-auth-core'

import type { CommandDefinition } from '@opencode-ai/plugin/promise/command'

import {
  type AccountManagerView,
  type AntigravityCommandRuntime,
  createAntigravityCommands,
  formatRowsTable,
  parseAccountArgs,
  parseQuotaArgs,
  projectPanelAccounts,
  projectRows,
  quotaAccountIdentity,
} from '../src/commands.ts'

const FIXED_NOW = 1_700_000_000_000

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

function storageAccount(
  refreshToken: string,
  overrides: Partial<AccountMetadataV3> = {},
): AccountMetadataV3 {
  return {
    refreshToken,
    addedAt: 1,
    lastUsed: 1,
    enabled: true,
    ...overrides,
  }
}

function managedFromStorage(
  entry: AccountMetadataV3,
  index: number,
): ManagedAccount {
  return managedAccount(entry.refreshToken, {
    index,
    email: entry.email,
    enabled: entry.enabled !== false,
    accountIneligible: entry.accountIneligible,
    verificationRequired: entry.verificationRequired,
    cachedQuota: entry.cachedQuota,
    cachedQuotaAccountId: entry.cachedQuotaAccountId,
    cachedQuotaUpdatedAt: entry.cachedQuotaUpdatedAt,
  })
}

describe('parseAccountArgs', () => {
  test('defaults to list and tolerates the command-name prefix', () => {
    expect(parseAccountArgs('')).toEqual({ kind: 'list' })
    expect(parseAccountArgs('list')).toEqual({ kind: 'list' })
    expect(parseAccountArgs('/antigravity-account list')).toEqual({
      kind: 'list',
    })
    expect(parseAccountArgs('add')).toEqual({ kind: 'add' })
    expect(parseAccountArgs('/antigravity-account add')).toEqual({
      kind: 'add',
    })
  })

  test('parses ordinal subcommands', () => {
    expect(parseAccountArgs('use 2')).toEqual({ kind: 'use', n: 2 })
    expect(parseAccountArgs('enable 1')).toEqual({ kind: 'enable', n: 1 })
    expect(parseAccountArgs('disable 10')).toEqual({ kind: 'disable', n: 10 })
  })

  test('rejects missing or invalid ordinals with usage', () => {
    expect(parseAccountArgs('use').kind).toBe('usage')
    expect(parseAccountArgs('use abc').kind).toBe('usage')
    expect(parseAccountArgs('use 0').kind).toBe('usage')
    expect(parseAccountArgs('remove').kind).toBe('usage')
  })

  test('rejects trailing arguments for non-remove subcommands', () => {
    expect(parseAccountArgs('use 1 extra').kind).toBe('usage')
    expect(parseAccountArgs('list extra').kind).toBe('usage')
    expect(parseAccountArgs('add extra').kind).toBe('usage')
    expect(parseAccountArgs('bogus').kind).toBe('usage')
  })

  test('remove requires the confirm word but defaults to unconfirmed', () => {
    expect(parseAccountArgs('remove 3')).toEqual({
      kind: 'remove',
      n: 3,
      confirmed: false,
    })
    expect(parseAccountArgs('remove 3 confirm')).toEqual({
      kind: 'remove',
      n: 3,
      confirmed: true,
    })
    expect(parseAccountArgs('remove 3 confirm extra').kind).toBe('usage')
    expect(parseAccountArgs('remove 3 confirm extra more').kind).toBe('usage')
    expect(parseAccountArgs('remove 3 yes').kind).toBe('usage')
  })
})

describe('parseQuotaArgs', () => {
  test('defaults to the zero-network cache view', () => {
    expect(parseQuotaArgs('')).toEqual({ kind: 'cache' })
    expect(parseQuotaArgs('/antigravity-quota')).toEqual({ kind: 'cache' })
    expect(parseQuotaArgs('refresh')).toEqual({ kind: 'refresh' })
  })

  test('rejects unknown arguments', () => {
    expect(parseQuotaArgs('force').kind).toBe('usage')
    expect(parseQuotaArgs('refresh now').kind).toBe('usage')
  })
})

describe('projectRows', () => {
  test('keeps cached quota only when the account stamp matches', () => {
    const matching = managedAccount('token-a', {
      cachedQuota: { gemini: { remainingFraction: 0.72, modelCount: 2 } },
      cachedQuotaAccountId: quotaAccountIdentity('token-a'),
      cachedQuotaUpdatedAt: FIXED_NOW - 60_000,
      cachedQuotaSuccessAt: FIXED_NOW - 90_000,
    })
    const stale = managedAccount('token-b', {
      index: 1,
      cachedQuota: { 'non-gemini': { remainingFraction: 0.5, modelCount: 1 } },
      cachedQuotaAccountId: quotaAccountIdentity('some-other-token'),
      cachedQuotaSuccessAt: FIXED_NOW - 30_000,
    })
    const rows = projectRows([matching, stale], { claude: 0, gemini: 0 })
    expect(rows[0]?.gemini.percent).toBe(72)
    expect(rows[0]?.updatedAt).toBe(FIXED_NOW - 60_000)
    expect(rows[0]?.successAt).toBe(FIXED_NOW - 90_000)
    expect(projectPanelAccounts(rows)[0]?.cacheSuccessAt).toBe(
      FIXED_NOW - 90_000,
    )
    expect(projectPanelAccounts(rows)[0]?.cacheUpdatedAt).toBe(
      FIXED_NOW - 60_000,
    )
    expect(rows[1]?.nonGemini.percent).toBeNull()
    expect(rows[1]?.updatedAt).toBeUndefined()
    expect(rows[1]?.successAt).toBeUndefined()
    const legacy = projectRows(
      [
        managedAccount('legacy', {
          cachedQuota: { gemini: { remainingFraction: 0.2, modelCount: 1 } },
          cachedQuotaUpdatedAt: FIXED_NOW,
          cachedQuotaSuccessAt: FIXED_NOW - 30_000,
        }),
      ],
      { claude: 0, gemini: 0 },
    )[0]!
    expect(legacy.gemini.percent).toBe(20)
    expect(legacy.updatedAt).toBe(FIXED_NOW)
    expect(legacy.successAt).toBeUndefined()
    expect(projectPanelAccounts([legacy])[0]?.cacheSuccessAt).toBeUndefined()
    const orphanedMarker = projectRows(
      [managedAccount('no-cache', { cachedQuotaSuccessAt: FIXED_NOW })],
      { claude: 0, gemini: 0 },
    )[0]!
    expect(orphanedMarker.successAt).toBeUndefined()
  })

  test('marks per-family current accounts', () => {
    const accounts = [
      managedAccount('a'),
      managedAccount('b', { index: 1 }),
      managedAccount('c', { index: 2 }),
      managedAccount('d', { index: 3 }),
    ]
    const rows = projectRows(accounts, { claude: 2, gemini: 2 })
    expect(rows[2]?.current).toBe('*')
    const split = projectRows(accounts, { claude: 0, gemini: 1 })
    expect(split[0]?.current).toBe('c')
    expect(split[1]?.current).toBe('g')
    expect(split[2]?.current).toBe(' ')
  })

  test('maps account state precedence', () => {
    expect(
      projectRows(
        [
          managedAccount('a', { enabled: false }),
          managedAccount('b', {
            index: 1,
            enabled: false,
            accountIneligible: true,
          }),
          managedAccount('c', {
            index: 2,
            enabled: false,
            verificationRequired: true,
          }),
          managedAccount('d', {
            index: 3,
            enabled: false,
            accountIneligible: true,
            verificationRequired: true,
          }),
        ],
        { claude: 0, gemini: 0 },
      ).map((row) => row.state),
    ).toEqual(['disabled', 'ineligible', 'verification-required', 'ineligible'])
  })
})

describe('formatRowsTable', () => {
  test('renders percentages, dash placeholders and window breakdown', () => {
    const rows = projectRows(
      [
        managedAccount('a', {
          cachedQuota: {
            gemini: {
              remainingFraction: 0.72,
              modelCount: 2,
              resetTime: new Date(FIXED_NOW + 3 * 3_600_000).toISOString(),
              windows: [
                {
                  window: '5h',
                  remainingFraction: 0.9,
                  resetTime: new Date(FIXED_NOW + 60 * 60_000).toISOString(),
                },
                {
                  window: 'weekly',
                  remainingFraction: 0.72,
                  resetTime: new Date(FIXED_NOW + 3 * 3_600_000).toISOString(),
                },
              ],
            },
          },
          cachedQuotaAccountId: quotaAccountIdentity('a'),
          cachedQuotaUpdatedAt: FIXED_NOW - 120_000,
        }),
      ],
      { claude: 0, gemini: 0 },
    )
    const table = formatRowsTable(rows, FIXED_NOW)
    expect(table).toContain('Account 1')
    expect(table).toContain('72%')
    expect(table).toContain('-  ')
    expect(table).toContain('2m ago')
    expect(table).toContain('5h 90%')
    expect(table).toContain('weekly 72%')
  })

  test('never renders the email PII field', () => {
    const rows = projectRows(
      [managedAccount('a', { email: 'secret@example.test' })],
      { claude: 0, gemini: 0 },
    )
    expect(formatRowsTable(rows, FIXED_NOW)).not.toContain(
      'secret@example.test',
    )
  })
})

interface RuntimeFixtures {
  runtime: AntigravityCommandRuntime
  manager: AccountManagerView & { accounts: ManagedAccount[] }
  outputs: Array<{ sessionID: string; text: string }>
  storage: () => AccountStorageV4
  added: () => number
  quotaFetches: () => number
  mutates: () => number
  order: () => string[]
}

function createFixtures(input: {
  storage: AccountStorageV4
  results?: AccountQuotaResult[]
  snapshot?: AccountMetadataV3[]
  /** Applied to storage when fetchPoolQuota runs — simulates a concurrent writer. */
  mutateOnFetch?: (storage: AccountStorageV4) => AccountStorageV4
  mutateOnFlush?: (storage: AccountStorageV4) => Promise<AccountStorageV4>
}): RuntimeFixtures {
  const outputs: Array<{ sessionID: string; text: string }> = []
  const order: string[] = []
  let storageRef = input.storage
  let addedCount = 0
  let quotaFetches = 0
  let mutateCount = 0
  const manager = {
    accounts: storageRef.accounts.map(managedFromStorage),
    getActiveIndexByFamily: () => ({
      claude:
        storageRef.activeIndexByFamily?.claude ?? storageRef.activeIndex ?? 0,
      gemini:
        storageRef.activeIndexByFamily?.gemini ?? storageRef.activeIndex ?? 0,
    }),
    getOldestQuotaCacheAge: () => null,
    getAccounts: () => manager.accounts,
  }
  const runtime: AntigravityCommandRuntime = {
    getManager: () => manager,
    reloadPool: async () => {
      order.push('reload')
      manager.accounts = storageRef.accounts.map(managedFromStorage)
    },
    flushPool: async () => {
      order.push('flush')
      if (input.mutateOnFlush)
        storageRef = await input.mutateOnFlush(storageRef)
    },
    mutateStorage: async (mutator) => {
      order.push('mutate')
      mutateCount += 1
      storageRef = mutator(storageRef)
    },
    fetchPoolQuota: async () => {
      quotaFetches += 1
      if (input.mutateOnFetch) {
        storageRef = input.mutateOnFetch(storageRef)
      }
      return {
        snapshot: input.snapshot ?? [],
        results: input.results ?? [],
      }
    },
    oauthAdd: async (announce) => {
      addedCount += 1
      await announce('https://accounts.example/authorize?state=x')
    },
    emit: async (sessionID, text) => {
      outputs.push({ sessionID, text })
    },
    log: () => {},
    now: () => FIXED_NOW,
    accountsFile: '/tmp/antigravity-accounts.json',
    logFile: '/tmp/antigravity.log',
  }
  return {
    runtime,
    manager,
    outputs,
    storage: () => storageRef,
    added: () => addedCount,
    quotaFetches: () => quotaFetches,
    mutates: () => mutateCount,
    order: () => [...order],
  }
}

function singleStorage(
  accounts: AccountMetadataV3[],
  activeIndex = 0,
): AccountStorageV4 {
  return {
    version: 4,
    accounts,
    activeIndex,
    activeIndexByFamily: { claude: activeIndex, gemini: activeIndex },
  }
}

async function execute(
  definition: CommandDefinition,
  text: string,
): Promise<void> {
  await definition.execute({
    sessionID: 'session-1',
    prompt: { text },
    delivery: 'steer',
  } as never)
}

function commandMap(
  runtime: AntigravityCommandRuntime,
): Record<string, CommandDefinition> {
  const map: Record<string, CommandDefinition> = {}
  for (const definition of createAntigravityCommands(runtime)) {
    map[definition.name] = definition
  }
  return map
}

describe('antigravity-account remove two-step', () => {
  test('without confirm nothing is mutated', async () => {
    const fixtures = createFixtures({
      storage: singleStorage([storageAccount('token-a')]),
    })
    const commands = commandMap(fixtures.runtime)
    await execute(commands['antigravity-account']!, 'remove 1')
    expect(fixtures.outputs[0]?.text).toContain('Will remove Account 1')
    expect(fixtures.outputs[0]?.text).toContain('confirm')
    expect(fixtures.storage().accounts).toHaveLength(1)
  })

  test('extra words after confirm cannot remove an account', async () => {
    const fixtures = createFixtures({
      storage: singleStorage([storageAccount('token-a')]),
    })
    await execute(
      commandMap(fixtures.runtime)['antigravity-account']!,
      'remove 1 confirm extra',
    )
    expect(
      fixtures.storage().accounts.map((account) => account.refreshToken),
    ).toEqual(['token-a'])
    expect(fixtures.mutates()).toBe(0)
    expect(fixtures.outputs.at(-1)?.text).toContain('Unexpected argument')
  })

  test('with confirm removes by token and recomputes family cursors', async () => {
    const fixtures = createFixtures({
      storage: singleStorage(
        [storageAccount('token-a'), storageAccount('token-b')],
        0,
      ),
    })
    const commands = commandMap(fixtures.runtime)
    await execute(commands['antigravity-account']!, 'remove 1 confirm')
    expect(fixtures.storage().accounts.map((a) => a.refreshToken)).toEqual([
      'token-b',
    ])
    expect(fixtures.storage().activeIndexByFamily).toEqual({
      claude: 0,
      gemini: 0,
    })
    expect(fixtures.outputs.at(-1)?.text).toContain('Removed Account 1')
  })

  test('remove resolves captured A after a token rotation during flush', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const fixtures = createFixtures({
      storage: singleStorage([
        storageAccount('token-a'),
        storageAccount('token-b'),
      ]),
      mutateOnFlush: async (current) => {
        await gate
        return {
          ...current,
          accounts: current.accounts.map((entry) =>
            entry.refreshToken === 'token-a'
              ? { ...entry, refreshToken: 'token-a-rotated' }
              : entry,
          ),
        }
      },
    })
    fixtures.runtime.resolveToken = (token) =>
      token === 'token-a' ? 'token-a-rotated' : token
    const pending = execute(
      commandMap(fixtures.runtime)['antigravity-account']!,
      'remove 1 confirm',
    )
    release()
    await pending
    expect(
      fixtures.storage().accounts.map((entry) => entry.refreshToken),
    ).toEqual(['token-b'])
    expect(fixtures.mutates()).toBe(1)
  })

  test('confirm on an already-removed account reports it as missing', async () => {
    const fixtures = createFixtures({
      storage: singleStorage([storageAccount('token-a')]),
    })
    const commands = commandMap(fixtures.runtime)
    await execute(commands['antigravity-account']!, 'remove 1 confirm')
    await execute(commands['antigravity-account']!, 'remove 1 confirm')
    expect(fixtures.outputs.at(-1)?.text).toContain('does not exist')
  })

  test('removal racing a concurrent delete reports not in the pool', async () => {
    const fixtures = createFixtures({
      storage: singleStorage([storageAccount('token-a')]),
    })
    // The live view still lists the account but the locked storage lost it
    // in the meantime — the mutator must be a no-op and the command must
    // say so instead of claiming a successful removal.
    fixtures.runtime.mutateStorage = async () => {}
    const commands = commandMap(fixtures.runtime)
    await execute(commands['antigravity-account']!, 'remove 1 confirm')
    expect(fixtures.outputs.at(-1)?.text).toContain('not in the pool')
  })
})

describe('antigravity-account use / enable / disable', () => {
  test('use pins both family cursors to the target token', async () => {
    const fixtures = createFixtures({
      storage: singleStorage([
        storageAccount('token-a'),
        storageAccount('token-b'),
      ]),
    })
    const commands = commandMap(fixtures.runtime)
    await execute(commands['antigravity-account']!, 'use 2')
    expect(fixtures.storage().activeIndex).toBe(1)
    expect(fixtures.storage().activeIndexByFamily).toEqual({
      claude: 1,
      gemini: 1,
    })
    expect(fixtures.outputs.at(-1)?.text).toContain(
      'Current account set to Account 2',
    )
  })

  test('enable refuses ineligible accounts', async () => {
    const fixtures = createFixtures({
      storage: singleStorage([
        storageAccount('token-a', { enabled: false, accountIneligible: true }),
      ]),
    })
    const commands = commandMap(fixtures.runtime)
    await execute(commands['antigravity-account']!, 'enable 1')
    expect(fixtures.outputs[0]?.text).toContain('ineligible')
    expect(fixtures.storage().accounts[0]?.enabled).toBe(false)
  })

  test('enable rechecks A after flush while B list and use remain available', async () => {
    const fixtures = createFixtures({
      storage: singleStorage([
        storageAccount('token-a', { enabled: false }),
        storageAccount('token-b', { enabled: true }),
      ]),
      mutateOnFlush: async (current) => ({
        ...current,
        accounts: current.accounts.map((entry) =>
          entry.refreshToken === 'token-a'
            ? { ...entry, enabled: false, accountIneligible: true }
            : entry,
        ),
      }),
    })
    const commands = commandMap(fixtures.runtime)
    await execute(commands['antigravity-account']!, 'enable 1')
    expect(fixtures.outputs.at(-1)?.text).toContain('ineligible')
    expect(fixtures.storage().accounts.map((entry) => entry.enabled)).toEqual([
      false,
      true,
    ])
    await execute(commands['antigravity-account']!, 'list')
    expect(fixtures.outputs.at(-1)?.text).toContain('Account 2')
    await execute(commands['antigravity-account']!, 'use 2')
    expect(fixtures.storage().activeIndexByFamily).toEqual({
      claude: 1,
      gemini: 1,
    })
  })

  for (const scenario of [
    {
      command: 'disable 1',
      live: false,
      stored: true,
      final: false,
      notice: 'Disabled Account 1',
    },
    {
      command: 'enable 1',
      live: true,
      stored: false,
      final: true,
      notice: 'Enabled Account 1',
    },
    {
      command: 'enable 1',
      live: false,
      stored: true,
      final: true,
      notice: 'already enabled',
    },
    {
      command: 'disable 1',
      live: true,
      stored: false,
      final: false,
      notice: 'already disabled',
    },
  ]) {
    test(`${scenario.command} uses the locked A flag when the live flag is ${scenario.live}`, async () => {
      const fixtures = createFixtures({
        storage: singleStorage([
          storageAccount('token-a', { enabled: scenario.live }),
          storageAccount('token-b', { enabled: true }),
        ]),
        mutateOnFlush: async (current) => ({
          ...current,
          accounts: current.accounts.map((entry) =>
            entry.refreshToken === 'token-a'
              ? { ...entry, enabled: scenario.stored }
              : entry,
          ),
        }),
      })
      await execute(
        commandMap(fixtures.runtime)['antigravity-account']!,
        scenario.command,
      )
      expect(fixtures.storage().accounts.map((entry) => entry.enabled)).toEqual(
        [scenario.final, true],
      )
      expect(fixtures.outputs.at(-1)?.text).toContain(scenario.notice)
    })
  }

  test('enable preserves verification-required state and explains v2 selection', async () => {
    const fixtures = createFixtures({
      storage: singleStorage([
        storageAccount('token-a', {
          enabled: false,
          verificationRequired: true,
        }),
        storageAccount('token-b', { enabled: true }),
      ]),
    })
    const command = commandMap(fixtures.runtime)['antigravity-account']!
    await execute(command, 'enable 1')
    expect(fixtures.storage().accounts[0]).toMatchObject({
      enabled: true,
      verificationRequired: true,
    })
    expect(fixtures.outputs.at(-1)?.text).toContain(
      'Verification is still required; OpenCode 2 will not select it',
    )
    await execute(command, 'enable 1')
    expect(fixtures.outputs.at(-1)?.text).toContain('already enabled')
    expect(fixtures.outputs.at(-1)?.text).toContain(
      'Verification is still required; OpenCode 2 will not select it',
    )
  })

  test('disable flips the flag and suggests the restore command', async () => {
    const fixtures = createFixtures({
      storage: singleStorage([storageAccount('token-a')]),
    })
    const commands = commandMap(fixtures.runtime)
    await execute(commands['antigravity-account']!, 'disable 1')
    expect(fixtures.storage().accounts[0]?.enabled).toBe(false)
    expect(fixtures.outputs.at(-1)?.text).toContain('enable 1')
  })

  test('unknown index produces a guarded error, not a crash', async () => {
    const fixtures = createFixtures({
      storage: singleStorage([storageAccount('token-a')]),
    })
    const commands = commandMap(fixtures.runtime)
    await execute(commands['antigravity-account']!, 'use 9')
    expect(fixtures.outputs.at(-1)?.text).toContain(
      'Antigravity command failed',
    )
  })
})

describe('antigravity-account add', () => {
  test('announces the login URL through the session', async () => {
    const fixtures = createFixtures({
      storage: singleStorage([storageAccount('token-a')]),
    })
    const commands = commandMap(fixtures.runtime)
    await execute(commands['antigravity-account']!, 'add')
    expect(fixtures.added()).toBe(1)
    expect(
      fixtures.outputs.some((o) => o.text.includes('accounts.example')),
    ).toBe(true)
  })
})

describe('antigravity-quota refresh write-back', () => {
  test('uses the original snapshot token when quota refresh rotates a token', async () => {
    const fixtures = createFixtures({
      storage: singleStorage([storageAccount('token-before')]),
      snapshot: [storageAccount('token-before')],
      results: [
        {
          index: 0,
          status: 'ok',
          quota: {
            groups: { gemini: { remainingFraction: 0.42, modelCount: 1 } },
            modelCount: 1,
          },
          updatedAccount: storageAccount('token-after'),
        },
      ],
    })
    await execute(commandMap(fixtures.runtime)['antigravity-quota']!, 'refresh')
    const stored = fixtures.storage().accounts[0]!
    expect(stored.refreshToken).toBe('token-before')
    expect(stored.cachedQuota?.gemini?.remainingFraction).toBe(0.42)
    expect(stored.cachedQuotaAccountId).toBe(
      quotaAccountIdentity('token-before'),
    )
    expect(stored.cachedQuotaSuccessAt).toBe(FIXED_NOW)
  })

  test('keys updates by refresh token even when indices shifted', async () => {
    const snapshot = [storageAccount('token-a'), storageAccount('token-b')]
    // Disk order changed between snapshot and write-back (concurrent add):
    // token-b now occupies index 0. A result keyed by stale index must still
    // land on the account that produced it.
    const fixtures = createFixtures({
      storage: singleStorage([
        storageAccount('token-b', {
          cachedQuota: {
            'non-gemini': { remainingFraction: 0.1, modelCount: 1 },
          },
          cachedQuotaAccountId: quotaAccountIdentity('token-b'),
          cachedQuotaSuccessAt: 456,
        }),
        storageAccount('token-a', {
          cachedQuota: { gemini: { remainingFraction: 0.12, modelCount: 1 } },
          cachedQuotaAccountId: quotaAccountIdentity('token-a'),
          cachedQuotaSuccessAt: 123,
        }),
      ]),
      snapshot,
      results: [
        {
          index: 1,
          status: 'ok',
          quota: {
            groups: { gemini: { remainingFraction: 0.66, modelCount: 3 } },
            modelCount: 3,
          },
          updatedAccount: storageAccount('token-b'),
        },
        {
          index: 0,
          status: 'error',
          error: 'boom',
          updatedAccount: storageAccount('token-a'),
        },
      ],
    })
    const commands = commandMap(fixtures.runtime)
    await execute(commands['antigravity-quota']!, 'refresh')

    const after = fixtures.storage()
    const tokenB = after.accounts.find((a) => a.refreshToken === 'token-b')
    const tokenA = after.accounts.find((a) => a.refreshToken === 'token-a')
    expect(tokenB?.cachedQuota?.gemini?.remainingFraction).toBe(0.66)
    expect(tokenB?.cachedQuota?.['non-gemini']).toBeUndefined()
    expect(tokenB?.cachedQuotaAccountId).toBe(quotaAccountIdentity('token-b'))
    expect(tokenB?.cachedQuotaUpdatedAt).toBe(FIXED_NOW)
    expect(tokenB?.cachedQuotaSuccessAt).toBe(FIXED_NOW)
    // Failed account keeps its previous quota-success pair and only bumps attempt time.
    expect(tokenA?.cachedQuota?.gemini?.remainingFraction).toBe(0.12)
    expect(tokenA?.cachedQuotaAccountId).toBe(quotaAccountIdentity('token-a'))
    expect(tokenA?.cachedQuotaSuccessAt).toBe(123)
    expect(tokenA?.cachedQuotaUpdatedAt).toBe(FIXED_NOW)
    expect(fixtures.outputs.at(-1)?.text).toContain('Refresh failures')
    expect(fixtures.quotaFetches()).toBe(1)
  })

  test('summary error retains the old groups while another account updates', async () => {
    const fixtures = createFixtures({
      storage: singleStorage([
        storageAccount('token-a', {
          cachedQuota: { gemini: { remainingFraction: 0.25, modelCount: 1 } },
          cachedQuotaAccountId: quotaAccountIdentity('token-a'),
          cachedQuotaUpdatedAt: 123,
          cachedQuotaSuccessAt: 111,
        }),
        storageAccount('token-b'),
      ]),
      snapshot: [storageAccount('token-a'), storageAccount('token-b')],
      results: [
        {
          index: 0,
          status: 'ok',
          quota: {
            groups: { gemini: { remainingFraction: 0.99, modelCount: 1 } },
            modelCount: 1,
            error: 'upstream unavailable',
          },
        },
        {
          index: 1,
          status: 'ok',
          quota: {
            groups: {
              'non-gemini': { remainingFraction: 0.75, modelCount: 1 },
            },
            modelCount: 1,
          },
        },
      ],
    })
    await execute(commandMap(fixtures.runtime)['antigravity-quota']!, 'refresh')
    const [a, b] = fixtures.storage().accounts
    expect(a?.cachedQuota?.gemini?.remainingFraction).toBe(0.25)
    expect(a?.cachedQuotaUpdatedAt).toBe(FIXED_NOW)
    expect(a?.cachedQuotaSuccessAt).toBe(111)
    expect(b?.cachedQuota?.['non-gemini']?.remainingFraction).toBe(0.75)
    expect(b?.cachedQuotaSuccessAt).toBe(FIXED_NOW)
    expect(fixtures.outputs.at(-1)?.text).toContain('Refresh failures')
  })

  test('cache view performs zero quota fetches', async () => {
    const fixtures = createFixtures({
      storage: singleStorage([storageAccount('token-a')]),
    })
    const commands = commandMap(fixtures.runtime)
    await execute(commands['antigravity-quota']!, '')
    expect(fixtures.quotaFetches()).toBe(0)
    expect(fixtures.outputs[0]?.text).toContain('cached')
  })
})

describe('antigravity-status', () => {
  test('renders pool overview text', async () => {
    const fixtures = createFixtures({
      storage: singleStorage([
        storageAccount('token-a'),
        storageAccount('token-b', { enabled: false }),
      ]),
    })
    const commands = commandMap(fixtures.runtime)
    await execute(commands['antigravity-status']!, '')
    const text = fixtures.outputs[0]?.text ?? ''
    expect(text).toContain('2 account(s), 1 enabled')
    expect(text).toContain('claude → Account 1')
    expect(text).toContain('never refreshed')
    expect(text).not.toContain('token-a')
  })
})

describe('review fixes: storage races and refresh UX', () => {
  test('use reports not-in-pool when the token vanished from storage', async () => {
    const fixtures = createFixtures({
      storage: singleStorage([storageAccount('token-a')]),
    })
    fixtures.runtime.mutateStorage = async () => {}
    const commands = commandMap(fixtures.runtime)
    await execute(commands['antigravity-account']!, 'use 1')
    expect(fixtures.outputs.at(-1)?.text).toContain('not in the pool')
    expect(fixtures.outputs.at(-1)?.text).not.toContain('Current account set')
  })

  test('disable reports not-in-pool when the token vanished from storage', async () => {
    const fixtures = createFixtures({
      storage: singleStorage([storageAccount('token-a')]),
    })
    fixtures.runtime.mutateStorage = async () => {}
    const commands = commandMap(fixtures.runtime)
    await execute(commands['antigravity-account']!, 'disable 1')
    expect(fixtures.outputs.at(-1)?.text).toContain('not in the pool')
    expect(fixtures.outputs.at(-1)?.text).not.toContain('Disabled Account')
  })

  test('enable reports not-in-pool when the token vanished from storage', async () => {
    const fixtures = createFixtures({
      storage: singleStorage([storageAccount('token-a', { enabled: false })]),
    })
    fixtures.runtime.mutateStorage = async () => {}
    const commands = commandMap(fixtures.runtime)
    await execute(commands['antigravity-account']!, 'enable 1')
    expect(fixtures.outputs.at(-1)?.text).toContain('not in the pool')
    expect(fixtures.outputs.at(-1)?.text).not.toContain('Enabled Account')
  })

  test('account mutations flush the live pool before the locked write', async () => {
    const fixtures = createFixtures({
      storage: singleStorage([
        storageAccount('token-a'),
        storageAccount('token-b'),
      ]),
    })
    const commands = commandMap(fixtures.runtime)
    await execute(commands['antigravity-account']!, 'use 2')
    const order = fixtures.order()
    expect(order.indexOf('flush')).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('flush')).toBeLessThan(order.indexOf('mutate'))
    expect(order.indexOf('mutate')).toBeLessThan(order.indexOf('reload'))
  })

  test('quota refresh flushes before the write-back', async () => {
    const fixtures = createFixtures({
      storage: singleStorage([storageAccount('token-a')]),
      snapshot: [storageAccount('token-a')],
      results: [],
    })
    const commands = commandMap(fixtures.runtime)
    await execute(commands['antigravity-quota']!, 'refresh')
    const order = fixtures.order()
    expect(order.indexOf('flush')).toBeLessThan(order.indexOf('mutate'))
    expect(order.indexOf('mutate')).toBeLessThan(order.indexOf('reload'))
  })

  test('failure labels reflect post-refresh numbering', async () => {
    const fixtures = createFixtures({
      storage: singleStorage([storageAccount('token-a')]),
      snapshot: [storageAccount('token-a')],
      results: [
        {
          index: 0,
          status: 'error',
          error: 'boom',
          updatedAccount: storageAccount('token-a'),
        },
      ],
      // A concurrent add lands during the network fetch and shifts token-a
      // from Account 1 to Account 2 before the write-back reload.
      mutateOnFetch: (storage) => ({
        ...storage,
        accounts: [storageAccount('token-new'), ...storage.accounts],
      }),
    })
    const commands = commandMap(fixtures.runtime)
    await execute(commands['antigravity-quota']!, 'refresh')
    const text = fixtures.outputs.at(-1)?.text ?? ''
    expect(text).toContain('- Account 2: refresh failed')
    expect(text).not.toContain('boom')
    expect(text).not.toContain('- Account 1: boom')
  })

  test('refresh on an empty pool reports it without fetching or writing', async () => {
    const fixtures = createFixtures({ storage: singleStorage([]) })
    const commands = commandMap(fixtures.runtime)
    await execute(commands['antigravity-quota']!, 'refresh')
    expect(fixtures.outputs.at(-1)?.text).toContain('pool is empty')
    expect(fixtures.quotaFetches()).toBe(0)
    expect(fixtures.mutates()).toBe(0)
  })
})
