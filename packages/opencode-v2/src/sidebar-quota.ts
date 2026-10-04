import type {
  AccountMetadataV3,
  AccountQuotaResult,
  FetchAccountQuota,
  ManagedAccount,
} from '@cortexkit/antigravity-auth-core'

import {
  type PanelAccountRow,
  type PanelQuotaCell,
  projectPanelAccounts,
  projectRows,
  quotaAccountIdentity,
} from './commands.ts'
import type { SidebarQuotaCell, SidebarQuotaSnapshot } from './rpc.ts'

const FRESH_MS = 5 * 60_000
const RETRY_MS = 60_000
const MAX_RETRY_MS = 10 * 60_000

type Group = 'gemini' | 'nonGemini'
type CellData = Pick<
  SidebarQuotaCell,
  'remainingPercent' | 'resetAt' | 'windows'
>
interface GroupState {
  cell: CellData
  source: 'cache' | 'live'
  updatedAt?: number
  unavailable?: boolean
}
interface Entry {
  groups: Record<Group, GroupState>
  successAt?: number
  failureCount: number
  retryAt: number
  error: boolean
}

export interface SidebarQuotaCoordinatorDeps {
  accounts(): ManagedAccount[]
  active(): { claude: number; gemini: number }
  logicalToken(token: string): string
  fetch: FetchAccountQuota
  now(): number
}

function cellFromQuotaGroup(
  group: NonNullable<AccountQuotaResult['quota']>['groups']['gemini'],
): CellData {
  if (!group) return { remainingPercent: null, windows: [] }
  const percent = (fraction: number | undefined): number | null =>
    typeof fraction === 'number' && Number.isFinite(fraction)
      ? Math.max(0, Math.min(100, Math.round(fraction * 100)))
      : null
  const resetAt = (value: string | undefined): number | undefined => {
    const timestamp = value ? Date.parse(value) : Number.NaN
    return Number.isFinite(timestamp) ? timestamp : undefined
  }
  const windows = (group.windows ?? []).map((window) => {
    const windowResetAt = resetAt(window.resetTime)
    return {
      name: window.window,
      remainingPercent: percent(window.remainingFraction),
      ...(windowResetAt !== undefined ? { resetAt: windowResetAt } : {}),
    }
  })
  const groupResetAt = resetAt(group.resetTime)
  return {
    remainingPercent: percent(group.remainingFraction),
    ...(groupResetAt !== undefined ? { resetAt: groupResetAt } : {}),
    windows,
  }
}

export class SidebarQuotaCoordinator {
  private readonly entries = new Map<string, Entry>()
  private readonly pending = new Map<string, Promise<AccountQuotaResult>>()
  private tail: Promise<void> = Promise.resolve()
  private disposed = false
  private readonly abort = new AbortController()

  constructor(private readonly deps: SidebarQuotaCoordinatorDeps) {}

  private key(token: string): string {
    return this.deps.logicalToken(token)
  }

  private current(token: string): ManagedAccount | undefined {
    const key = this.key(token)
    return this.deps
      .accounts()
      .find((account) => this.key(account.parts.refreshToken) === key)
  }

  private eligible(token: string): ManagedAccount | undefined {
    const account = this.current(token)
    return account?.enabled !== false &&
      !account?.accountIneligible &&
      !account?.verificationRequired
      ? account
      : undefined
  }

  private entry(
    token: string,
    row: PanelAccountRow,
    cacheValid: boolean,
  ): Entry {
    const key = this.key(token)
    let entry = this.entries.get(key)
    if (!entry) {
      const group = (cell: PanelQuotaCell): GroupState => ({
        cell: cacheValid ? cell : { remainingPercent: null, windows: [] },
        source: 'cache',
        updatedAt: cacheValid ? row.cacheSuccessAt : undefined,
      })
      entry = {
        groups: { gemini: group(row.gemini), nonGemini: group(row.nonGemini) },
        failureCount: 0,
        retryAt: 0,
        error: false,
      }
      this.entries.set(key, entry)
    }
    return entry
  }

