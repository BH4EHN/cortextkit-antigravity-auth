import {
  type AccountManagerOptions,
  AccountManager as CoreAccountManager,
} from '@cortexkit/antigravity-auth-core'

import { debugLogToFile } from './debug'
import {
  createAccountStorageStore,
  getStoragePath,
  loadAccounts,
} from './storage'
import type { OAuthAuthDetails } from './types'

export type {
  AccountModelFamily as ModelFamily,
  AccountSessionIdentity,
  CooldownReason,
  HeaderStyle,
  ManagedAccount,
  RateLimitReason,
} from '@cortexkit/antigravity-auth-core'
export {
  calculateBackoffMs,
  computeSoftQuotaCacheTtlMs,
  parseRateLimitReason,
  resolveQuotaGroup,
} from '@cortexkit/antigravity-auth-core'

const openCodeStore: AccountManagerOptions['store'] =
  createAccountStorageStore()

export class AccountManager extends CoreAccountManager {
  constructor(
    authFallback?: OAuthAuthDetails,
    stored?: Awaited<ReturnType<typeof loadAccounts>>,
    options: Partial<AccountManagerOptions> = {},
  ) {
    super(authFallback, stored, {
      store: options.store ?? openCodeStore,
      storagePath: options.storagePath ?? getStoragePath(),
      now: options.now,
      random: options.random,
      pid: options.pid ?? process.pid,
      onDiagnostic:
        options.onDiagnostic ??
        ((message, fields) =>
          debugLogToFile(
            fields ? `${message} ${JSON.stringify(fields)}` : message,
          )),
    })
  }

  static async loadFromDisk(
    authFallback?: OAuthAuthDetails,
  ): Promise<AccountManager> {
    return new AccountManager(authFallback, await loadAccounts())
  }
}
