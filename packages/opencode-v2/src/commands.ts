// Slash-command surface for the OpenCode 2 adapter.
//
// OpenCode 2 runs commands over a TUI-owned RPC channel. The privacy firewall is inherited
// from the v1 command dialogs: rows carry the ordinal `Account N` label and
// NEVER the email, and a cached quota whose `cachedQuotaAccountId` stamp no
// longer matches the account's refresh token is dropped instead of rendered.
//
// All pool mutations go through the lock-held storage mutator keyed by
// refresh token (concurrent OAuth can renumber the flat array at any time),
// then `reloadPool({ flushCurrent: false })` so the live view matches disk
// without flushing a stale in-memory snapshot over the mutation we just made.

import { createHash } from 'node:crypto'

import type {
  AccountMetadataV3,
  AccountQuotaResult,
  AccountStorageV4,
  ManagedAccount,
  QuotaGroup,
  QuotaGroupSummary,
} from '@cortexkit/antigravity-auth-core'
import type { CommandDefinition } from '@opencode-ai/plugin/promise/command'

/**
 * Structural view of the core AccountManager that the commands need. Kept
 * nominal-light so unit tests can feed plain object literals instead of a
 * constructed manager.
 */
export interface AccountManagerView {
  getAccounts(): ManagedAccount[]
  getActiveIndexByFamily(): { claude: number; gemini: number }
  getOldestQuotaCacheAge(): number | null
}

export interface ProjectedQuotaCell {
  percent: number | null
  resetAt?: number
  windows?: Array<{
    window: '5h' | 'weekly'
    percent: number | null
    resetAt?: number
  }>
}

export interface ProjectedAccountRow {
  index: number
  label: string
  token: string
  state: 'active' | 'disabled' | 'ineligible' | 'verification-required'
  /** `*` both families, `c` claude only, `g` gemini only, ' ' not current. */
  current: '*' | 'c' | 'g' | ' '
  gemini: ProjectedQuotaCell
  nonGemini: ProjectedQuotaCell
  updatedAt?: number
  successAt?: number
}

export interface PanelQuotaCell {
  remainingPercent: number | null
  resetAt?: number
  windows: Array<{
    name: '5h' | 'weekly'
    remainingPercent: number | null
    resetAt?: number
  }>
}

export interface PanelAccountRow {
  label: string
  state: ProjectedAccountRow['state']
  current: 'both' | 'claude' | 'gemini' | 'none'
  gemini: PanelQuotaCell
  nonGemini: PanelQuotaCell
  cacheUpdatedAt?: number
  cacheSuccessAt?: number
}

export type AntigravityPanelSnapshot =
  | { kind: 'account'; accounts: PanelAccountRow[] }
  | { kind: 'quota'; accounts: PanelAccountRow[] }
  | {
      kind: 'status'
      pool: {
        total: number
        enabled: number
        disabled: number
        ineligible: number
        verificationRequired: number
      }
      current: { claude: string; gemini: string }
      quotaCache: { oldestAgeMs: number | null }
      paths: { accountsFile: string; logFile: string }
    }

export interface PoolQuotaFetchOutcome {
  /** The snapshot handed to the quota manager; results index into it. */
  snapshot: AccountMetadataV3[]
  results: AccountQuotaResult[]
}

export interface AntigravityCommandRuntime {
  getManager(): AccountManagerView
  /** Resolve a captured refresh-token identity after a pool transition. */
  resolveToken?(token: string): string
  reloadPool(options?: { flushCurrent?: boolean }): Promise<void>
  /**
   * Drain the live manager's debounced save BEFORE a lock-held storage
   * mutation, mirroring the OAuth add flow: `reloadPool` disposes the old
   * manager after loading, and a dispose with a pending save would write
   * the stale in-memory array back over the mutation.
   */
  flushPool(): Promise<void>
  mutateStorage(
    mutator: (current: AccountStorageV4) => AccountStorageV4,
  ): Promise<void>
  fetchPoolQuota(): Promise<PoolQuotaFetchOutcome>
  /**
   * Runs the full Antigravity OAuth login. `announce` lets the command
   * surface the authorization URL before the flow starts waiting for the browser callback.
   */
  oauthAdd(announce: (message: string) => Promise<void>): Promise<void>
  emit(sessionID: string, text: string): Promise<void>
  /** Optional TUI-only structured output. Slash commands keep their text format. */
  emitPanel?(
    sessionID: string,
    snapshot: AntigravityPanelSnapshot,
    notice: string | undefined,
    fallbackText: string,
  ): Promise<void>
  log(message: string, detail?: unknown): void
  requiresRestart?(): boolean
  now(): number
  readonly accountsFile: string
  readonly logFile: string
}