  snapshot(mode: 'cache' | 'ensure'): SidebarQuotaSnapshot {
    const accounts = this.deps.accounts()
    const rows = projectPanelAccounts(projectRows(accounts, this.deps.active()))
    const visible = new Set<string>()
    const output = rows.map((row, index) => {
      const token = accounts[index]?.parts.refreshToken ?? ''
      const key = this.key(token)
      visible.add(key)
      const stamp = accounts[index]?.cachedQuotaAccountId
      const cacheValid = !stamp || stamp === quotaAccountIdentity(token)
      const entry = this.entry(token, row, cacheValid)
      const cell = (group: Group): SidebarQuotaCell => {
        const value = entry.groups[group]
        return {
          ...value.cell,
          source: value.source,
          ...(value.updatedAt !== undefined
            ? { updatedAt: value.updatedAt }
            : {}),
          refreshState: this.pending.has(key)
            ? 'refreshing'
            : entry.error
              ? 'error'
              : value.unavailable
                ? 'unavailable'
                : 'idle',
        }
      }
      return {
        ...row,
        ...(cacheValid && row.cacheUpdatedAt !== undefined
          ? { cacheUpdatedAt: row.cacheUpdatedAt }
          : {}),
        gemini: cell('gemini'),
        nonGemini: cell('nonGemini'),
      }
    })
    for (const key of this.entries.keys()) {
      if (!visible.has(key)) this.entries.delete(key)
    }
    if (mode === 'ensure' && !this.disposed) {
      for (const account of accounts) {
        const token = account.parts.refreshToken
        if (!this.eligible(token)) continue
        const entry = this.entries.get(this.key(token))
        if (
          entry &&
          (entry.successAt === undefined ||
            this.deps.now() - entry.successAt >= FRESH_MS) &&
          this.deps.now() >= entry.retryAt
        ) {
          void this.query(token, false)
        }
      }
    }
    return { accounts: output, notices: [] }
  }

  query(token: string, force: boolean): Promise<AccountQuotaResult> {
    const key = this.key(token)
    const existing = this.pending.get(key)
    if (existing) return existing
    const skipped: AccountQuotaResult = { index: 0, status: 'disabled' }
    if (this.disposed || !this.eligible(token)) return Promise.resolve(skipped)
    const run = this.tail.then(async (): Promise<AccountQuotaResult> => {
      const account = this.eligible(token)
      if (this.disposed || !account) return skipped
      const current = this.entries.get(key)
      if (
        !force &&
        current &&
        ((current.successAt !== undefined &&
          this.deps.now() - current.successAt < FRESH_MS) ||
          this.deps.now() < current.retryAt)
      )
        return skipped
      const metadata: AccountMetadataV3 = {
        ...account,
        refreshToken: account.parts.refreshToken,
        projectId: account.parts.projectId,
        managedProjectId: account.parts.managedProjectId,
      }
      const result = await this.deps.fetch(metadata, this.abort.signal)
      const live = this.eligible(token)
      if (
        this.disposed ||
        !live ||
        live.addedAt !== account.addedAt ||
        this.key(live.parts.refreshToken) !== key
      )
        return result
      const entry = this.entries.get(key)
      if (!entry) return result
      if (result.status === 'ok' && result.quota && !result.quota.error) {
        const at = this.deps.now()
        for (const [field, name] of [
          ['gemini', 'gemini'],
          ['nonGemini', 'non-gemini'],
        ] as const) {
          const group = result.quota.groups[name]
          entry.groups[field] = {
            cell: cellFromQuotaGroup(group),
            source: 'live',
            updatedAt: at,
            unavailable: !group,
          }
        }
        entry.successAt = at
        entry.failureCount = 0
        entry.retryAt = 0
        entry.error = false
      } else {
        entry.failureCount += 1
        entry.retryAt =
          this.deps.now() +
          Math.min(MAX_RETRY_MS, RETRY_MS * 2 ** (entry.failureCount - 1))
        entry.error = true
      }
      return result
    })
    const settled = run
      .catch((): AccountQuotaResult => {
        const entry = this.entries.get(key)
        if (entry && !this.disposed) {
          entry.failureCount += 1
          entry.retryAt =
            this.deps.now() +
            Math.min(MAX_RETRY_MS, RETRY_MS * 2 ** (entry.failureCount - 1))
          entry.error = true
        }
        return { index: 0, status: 'error' }
      })
      .finally(() => {
        if (this.pending.get(key) === settled) this.pending.delete(key)
      })
    this.pending.set(key, settled)
    this.tail = settled.then(() => {})
    return settled
  }

  async refreshAll(
    snapshot: AccountMetadataV3[],
  ): Promise<AccountQuotaResult[]> {
    return Promise.all(
      snapshot.map(async (account, index) => ({
        ...(await this.query(account.refreshToken, true)),
        index,
      })),
    )
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.abort.abort()
    await this.tail
    this.entries.clear()
  }
}
