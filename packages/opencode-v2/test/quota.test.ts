import { afterEach, describe, expect, test } from 'bun:test'

import type {
  AccountMetadataV3,
  OAuthAuthDetails,
} from '@cortexkit/antigravity-auth-core'

import { makeFetchAccountQuota, refreshQuotaOnce } from '../src/quota.ts'

const RESET_WEEKLY = new Date(Date.now() + 3 * 3_600_000).toISOString()

const SUMMARY_BODY = {
  groups: [
    {
      displayName: 'Gemini',
      buckets: [
        {
          bucketId: 'gemini-fast',
          displayName: 'Gemini Fast',
          window: 'weekly',
          resetTime: RESET_WEEKLY,
          remainingFraction: 0.72,
        },
      ],
    },
    {
      displayName: 'Third party',
      buckets: [
        {
          bucketId: '3p-claude',
          displayName: 'Claude',
          window: 'weekly',
          resetTime: RESET_WEEKLY,
          remainingFraction: 0.45,
        },
      ],
    },
  ],
}

const CLI_BODY = {
  buckets: [
    {
      modelId: 'gemini-2.5-pro',
      remainingFraction: 0.5,
      resetTime: RESET_WEEKLY,
    },
  ],
}

interface FetchCall {
  url: string
  status: number
  body?: unknown
}

const calls: FetchCall[] = []
const originalFetch = globalThis.fetch

function stubFetch(handler: (url: string) => Response): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    const response = handler(url)
    calls.push({
      url,
      status: response.status,
      body: await response
        .clone()
        .json()
        .catch(() => undefined),
    })
    return response
  }) as typeof globalThis.fetch
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => {
  globalThis.fetch = originalFetch
  calls.length = 0
})

function metadataAccount(
  overrides: Partial<AccountMetadataV3> = {},
): AccountMetadataV3 {
  return {
    refreshToken: 'token-1',
    projectId: 'project-1',
    addedAt: 1,
    lastUsed: 1,
    enabled: true,
    ...overrides,
  }
}

function fakeDeps() {
  return {
    refreshAntigravityToken: async (refresh: string) => ({
      refresh,
      access: 'access-1',
      expires: Date.now() + 60_000,
    }),
    ensureProjectContext: async (auth: OAuthAuthDetails) => ({
      auth,
      effectiveProjectId: 'project-1',
      capturedTier: { id: 'paid-tier', capturedAt: 42 },
    }),
  }
}

describe('makeFetchAccountQuota', () => {
  test('merges the windowed summary and Gemini CLI pools', async () => {
    stubFetch((url) => {
      if (url.includes(':retrieveUserQuotaSummary'))
        return jsonResponse(SUMMARY_BODY)
      if (url.includes(':retrieveUserQuota')) return jsonResponse(CLI_BODY)
      return jsonResponse({}, 500)
    })
    const fetchAccountQuota = makeFetchAccountQuota(fakeDeps())
    const result = await fetchAccountQuota(
      metadataAccount(),
      new AbortController().signal,
    )
    expect(result.status).toBe('ok')
    expect(result.quota?.groups.gemini?.remainingFraction).toBe(0.72)
    expect(result.quota?.groups['non-gemini']?.remainingFraction).toBe(0.45)
    expect(result.geminiCliQuota?.models).toHaveLength(1)
    expect(result.updatedAccount?.capturedTierId).toBe('paid-tier')
  })

  test('disabled accounts short-circuit without network calls', async () => {
    stubFetch(() => jsonResponse({}, 500))
    const fetchAccountQuota = makeFetchAccountQuota(fakeDeps())
    const result = await fetchAccountQuota(
      metadataAccount({ enabled: false }),
      new AbortController().signal,
    )
    expect(result.status).toBe('disabled')
    expect(calls).toHaveLength(0)
  })

  test('falls back to legacy fetchAvailableModels when the summary fails', async () => {
    stubFetch((url) => {
      if (url.includes(':retrieveUserQuotaSummary'))
        return jsonResponse({ error: 'boom' }, 500)
      if (url.includes(':fetchAvailableModels')) {
        return jsonResponse({
          models: {
            'gemini-3.5-flash': {
              quotaInfo: { remainingFraction: 0.8, resetTime: RESET_WEEKLY },
            },
          },
        })
      }
      if (url.includes(':retrieveUserQuota'))
        return jsonResponse({ buckets: [] })
      return jsonResponse({}, 500)
    })
    const fetchAccountQuota = makeFetchAccountQuota(fakeDeps())
    const result = await fetchAccountQuota(
      metadataAccount(),
      new AbortController().signal,
    )
    expect(result.status).toBe('ok')
    expect(result.quota?.groups.gemini?.remainingFraction).toBe(0.8)
    expect(
      calls.some((call) => call.url.includes(':fetchAvailableModels')),
    ).toBe(true)
  })

  test('a CLI fetch failure annotates the CLI summary without killing the result', async () => {
    stubFetch((url) => {
      if (url.includes(':retrieveUserQuotaSummary'))
        return jsonResponse(SUMMARY_BODY)
      if (url.includes(':retrieveUserQuota'))
        return jsonResponse({ error: 'transient' }, 500)
      return jsonResponse({}, 500)
    })
    const fetchAccountQuota = makeFetchAccountQuota(fakeDeps())
    const result = await fetchAccountQuota(
      metadataAccount(),
      new AbortController().signal,
    )
    expect(result.status).toBe('ok')
    expect(result.quota?.groups.gemini?.remainingFraction).toBe(0.72)
    expect(result.geminiCliQuota?.error).toBeTruthy()
  })

  test('token refresh failures surface as error results', async () => {
    stubFetch(() => jsonResponse(SUMMARY_BODY))
    const fetchAccountQuota = makeFetchAccountQuota({
      ...fakeDeps(),
      refreshAntigravityToken: async () => {
        throw new Error('refresh rejected')
      },
    })
    const result = await fetchAccountQuota(
      metadataAccount(),
      new AbortController().signal,
    )
    expect(result.status).toBe('error')
    expect(result.error).toContain('refresh rejected')
  })
})

describe('refreshQuotaOnce', () => {
  test('preserves snapshot indices for every result', async () => {
    stubFetch((url) => {
      if (url.includes(':retrieveUserQuotaSummary'))
        return jsonResponse(SUMMARY_BODY)
      if (url.includes(':retrieveUserQuota')) return jsonResponse(CLI_BODY)
      return jsonResponse({}, 500)
    })
    const accounts = [
      metadataAccount({ refreshToken: 'token-a', email: 'a@example.test' }),
      metadataAccount({ refreshToken: 'token-b', email: 'b@example.test' }),
    ]
    const results = await refreshQuotaOnce(
      accounts,
      makeFetchAccountQuota(fakeDeps()),
    )
    expect(results.map((result) => result.index)).toEqual([0, 1])
    expect(results.map((result) => result.status)).toEqual(['ok', 'ok'])
  })
})