export const ACCOUNT_USAGE = `Usage:
  /antigravity-account                     Show the account pool
  /antigravity-account use <n>             Pin Account n as current
  /antigravity-account enable <n>          Enable Account n
  /antigravity-account disable <n>         Disable Account n
  /antigravity-account remove <n> confirm  Remove Account n (two-step)
  /antigravity-account add                 Add an account via OAuth`

export const QUOTA_USAGE = 'Usage: /antigravity-quota [refresh]'

class MissingAccountError extends Error {}

export class PoolMutationUnconfirmedError extends Error {
  constructor() {
    super('Account pool mutation could not be confirmed')
    this.name = 'PoolMutationUnconfirmedError'
  }
}

export type AccountAction =
  | { kind: 'list' }
  | { kind: 'use'; n: number }
  | { kind: 'enable'; n: number }
  | { kind: 'disable'; n: number }
  | { kind: 'remove'; n: number; confirmed: boolean }
  | { kind: 'add' }
  | { kind: 'usage'; error?: string }

export type QuotaAction =
  | { kind: 'cache' }
  | { kind: 'refresh' }
  | { kind: 'usage'; error: string }

function tokenize(text: string): string[] {
  const tokens = (text ?? '').trim().split(/\s+/).filter(Boolean)
  // Depending on host version the invoked command name may or may not be
  // included in `prompt.text`; strip a leading slash-token defensively so
  // both shapes parse identically.
  if (tokens[0]?.startsWith('/')) tokens.shift()
  return tokens
}

function parseOrdinal(token: string | undefined): number | null {
  if (!token || !/^\d+$/.test(token)) return null
  const value = Number.parseInt(token, 10)
  return value >= 1 ? value : null
}

export function parseAccountArgs(text: string): AccountAction {
  const tokens = tokenize(text)
  if (tokens.length === 0) return { kind: 'list' }
  const [sub, arg, extra, overflow] = tokens
  switch (sub) {
    case 'list':
      if (arg !== undefined)
        return { kind: 'usage', error: `Unexpected argument "${arg}"` }
      return { kind: 'list' }
    case 'add':
      if (arg !== undefined)
        return { kind: 'usage', error: `Unexpected argument "${arg}"` }
      return { kind: 'add' }
    case 'use':
    case 'enable':
    case 'disable': {
      const n = parseOrdinal(arg)
      if (n === null) {
        return {
          kind: 'usage',
          error: `"${sub}" needs an account number (see /antigravity-account list)`,
        }
      }
      if (extra !== undefined) {
        return { kind: 'usage', error: `Unexpected argument "${extra}"` }
      }
      return { kind: sub, n }
    }
    case 'remove': {
      const n = parseOrdinal(arg)
      if (n === null) {
        return {
          kind: 'usage',
          error: '"remove" needs an account number and a confirmation word',
        }
      }
      if (extra === undefined) return { kind: 'remove', n, confirmed: false }
      if (extra === 'confirm') {
        if (overflow !== undefined)
          return { kind: 'usage', error: `Unexpected argument "${overflow}"` }
        return { kind: 'remove', n, confirmed: true }
      }
      return {
        kind: 'usage',
        error: `Unexpected argument "${extra}"; confirm with: /antigravity-account remove ${n} confirm`,
      }
    }
    default:
      return { kind: 'usage', error: `Unknown subcommand "${sub}"` }
  }
}

