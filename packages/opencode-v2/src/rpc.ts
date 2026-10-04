import type { Rpc } from '@opencode-ai/plugin'
import { z } from 'zod'

const quotaCell = z.object({
  remainingPercent: z.number().nullable(),
  resetAt: z.number().optional(),
  windows: z.array(
    z.object({
      name: z.enum(['5h', 'weekly']),
      remainingPercent: z.number().nullable(),
      resetAt: z.number().optional(),
    }),
  ),
})

const accountRow = z.object({
  label: z.string(),
  state: z.enum(['active', 'disabled', 'ineligible', 'verification-required']),
  current: z.enum(['both', 'claude', 'gemini', 'none']),
  gemini: quotaCell,
  nonGemini: quotaCell,
  cacheUpdatedAt: z.number().optional(),
  cacheSuccessAt: z.number().optional(),
})

const sidebarQuotaCell = quotaCell.extend({
  source: z.enum(['cache', 'live']),
  updatedAt: z.number().optional(),
  refreshState: z.enum(['idle', 'refreshing', 'error', 'unavailable']),
})

export const sidebarQuotaSnapshot = z.object({
  accounts: z.array(
    accountRow.extend({
      gemini: sidebarQuotaCell,
      nonGemini: sidebarQuotaCell,
    }),
  ),
  notices: z.array(z.string()),
})

export type SidebarQuotaSnapshot = z.infer<typeof sidebarQuotaSnapshot>
export type SidebarQuotaAccount = SidebarQuotaSnapshot['accounts'][number]
export type SidebarQuotaCell = SidebarQuotaAccount['gemini']

export const panelSnapshot = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('account'), accounts: z.array(accountRow) }),
  z.object({ kind: z.literal('quota'), accounts: z.array(accountRow) }),
  z.object({
    kind: z.literal('status'),
    pool: z.object({
      total: z.number(),
      enabled: z.number(),
      disabled: z.number(),
      ineligible: z.number(),
      verificationRequired: z.number(),
    }),
    current: z.object({ claude: z.string(), gemini: z.string() }),
    quotaCache: z.object({ oldestAgeMs: z.number().nullable() }),
    paths: z.object({ accountsFile: z.string(), logFile: z.string() }),
  }),
])

export const antigravityRpc = {
  id: 'cortexkit.antigravity-auth',
  methods: {
    sidebarQuota: {
      input: z.object({ mode: z.enum(['cache', 'ensure']) }),
      output: sidebarQuotaSnapshot,
    },
    run: {
      input: z.object({
        name: z.enum(['account', 'quota', 'status']),
        args: z.string(),
      }),
      output: z.object({
        messages: z.array(z.string()),
        notices: z.array(z.string()).optional(),
        operationId: z.string().optional(),
        snapshot: panelSnapshot.optional(),
      }),
    },
    operation: {
      input: z.object({ operationId: z.string() }),
      output: z.object({
        state: z.enum([
          'pending',
          'complete',
          'failed',
          'persisted-not-live',
          'unconfirmed',
        ]),
        messages: z.array(z.string()),
        notices: z.array(z.string()).optional(),
        snapshot: panelSnapshot.optional(),
      }),
    },
  },
  events: {},
} satisfies Rpc.PortableDefinition

export default antigravityRpc
