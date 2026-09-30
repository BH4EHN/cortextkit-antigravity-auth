// OpenCode 2 quota-fetch pipeline.
//
// v1's `makeFetchAccountQuota` lives in the OpenCode 1 adapter and depends on
// host-specific token/project modules, so the v2 adapter composes the same
// flow from core primitives: token refresh → project context → the windowed
// summary fetch (with the legacy `fetchAvailableModels` fallback) running
// CONCURRENTLY with the Gemini CLI fetch. A CLI failure never kills the
// summary result, and a transient CLI error is annotated with its real
// message instead of the permanent-looking "No Gemini CLI quota available".
//
// The refresh-token keys of `updatedAccount` are what the command layer uses
// to fold results back into storage; see ../opencode/src/plugin/command-data.ts
// for the shared write-back contract.

import {
  type AccountMetadataV3,
  type AccountQuotaResult,
  ANTIGRAVITY_ENDPOINT_FALLBACKS,
  aggregateGeminiCliQuota,
  aggregateQuota,
  aggregateQuotaSummary,
  buildAntigravityHarnessUserAgent,
  buildGeminiCliUserAgent,
  createQuotaManager,
  defaultKeyOf,
  type ensureProjectContext,
  type FetchAccountQuota,
  fetchAvailableModels,
  fetchGeminiCliQuota,
  fetchQuotaSummary,
  formatRefreshParts,
  type GeminiCliQuotaSummary,
  type OAuthAuthDetails,
  parseRefreshParts,
  type QuotaSummary,
  type refreshAntigravityToken,
} from '@cortexkit/antigravity-auth-core'

export interface V2QuotaDependencies {
  ensureProjectContext: typeof ensureProjectContext
  refreshAntigravityToken: typeof refreshAntigravityToken
}

async function fetchLegacyModelsFallback(options: {
  accessToken: string
  projectId: string
}): Promise<QuotaSummary> {
  try {
    const modelsResponse = await fetchAvailableModels({
      accessToken: options.accessToken,
      projectId: options.projectId,
      endpoints: ANTIGRAVITY_ENDPOINT_FALLBACKS,
      userAgent: buildAntigravityHarnessUserAgent(),
      timeoutMs: 10_000,
    })
    if (modelsResponse.models) {
      return aggregateQuota(modelsResponse.models)
    }
    return {
      groups: {},
      modelCount: 0,
      error: 'Failed to fetch Antigravity quota (legacy fallback)',
    }
  } catch {
    return {
      groups: {},
      modelCount: 0,
      error: 'Failed to fetch Antigravity quota',
    }
  }
}

export function makeFetchAccountQuota(
  deps: V2QuotaDependencies,
): FetchAccountQuota {
  return async (account, signal) => {
    const index = 0
    if (account.enabled === false) {
      return {
        index,
        email: account.email,
        status: 'disabled',
        disabled: true,
      }
    }

    if (signal.aborted) {
      return {
        index,
        email: account.email,
        status: 'error',
        error:
          signal.reason instanceof Error ? signal.reason.message : 'aborted',
      }
    }

    try {
      // `getAccountsForQuotaCheck` never carries an access token, so this
      // path always refreshes first — matching the v1 standalone contract.
      const refreshed = await deps.refreshAntigravityToken(account.refreshToken)
      let auth: OAuthAuthDetails = {
        type: 'oauth',
        refresh: formatRefreshParts({
          refreshToken: refreshed.refresh || account.refreshToken,
          projectId: account.projectId,
          managedProjectId: account.managedProjectId,
        }),
        access: refreshed.access,
        expires: refreshed.expires,
      }

      const projectContext = await deps.ensureProjectContext(auth)
      auth = projectContext.auth

      const authParts = parseRefreshParts(auth.refresh)
      const managedProjectId =
        authParts.managedProjectId ?? account.managedProjectId

      // The CLI fetch is independent of the summary fetch: a CLI failure
      // must not kill the summary, and a transient CLI error must not be
      // laundered into the permanent-looking "No Gemini CLI quota available"
      // status — its real message is captured via the side channel below.
      let cliFetchError: string | undefined
      const [summaryPayload, cliResponse] = await Promise.all([
        fetchQuotaSummary({
          accessToken: auth.access ?? '',
          managedProjectId,
          projectId: projectContext.effectiveProjectId,
          endpoints: ANTIGRAVITY_ENDPOINT_FALLBACKS,
          userAgent: buildAntigravityHarnessUserAgent(),
          timeoutMs: 10_000,
        })
          .then((result) => ({
            quota: aggregateQuotaSummary(result.summary),
            fellBackToLegacy: result.fellBackToLegacy ?? false,
          }))
          .catch(async () => ({
            quota: await fetchLegacyModelsFallback({
              accessToken: auth.access ?? '',
              projectId: projectContext.effectiveProjectId,
            }),
            fellBackToLegacy: true,
          })),
        fetchGeminiCliQuota({
          accessToken: auth.access ?? '',
          projectId: projectContext.effectiveProjectId,
          endpoints: ANTIGRAVITY_ENDPOINT_FALLBACKS,
          userAgent: buildGeminiCliUserAgent(),
          timeoutMs: 10_000,
        }).catch((error: unknown) => {
          cliFetchError = error instanceof Error ? error.message : String(error)
          return { buckets: undefined } as Awaited<
            ReturnType<typeof fetchGeminiCliQuota>
          >
        }),
      ])

      const cliQuota = aggregateGeminiCliQuota(cliResponse)
      const geminiCliQuota: GeminiCliQuotaSummary =
        cliResponse.buckets === undefined || cliResponse.buckets.length === 0
          ? {
              ...cliQuota,
              error:
                cliFetchError ??
                (cliQuota.models.length === 0
                  ? 'No Gemini CLI quota available'
                  : undefined),
            }
          : cliQuota

      const refreshedParts = parseRefreshParts(auth.refresh)
      const updatedAccount: AccountMetadataV3 = {
        ...account,
        refreshToken: refreshedParts.refreshToken || account.refreshToken,
        projectId: refreshedParts.projectId ?? account.projectId,
        managedProjectId:
          refreshedParts.managedProjectId ?? account.managedProjectId,
        ...(projectContext.capturedTier
          ? {
              capturedTierId: projectContext.capturedTier.id,
              ...(projectContext.capturedTier.paidId !== undefined
                ? { capturedPaidTierId: projectContext.capturedTier.paidId }
                : {}),
              capturedTierAt: projectContext.capturedTier.capturedAt,
            }
          : {}),
      }

      return {
        index,
        email: account.email,
        status: 'ok',
        disabled: false,
        quota: summaryPayload.quota,
        geminiCliQuota,
        updatedAccount,
      }
    } catch (error) {
      return {
        index,
        email: account.email,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        disabled: false,
      }
    }
  }
}

/**
 * One-shot forced refresh across the pool with no shared cache, mirroring
 * v1's `checkAccountsQuotaWith`: manual quota views must always reflect the
 * latest data even when a background manager has backed off.
 */
export async function refreshQuotaOnce(
  accounts: AccountMetadataV3[],
  fetchAccountQuota: FetchAccountQuota,
): Promise<AccountQuotaResult[]> {
  const manager = createQuotaManager({
    fetchAccountQuota,
    keyOf: defaultKeyOf,
  })
  try {
    return await manager.refreshAccounts(accounts, {
      indexFor: (account) => accounts.indexOf(account),
      force: true,
    })
  } finally {
    await manager.dispose()
  }
}