export function parseQuotaArgs(text: string): QuotaAction {
  const tokens = tokenize(text)
  if (tokens.length === 0) return { kind: 'cache' }
  if (tokens.length === 1 && tokens[0] === 'refresh') return { kind: 'refresh' }
  return {
    kind: 'usage',
    error: `Unexpected argument "${tokens[0]}"`,
  }
}

/**
 * Opaque identity for a refresh token — the same sha256-prefix convention
 * the core AccountManager stamps onto `cachedQuotaAccountId` and the v1
 * command dialogs verify before rendering a cached percentage.
 */
export function quotaAccountIdentity(refreshToken: string): string {
  return createHash('sha256').update(refreshToken).digest('hex').slice(0, 16)
}

function accountState(account: ManagedAccount): ProjectedAccountRow['state'] {
  if (account.accountIneligible) return 'ineligible'
  if (account.verificationRequired) return 'verification-required'
  if (account.enabled === false) return 'disabled'
  return 'active'
}

function toPercent(fraction: number | undefined): number | null {
  return typeof fraction === 'number' && Number.isFinite(fraction)
    ? Math.round(fraction * 100)
    : null
}

function parseReset(resetTime: string | undefined): number | undefined {
  if (typeof resetTime !== 'string' || resetTime.length === 0) return undefined
  const parsed = Date.parse(resetTime)
  return Number.isFinite(parsed) ? parsed : undefined
}

function cellFromGroup(
  group: QuotaGroupSummary | undefined,
): ProjectedQuotaCell {
  if (!group) return { percent: null }
  return {
    percent: toPercent(group.remainingFraction),
    resetAt: parseReset(group.resetTime),
    windows: group.windows?.length
      ? group.windows.map((entry) => ({
          window: entry.window,
          percent: toPercent(entry.remainingFraction),
          resetAt: parseReset(entry.resetTime),
        }))
      : undefined,
  }
}

export function projectRows(
  accounts: ManagedAccount[],
  activeByFamily: { claude: number; gemini: number },
): ProjectedAccountRow[] {
  return accounts.map((account, index) => {
    const token = account.parts.refreshToken
    const stampValid =
      !account.cachedQuotaAccountId ||
      account.cachedQuotaAccountId === quotaAccountIdentity(token)
    const successStampValid =
      account.cachedQuotaAccountId === quotaAccountIdentity(token)
    const hasCachedQuota = account.cachedQuota !== undefined
    const cached =
      stampValid && hasCachedQuota ? account.cachedQuota : undefined
    const isClaude = activeByFamily.claude === index
    const isGemini = activeByFamily.gemini === index
    return {
      index,
      label: `Account ${index + 1}`,
      token,
      state: accountState(account),
      current:
        isClaude && isGemini ? '*' : isClaude ? 'c' : isGemini ? 'g' : ' ',
      gemini: cellFromGroup(cached?.gemini),
      nonGemini: cellFromGroup(cached?.['non-gemini']),
      updatedAt: stampValid ? account.cachedQuotaUpdatedAt : undefined,
      successAt:
        successStampValid && hasCachedQuota
          ? account.cachedQuotaSuccessAt
          : undefined,
    }
  })
}

function panelCell(cell: ProjectedQuotaCell): PanelQuotaCell {
  const windows = (cell.windows ?? []).map((window) => ({
    name: window.window,
    remainingPercent: window.percent,
    ...(window.resetAt !== undefined ? { resetAt: window.resetAt } : {}),
  }))
  return {
    remainingPercent: cell.percent,
    ...(cell.resetAt !== undefined ? { resetAt: cell.resetAt } : {}),
    windows,
  }
}

export function projectPanelAccounts(
  rows: ProjectedAccountRow[],
): PanelAccountRow[] {
  return rows.map((row) => ({
    label: row.label,
    state: row.state,
    current:
      row.current === '*'
        ? 'both'
        : row.current === 'c'
          ? 'claude'
          : row.current === 'g'
            ? 'gemini'
            : 'none',
    gemini: panelCell(row.gemini),
    nonGemini: panelCell(row.nonGemini),
    ...(row.updatedAt !== undefined ? { cacheUpdatedAt: row.updatedAt } : {}),
    ...(row.successAt !== undefined ? { cacheSuccessAt: row.successAt } : {}),
  }))
}

function formatDuration(ms: number): string {
  if (ms < 0) ms = 0
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours < 48) return rest > 0 ? `${hours}h${rest}m` : `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

function earliestReset(cell: ProjectedQuotaCell): number | undefined {
  const candidates = [
    cell.resetAt,
    ...(cell.windows?.map((entry) => entry.resetAt) ?? []),
  ].filter((value): value is number => value !== undefined)
  return candidates.length > 0 ? Math.min(...candidates) : undefined
}

function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => row[column]?.length ?? 0)),
  )
  const formatRow = (row: string[]) =>
    row
      .map((value, column) =>
        column === row.length - 1
          ? value
          : value.padEnd((widths[column] ?? value.length) + 2),
      )
      .join('')
  return [formatRow(headers), ...rows.map(formatRow)].join('\n')
}

function percentCell(cell: ProjectedQuotaCell): string {
  return cell.percent === null ? '-' : `${cell.percent}%`
}

export function formatRowsTable(
  rows: ProjectedAccountRow[],
  now: number,
): string {
  const tableRows = rows.map((row) => {
    const resets = [
      earliestReset(row.gemini),
      earliestReset(row.nonGemini),
    ].filter((value): value is number => value !== undefined)
    const reset = resets.length > 0 ? Math.min(...resets) : undefined
    return [
      row.current,
      row.label,
      row.state,
      percentCell(row.gemini),
      percentCell(row.nonGemini),
      reset === undefined ? '-' : formatDuration(reset - now),
      row.updatedAt === undefined
        ? 'never'
        : `${formatDuration(now - row.updatedAt)} ago`,
    ]
  })
  const lines = [
    formatTable(
      ['', 'ACCOUNT', 'STATE', 'GEMINI', 'NON-GEMINI', 'RESET', 'UPDATED'],
      tableRows,
    ),
  ]
  const windowLines = rows
    .filter(
      (row) => row.gemini.windows?.length || row.nonGemini.windows?.length,
    )
    .map((row) => {
      const parts: string[] = []
      const describe = (
        name: string,
        cell: ProjectedQuotaCell,
      ): string | null => {
        if (!cell.windows?.length) return null
        const windows = cell.windows
          .map(
            (entry) =>
              `${entry.window} ${entry.percent === null ? '-' : `${entry.percent}%`}${
                entry.resetAt === undefined
                  ? ''
                  : ` (resets ${formatDuration(entry.resetAt - now)})`
              }`,
          )
          .join(', ')
        return `${name}: ${windows}`
      }
      const gemini = describe('Gemini', row.gemini)
      const nonGemini = describe('Non-Gemini', row.nonGemini)
      if (gemini) parts.push(gemini)
      if (nonGemini) parts.push(nonGemini)
      return `  ${row.label} · ${parts.join(' · ')}`
    })
  if (windowLines.length > 0) lines.push(windowLines.join('\n'))
  return lines.join('\n')
}

export function formatStatusText(input: {
  accountsFile: string
  logFile: string
  total: number
  enabled: number
  currentClaude: string
  currentGemini: string
  /** Age (ms) of the oldest quota cache across enabled accounts, or null. */
  oldestCacheAgeMs: number | null
}): string {
  return [
    'Antigravity adapter (OpenCode 2)',
    `  Pool: ${input.total} account(s), ${input.enabled} enabled`,
    `  Current: claude → ${input.currentClaude}, gemini → ${input.currentGemini}`,
    `  Quota cache: ${
      input.oldestCacheAgeMs === null
        ? 'never refreshed'
        : `oldest refreshed ${formatDuration(input.oldestCacheAgeMs)} ago`
    }`,
    `  Accounts file: ${input.accountsFile}`,
    `  Log file: ${input.logFile}`,
  ].join('\n')
}

export function createAntigravityCommands(
  rt: AntigravityCommandRuntime,
): CommandDefinition[] {
  let addInFlight: Promise<void> | null = null

  const rows = (): ProjectedAccountRow[] => {
    const manager = rt.getManager()
    return projectRows(manager.getAccounts(), manager.getActiveIndexByFamily())
  }

  const guard = async (
    sessionID: string,
    run: () => Promise<void>,
  ): Promise<void> => {
    try {
      await run()
    } catch (error) {
      rt.log('command-error')
      await rt.emit(
        sessionID,
        rt.requiresRestart?.()
          ? 'Antigravity command result could not be confirmed. Restart OpenCode and inspect the account pool before retrying.'
          : error instanceof MissingAccountError
            ? `Antigravity command failed: ${error.message}`
            : error instanceof PoolMutationUnconfirmedError
              ? 'Antigravity command result could not be confirmed. Inspect the current account pool before retrying; account numbers may have changed.'
              : 'Antigravity command failed. Check the adapter log and retry.',
      )
    }
  }

  const emitUsage = async (sessionID: string, error?: string): Promise<void> =>
    rt.emit(sessionID, error ? `${error}\n\n${ACCOUNT_USAGE}` : ACCOUNT_USAGE)

  const requireAccount = (n: number): ManagedAccount => {
    const account = rt.getManager().getAccounts()[n - 1]
    if (!account?.parts.refreshToken) {
      throw new MissingAccountError(
        `Account ${n} does not exist — run /antigravity-account list first.`,
      )
    }
    return account
  }

  const emitPool = async (sessionID: string, title: string): Promise<void> => {
    const projected = rows()
    if (projected.length === 0) {
      const notice = `${title}\n\nThe Antigravity pool is empty. Add an account with /antigravity-account add`
      if (rt.emitPanel) {
        await rt.emitPanel(
          sessionID,
          { kind: 'account', accounts: [] },
          notice,
          notice,
        )
      } else {
        await rt.emit(sessionID, notice)
      }
      return
    }
    const fallbackText = `${title}\n\n${formatStatusLegend()}\n\`\`\`\n${formatRowsTable(projected, rt.now())}\n\`\`\``
    if (rt.emitPanel) {
      await rt.emitPanel(
        sessionID,
        { kind: 'account', accounts: projectPanelAccounts(projected) },
        title.endsWith(':') ? undefined : title,
        fallbackText,
      )
    } else {
      await rt.emit(sessionID, fallbackText)
    }
  }

  const emitNotInPool = async (sessionID: string, n: number): Promise<void> =>
    rt.emit(
      sessionID,
      `Account ${n} is not in the pool — it may already have been removed.`,
    )

  async function handleAccount(sessionID: string, text: string): Promise<void> {
    const action = parseAccountArgs(text)
    switch (action.kind) {
      case 'usage':
        await emitUsage(sessionID, action.error)
        return
      case 'list':
        await emitPool(sessionID, 'Antigravity account pool:')
        return
      case 'use': {
        const token = requireAccount(action.n).parts.refreshToken
        let foundInStorage = false
        await rt.flushPool()
        const targetToken = rt.resolveToken?.(token) ?? token
        await rt.mutateStorage((current) => {
          const idx = current.accounts.findIndex(
            (account) => account.refreshToken === targetToken,
          )
          if (idx === -1) return current
          foundInStorage = true
          return {
            ...current,
            activeIndex: idx,
            activeIndexByFamily: { claude: idx, gemini: idx },
          }
        })
        if (!foundInStorage) {
          await rt.reloadPool({ flushCurrent: false })
          await emitNotInPool(sessionID, action.n)
          return
        }
        await rt.reloadPool({ flushCurrent: false })
        await emitPool(sessionID, `Current account set to Account ${action.n}.`)
        return
      }
      case 'enable':
      case 'disable': {
        const target = requireAccount(action.n)
        const desired = action.kind === 'enable'
        const token = target.parts.refreshToken
        let foundInStorage = false
        let blockedInStorage = false
        let alreadyDesired = false
        let verificationRequired = false
        await rt.flushPool()
        const targetToken = rt.resolveToken?.(token) ?? token
        await rt.mutateStorage((current) => {
          const idx = current.accounts.findIndex(
            (account) => account.refreshToken === targetToken,
          )
          if (idx === -1) return current
          foundInStorage = true
          const stored = current.accounts[idx]
          if (desired && stored?.accountIneligible) {
            blockedInStorage = true
            return current
          }
          verificationRequired =
            desired && stored?.verificationRequired === true
          if ((stored?.enabled !== false) === desired) {
            alreadyDesired = true
            return current
          }
          return {
            ...current,
            accounts: current.accounts.map((account) =>
              account.refreshToken === targetToken
                ? { ...account, enabled: desired }
                : account,
            ),
          }
        })
        if (!foundInStorage) {
          await rt.reloadPool({ flushCurrent: false })
          await emitNotInPool(sessionID, action.n)
          return
        }
        if (blockedInStorage) {
          await rt.reloadPool({ flushCurrent: false })
          await rt.emit(
            sessionID,
            `Account ${action.n} is ineligible and cannot be enabled until eligibility is rechecked.`,
          )
          return
        }
        await rt.reloadPool({ flushCurrent: false })
        if (alreadyDesired) {
          await rt.emit(
            sessionID,
            `Account ${action.n} is already ${desired ? 'enabled' : 'disabled'}.${verificationRequired ? ' Verification is still required; OpenCode 2 will not select it.' : ''}`,
          )
          return
        }
        await emitPool(
          sessionID,
          desired
            ? `Enabled Account ${action.n}.${verificationRequired ? ' Verification is still required; OpenCode 2 will not select it.' : ''}`
            : `Disabled Account ${action.n} — restore with /antigravity-account enable ${action.n}`,
        )
        return
      }
      case 'remove': {
        const target = requireAccount(action.n)
        const token = target.parts.refreshToken
        if (!action.confirmed) {
          await rt.emit(
            sessionID,
            `Will remove Account ${action.n} (state: ${accountState(target)}). This is not reversible.\n\nConfirm with:\n/antigravity-account remove ${action.n} confirm`,
          )
          return
        }
        // Capture the live current-account token per family BEFORE the
        // removal so the persisted cursors follow the same accounts into
        // their new slots (collapsing both families to one index would
        // unelect one family on restart).
        const liveAccounts = rt.getManager().getAccounts()
        const liveIndexes = rt.getManager().getActiveIndexByFamily()
        const liveCurrentTokens: { claude?: string; gemini?: string } = {
          claude: liveAccounts[liveIndexes.claude]?.parts.refreshToken,
          gemini: liveAccounts[liveIndexes.gemini]?.parts.refreshToken,
        }
        let foundInStorage = false
        await rt.flushPool()
        const targetToken = rt.resolveToken?.(token) ?? token
        const currentTokens = {
          claude: liveCurrentTokens.claude
            ? (rt.resolveToken?.(liveCurrentTokens.claude) ??
              liveCurrentTokens.claude)
            : undefined,
          gemini: liveCurrentTokens.gemini
            ? (rt.resolveToken?.(liveCurrentTokens.gemini) ??
              liveCurrentTokens.gemini)
            : undefined,
        }
        await rt.mutateStorage((current) => {
          const tokenIdx = current.accounts.findIndex(
            (account) => account.refreshToken === targetToken,
          )
          if (tokenIdx === -1) return current
          foundInStorage = true
          const nextAccounts = current.accounts.filter(
            (account) => account.refreshToken !== targetToken,
          )
          const resolveNextIndex = (
            liveToken: string | undefined,
            legacyIndex: number,
          ): number => {
            if (!liveToken) {
              return Math.max(0, Math.min(legacyIndex, nextAccounts.length - 1))
            }
            const at = nextAccounts.findIndex(
              (account) => account.refreshToken === liveToken,
            )
            if (at !== -1) return at
            // The captured current was the removed account: mirror the
            // core's in-memory semantics and keep the cursor at the same
            // numeric slot when it still exists, else fall back to 0.
            return tokenIdx < nextAccounts.length ? tokenIdx : 0
          }
          const legacyClaude =
            current.activeIndexByFamily?.claude ?? current.activeIndex
          const legacyGemini =
            current.activeIndexByFamily?.gemini ?? current.activeIndex
          const claude = resolveNextIndex(currentTokens.claude, legacyClaude)
          return {
            ...current,
            accounts: nextAccounts,
            activeIndex: claude,
            activeIndexByFamily: {
              claude,
              gemini: resolveNextIndex(currentTokens.gemini, legacyGemini),
            },
          }
        })
        if (!foundInStorage) {
          await rt.reloadPool({ flushCurrent: false })
          await emitNotInPool(sessionID, action.n)
          return
        }
        await rt.reloadPool({ flushCurrent: false })
        await emitPool(
          sessionID,
          `Removed Account ${action.n}; indices have shifted.`,
        )
        return
      }
      case 'add': {
        if (addInFlight) {
          await rt.emit(
            sessionID,
            'An Antigravity OAuth login is already in progress — complete it, then run /antigravity-account list.',
          )
          return
        }
        const announce = (message: string): Promise<void> =>
          rt.emit(sessionID, message)
        const pending = rt.oauthAdd(announce).finally(() => {
          addInFlight = null
        })
        addInFlight = pending
        await pending
        await emitPool(sessionID, 'Account added to the Antigravity pool.')
        return
      }
    }
  }

  async function handleQuota(sessionID: string, text: string): Promise<void> {
    const action = parseQuotaArgs(text)
    if (action.kind === 'usage') {
      await rt.emit(sessionID, `${action.error}\n\n${QUOTA_USAGE}`)
      return
    }
    const projected = rows()
    if (projected.length === 0) {
      if (rt.emitPanel) {
        await rt.emitPanel(
          sessionID,
          { kind: 'quota', accounts: [] },
          'The Antigravity pool is empty.',
          'The Antigravity pool is empty.',
        )
      } else {
        await rt.emit(sessionID, 'The Antigravity pool is empty.')
      }
      return
    }
    if (action.kind === 'cache') {
      const fallbackText = `Quota (cached — run "/antigravity-quota refresh" for live numbers):\n\n\`\`\`\n${formatRowsTable(projected, rt.now())}\n\`\`\``
      if (rt.emitPanel) {
        await rt.emitPanel(
          sessionID,
          { kind: 'quota', accounts: projectPanelAccounts(projected) },
          undefined,
          fallbackText,
        )
      } else {
        await rt.emit(sessionID, fallbackText)
      }
      return
    }

    await rt.emit(
      sessionID,
      'Refreshing Antigravity quota for all enabled accounts…',
    )
    const { snapshot, results } = await rt.fetchPoolQuota()
    const refreshedAt = rt.now()

    // Use result.index only against the quota request's snapshot. The live
    // pool may have changed order, and updatedAccount may carry a rotated
    // token that is not yet the persisted account identity.
    interface QuotaUpdate {
      token: string
      outcome: 'success' | 'failure' | 'skipped'
      groups?: Partial<Record<QuotaGroup, QuotaGroupSummary>>
    }
    const updates: QuotaUpdate[] = []
    for (const result of results) {
      const token = snapshot[result.index]?.refreshToken
      if (!token) continue
      const skipped = result.status === 'disabled'
      const success =
        result.status === 'ok' &&
        result.quota !== undefined &&
        result.quota.error === undefined
      updates.push({
        token,
        outcome: skipped ? 'skipped' : success ? 'success' : 'failure',
        groups: success ? result.quota?.groups : undefined,
      })
    }

    await rt.flushPool()
    const byToken = new Map(
      updates.map((update) => [
        rt.resolveToken?.(update.token) ?? update.token,
        update,
      ]),
    )
    await rt.mutateStorage((current) => ({
      ...current,
      accounts: current.accounts.map((entry) => {
        const update = byToken.get(entry.refreshToken)
        if (!update || update.outcome === 'skipped') return entry
        if (update.outcome === 'success') {
          return {
            ...entry,
            cachedQuota: update.groups ?? {},
            cachedQuotaAccountId: quotaAccountIdentity(entry.refreshToken),
            cachedQuotaUpdatedAt: refreshedAt,
            cachedQuotaSuccessAt: refreshedAt,
          }
        }
        // Error keeps the previous cached percentages and only records
        // that a refresh was attempted.
        return { ...entry, cachedQuotaUpdatedAt: refreshedAt }
      }),
    }))
    await rt.reloadPool({ flushCurrent: false })

    // Label failures from the POST-reload view so the numbering matches the
    // table below; tokens that vanished mid-refresh fall back to the
    // pre-refresh projection rather than showing "Unknown account".
    const refreshedRows = rows()
    const labelByToken = new Map(
      refreshedRows.map((row) => [row.token, row.label]),
    )
    for (const row of projected) {
      if (!labelByToken.has(row.token)) {
        labelByToken.set(row.token, row.label)
      }
    }
    const successes = updates.filter(
      (update) => update.outcome === 'success',
    ).length
    const failures = updates.filter((update) => update.outcome === 'failure')
    const skipped = updates.filter(
      (update) => update.outcome === 'skipped',
    ).length
    const summary = `Quota refresh complete: ${successes} successful, ${failures.length} failed, ${skipped} skipped.`
    const suffix = failures.length
      ? `\n\nRefresh failures:\n${failures
          .map(
            (failure) =>
              `- ${labelByToken.get(failure.token) ?? 'Unknown account'}: refresh failed`,
          )
          .join('\n')}`
      : ''
    const fallbackText = `${summary}\n\n\`\`\`\n${formatRowsTable(refreshedRows, rt.now())}\n\`\`\`${suffix}`
    if (rt.emitPanel) {
      await rt.emitPanel(
        sessionID,
        { kind: 'quota', accounts: projectPanelAccounts(refreshedRows) },
        summary,
        fallbackText,
      )
    } else {
      await rt.emit(sessionID, fallbackText)
    }
  }

  async function handleStatus(sessionID: string): Promise<void> {
    const manager = rt.getManager()
    const accounts = manager.getAccounts()
    const indexes = manager.getActiveIndexByFamily()
    const labelAt = (index: number): string =>
      accounts[index] ? `Account ${index + 1}` : 'none'
    const text = formatStatusText({
      accountsFile: rt.accountsFile,
      logFile: rt.logFile,
      total: accounts.length,
      enabled: accounts.filter((account) => account.enabled !== false).length,
      currentClaude: labelAt(indexes.claude),
      currentGemini: labelAt(indexes.gemini),
      oldestCacheAgeMs: manager.getOldestQuotaCacheAge(),
    })
    const status: AntigravityPanelSnapshot = {
      kind: 'status',
      pool: {
        total: accounts.length,
        enabled: accounts.filter((account) => account.enabled !== false).length,
        disabled: accounts.filter((account) => account.enabled === false)
          .length,
        ineligible: accounts.filter((account) => account.accountIneligible)
          .length,
        verificationRequired: accounts.filter(
          (account) => account.verificationRequired,
        ).length,
      },
      current: {
        claude: labelAt(indexes.claude),
        gemini: labelAt(indexes.gemini),
      },
      quotaCache: { oldestAgeMs: manager.getOldestQuotaCacheAge() },
      paths: { accountsFile: rt.accountsFile, logFile: rt.logFile },
    }
    if (rt.emitPanel) {
      await rt.emitPanel(sessionID, status, undefined, text)
    } else {
      await rt.emit(sessionID, text)
    }
  }

  return [
    {
      name: 'antigravity-account',
      description: 'Manage the Antigravity account pool',
      execute: async (input) => {
        await guard(String(input.sessionID), () =>
          handleAccount(String(input.sessionID), input.prompt.text),
        )
      },
    },
    {
      name: 'antigravity-quota',
      description: 'View or refresh Antigravity quota',
      execute: async (input) => {
        await guard(String(input.sessionID), () =>
          handleQuota(String(input.sessionID), input.prompt.text),
        )
      },
    },
    {
      name: 'antigravity-status',
      description: 'Show the Antigravity pool status',
      execute: async (input) => {
        await guard(String(input.sessionID), () =>
          handleStatus(String(input.sessionID)),
        )
      },
    },
  ]
}

function formatStatusLegend(): string {
  return '* current (both families) · c = claude-only · g = gemini-only'
}
