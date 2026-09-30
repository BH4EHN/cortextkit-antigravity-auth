// OpenCode V2 Antigravity provider (port of cortexkit/antigravity-auth).
//
// The native `@opencode-ai/ai/providers/google` package builds and parses Gemini
// traffic, so images/PDF/tool-calls need no custom codec. A `http.request` hook
// redirects each Antigravity model request to a loopback server owned by this
// plugin; the server performs the real call through
// `@cortexkit/antigravity-auth-core` (raw HTTP/1.1 transport matching the
// Antigravity CLI, proxy aware), rotating over the multi-account pool in
// `~/.config/opencode/antigravity-accounts.json`, and streams the unwrapped SSE
// back to OpenCode.

import { randomUUID } from 'node:crypto'
import { appendFileSync, chmodSync, existsSync, mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import type { ServerResponse } from 'node:http'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  AccountManager,
  type AccountStorageV4,
  type AgyRequestScope,
  AgyRequestSessionStore,
  ANTIGRAVITY_ENDPOINT_FALLBACKS,
  type AntigravityTokenExchangeResult,
  applyClaudeTransforms,
  authorizeAntigravity,
  buildAgyAgentRequestMetadata,
  buildAntigravityHarnessUserAgent,
  buildImageGenerationConfig,
  CLAUDE_THINKING_MAX_OUTPUT_TOKENS,
  defaultAccountStorageStore,
  ensureProjectContext,
  exchangeAntigravity,
  fetchWithAgyCliTransport,
  formatRefreshParts,
  getModelFamily,
  isImageGenerationModel,
  loadAccountStorage,
  type ManagedAccount,
  mutateAccountStorage,
  normalizeGeminiTools,
  type OAuthAuthDetails,
  orderAgyRequestPayloadInPlace,
  parseRateLimitReason,
  parseRefreshParts,
  refreshAntigravityToken,
  resolveModelForHeaderStyle,
  SKIP_THOUGHT_SIGNATURE,
  sanitizeCrossModelPayloadInPlace,
  toGeminiSchema,
} from '@cortexkit/antigravity-auth-core'
import type {
  Credential,
  Integration,
  Plugin as OpenCodePlugin,
} from '@opencode-ai/plugin'
import type { Registration } from '@opencode-ai/plugin/promise/registration'
import type { SessionRequestKind } from '@opencode-ai/plugin/promise/session'

import {
  type AntigravityCommandRuntime,
  type AntigravityPanelSnapshot,
  createAntigravityCommands,
  PoolMutationUnconfirmedError,
  parseAccountArgs,
} from './commands.ts'
import { waitForAntigravityCode } from './oauth-callback.ts'
import { makeFetchAccountQuota, refreshQuotaOnce } from './quota.ts'
import { antigravityRpc } from './rpc.ts'

type ResolvedModel = ReturnType<typeof resolveModelForHeaderStyle>
interface GeminiPart {
  text?: string
  thought?: boolean
  thoughtSignature?: string
  inlineData?: { mimeType?: string; data?: string }
  functionCall?: unknown
  functionResponse?: unknown
  [key: string]: unknown
}

interface GeminiContent {
  role?: string
  parts?: GeminiPart[]
  [key: string]: unknown
}

interface GeminiCandidate {
  index?: number
  content?: GeminiContent
  finishReason?: string
  thought?: unknown
  [key: string]: unknown
}

interface GeminiPayload {
  contents?: GeminiContent[]
  tools?: unknown[]
  toolConfig?: Record<string, unknown>
  candidates?: GeminiCandidate[]
  usageMetadata?: unknown
  promptFeedback?: unknown
  generationConfig?: Record<string, unknown>
  providerOptions?: unknown
  safetySettings?: unknown[]
  systemInstruction?: GeminiContent
  model?: unknown
  project?: unknown
  user_prompt_id?: unknown
  session_id?: unknown
  labels?: unknown
  sessionId?: unknown
  [key: string]: unknown
}

interface AntigravityEnvelope {
  project: string
  requestId: string
  request: GeminiPayload
  model: string
  userAgent: 'antigravity'
  requestType: 'agent'
}

interface PendingJob {
  payload: GeminiPayload
  resolved: ResolvedModel
  modelID: string
  variant?: string
  sessionID: string
  kind: SessionRequestKind
  stream: boolean
  signal?: AbortSignal
}

interface SendInput {
  envelope: AntigravityEnvelope
  auth: OAuthAuthDetails
  endpoint: string
  signal?: AbortSignal
  kind: SessionRequestKind
}

interface OpenCodeV2Dependencies {
  authorizeAntigravity: typeof authorizeAntigravity
  ensureProjectContext: typeof ensureProjectContext
  exchangeAntigravity: typeof exchangeAntigravity
  loadAccountStorage: typeof loadAccountStorage
  mutateAccountStorage: typeof mutateAccountStorage
  refreshAntigravityToken: typeof refreshAntigravityToken
  waitForAntigravityCode: typeof waitForAntigravityCode
  send?: (input: SendInput) => Promise<Response>
}

export type OpenCodeV2DependencyOverrides = Partial<OpenCodeV2Dependencies>

class OAuthPersistedNotLiveError extends Error {
  constructor() {
    super(
      'Account saved to the pool, but the live adapter could not reload it. Restart OpenCode before using the account.',
    )
    this.name = 'OAuthPersistedNotLiveError'
  }
}

class OAuthUnconfirmedError extends Error {
  constructor() {
    super(
      'Account write could not be confirmed. Inspect the account pool before retrying this login.',
    )
    this.name = 'OAuthUnconfirmedError'
  }
}

type OAuthSuccess = Extract<AntigravityTokenExchangeResult, { type: 'success' }>

export function upsertOAuthAccount(
  current: AccountStorageV4,
  result: OAuthSuccess,
  now: number,
): AccountStorageV4 {
  const refreshParts = parseRefreshParts(result.refresh)
  if (!refreshParts.refreshToken) {
    throw new Error('Antigravity token exchange returned no refresh token')
  }
  const existingIndex = current.accounts.findIndex((account) =>
    result.email
      ? account.email === result.email
      : account.refreshToken === refreshParts.refreshToken,
  )
  const existing =
    existingIndex >= 0 ? current.accounts[existingIndex] : undefined
  const account = {
    ...existing,
    email: result.email ?? existing?.email,
    label: result.label ?? existing?.label,
    refreshToken: refreshParts.refreshToken,
    projectId:
      refreshParts.projectId || result.projectId || existing?.projectId,
    managedProjectId:
      refreshParts.managedProjectId ?? existing?.managedProjectId,
    addedAt: existing?.addedAt ?? now,
    lastUsed: now,
    enabled: true,
    accountIneligible: false,
    accountIneligibleAt: undefined,
    accountIneligibleReason: undefined,
    verificationRequired: false,
    verificationRequiredAt: undefined,
    verificationRequiredReason: undefined,
    eligibilityStateUpdatedAt: now,
  }
  const accounts = [...current.accounts]
  if (existingIndex >= 0) accounts[existingIndex] = account
  else accounts.push(account)
  return { ...current, version: 4, accounts }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isAntigravitySlashCommand(text: string): boolean {
  return /^\/antigravity-(?:account|quota|status)(?=\s|$)/.test(
    text.trimStart(),
  )
}

function configDir(): string {
  const explicit = process.env.OPENCODE_CONFIG_DIR?.trim()
  if (explicit) return explicit
  if (process.platform === 'win32' && process.env.APPDATA?.trim()) {
    const appdata = join(process.env.APPDATA.trim(), 'opencode')
    if (existsSync(join(appdata, 'antigravity-accounts.json'))) return appdata
  }
  const xdg = process.env.XDG_CONFIG_HOME?.trim()
  return xdg ? join(xdg, 'opencode') : join(homedir(), '.config', 'opencode')
}

function stateDir(): string {
  const xdg = process.env.XDG_STATE_HOME?.trim()
  return xdg
    ? join(xdg, 'opencode')
    : join(homedir(), '.local', 'state', 'opencode')
}

const ACCOUNTS_FILE =
  process.env.ANTIGRAVITY_ACCOUNTS_FILE?.trim() ||
  join(configDir(), 'antigravity-accounts.json')
const LOGFILE = join(stateDir(), 'antigravity-v2.log')
const INTEGRATION_ID = 'google' as Integration.ID
const METHOD_ID = 'antigravity-v2' as Integration.MethodID
function log(...args: unknown[]): void {
  try {
    const directory = dirname(LOGFILE)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    chmodSync(directory, 0o700)
    appendFileSync(
      LOGFILE,
      `[${new Date().toISOString()}] ` +
        args
          .map((x) => (typeof x === 'string' ? x : JSON.stringify(x)))
          .join(' ') +
        '\n',
      { mode: 0o600 },
    )
    chmodSync(LOGFILE, 0o600)
  } catch {
    return
  }
}

const MODEL_IDS = new Set([
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.1-pro',
  'gemini-3.1-flash-image',
  'claude-sonnet-4-6-thinking',
  'claude-opus-4-6-thinking',
  'gpt-oss-120b-medium',
])

function familyFor(modelID: string): 'claude' | 'gemini' {
  return getModelFamily(modelID) === 'claude' ? 'claude' : 'gemini'
}

function requestedModel(modelID: string, variant?: string): string {
  if (!variant || variant === 'default') return modelID
  return `${modelID}-${variant}`
}

function unwrapFrame(parsed: unknown): GeminiPayload {
  if (isRecord(parsed) && isRecord(parsed.response)) {
    return parsed.response as GeminiPayload
  }
  return isRecord(parsed) ? (parsed as GeminiPayload) : {}
}

// Antigravity's GPT/Claude bridges occasionally emit parts and roles the strict
// native Gemini event schema rejects (e.g. role "assistant", or a part carrying
// only a thought signature). Normalise every frame to the Gemini shape.
function sanitizeInner(inner: GeminiPayload): GeminiPayload {
  const candidates = inner?.candidates
  if (!Array.isArray(candidates)) return inner
  for (const candidate of candidates) {
    const content = candidate?.content
    if (!content || typeof content !== 'object') continue
    if (content.role !== 'user' && content.role !== 'model')
      content.role = 'model'
    // `parts` is required by the native schema; GPT-OSS opens a turn without it.
    if (!Array.isArray(content.parts)) {
      content.parts = []
      continue
    }
    content.parts = content.parts
      .map((part) => {
        if (!part || typeof part !== 'object') return null
        const out: GeminiPart = {}
        if (typeof part.text === 'string') out.text = part.text
        if (part.thought !== undefined) out.thought = Boolean(part.thought)
        if (typeof part.thoughtSignature === 'string')
          out.thoughtSignature = part.thoughtSignature
        if (part.inlineData) out.inlineData = part.inlineData
        if (part.functionCall) out.functionCall = part.functionCall
        if (part.functionResponse) out.functionResponse = part.functionResponse
        if (
          out.text === undefined &&
          !out.inlineData &&
          !out.functionCall &&
          !out.functionResponse
        ) {
          out.text = ''
        }
        return out
      })
      .filter((part) => part !== null)
  }
  return inner
}

const IMAGE_DIR = join(homedir(), '.opencode', 'generated-images')
const IMAGE_EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

// The native Gemini event parser only renders text and tool calls, so generated
// images are written to disk and announced as text instead of being dropped.
async function persistInlineImages(
  inner: GeminiPayload,
): Promise<GeminiPayload> {
  const parts = inner?.candidates?.[0]?.content?.parts
  if (!Array.isArray(parts)) return inner
  for (let index = 0; index < parts.length; index += 1) {
    const inline = parts[index]?.inlineData
    if (!inline?.data || !String(inline.mimeType ?? '').startsWith('image/'))
      continue
    try {
      const { chmod, mkdir, writeFile } = await import('node:fs/promises')
      await mkdir(IMAGE_DIR, { recursive: true, mode: 0o700 })
      await chmod(IMAGE_DIR, 0o700)
      const mimeType = inline.mimeType ?? 'image/png'
      const extension = IMAGE_EXTENSION[mimeType] ?? 'png'
      const file = join(
        IMAGE_DIR,
        `${Date.now()}-${randomUUID().slice(0, 8)}.${extension}`,
      )
      await writeFile(file, Buffer.from(inline.data, 'base64'), {
        mode: 0o600,
      })
      await chmod(file, 0o600)
      parts[index] = { text: `[Antigravity image saved: ${file}]` }
      log('image-saved', file, inline.mimeType)
    } catch (error) {
      log('image-save-error', errorMessage(error))
      parts[index] = {
        text: '[Antigravity returned an image that could not be saved]',
      }
    }
  }
  return inner
}
function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get('retry-after')?.trim()
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000
  const date = Date.parse(value)
  return Number.isFinite(date) && date - Date.now() > 0
    ? date - Date.now()
    : undefined
}

async function readErrorDetails(
  response: Response,
): Promise<{ reason?: string; message: string }> {
  const body = await response.text().catch(() => '')
  try {
    const parsed: unknown = JSON.parse(body)
    if (!isRecord(parsed)) return { message: body.slice(0, 300) }
    const error = isRecord(parsed.error) ? parsed.error : undefined
    const details = Array.isArray(error?.details)
      ? error.details
      : Array.isArray(parsed.details)
        ? parsed.details
        : []
    const reason = details
      .map((item) => (isRecord(item) ? item.reason : undefined))
      .find((value): value is string => typeof value === 'string')
    const resolvedReason =
      reason ?? (typeof error?.status === 'string' ? error.status : undefined)
    return {
      ...(resolvedReason ? { reason: resolvedReason } : {}),
      message:
        typeof error?.message === 'string'
          ? error.message.slice(0, 300)
          : body.slice(0, 300),
    }
  } catch {
    return { message: body.slice(0, 300) }
  }
}

function configureToolCalling(request: GeminiPayload): void {
  if (!Array.isArray(request.tools) || request.tools.length === 0) {
    delete request.toolConfig
    return
  }
  const toolConfig =
    request.toolConfig &&
    typeof request.toolConfig === 'object' &&
    !Array.isArray(request.toolConfig)
      ? request.toolConfig
      : {}
  const functionCallingConfig: Record<string, unknown> = isRecord(
    toolConfig.functionCallingConfig,
  )
    ? toolConfig.functionCallingConfig
    : {}
  functionCallingConfig.mode = 'VALIDATED'
  toolConfig.functionCallingConfig = functionCallingConfig
  request.toolConfig = toolConfig
}

function normalizeFunctionResponseRoles(request: GeminiPayload): void {
  for (const content of request.contents ?? []) {
    const parts = content.parts ?? []
    if (
      parts.length > 0 &&
      parts.every((part) => part.functionResponse !== undefined)
    ) {
      content.role = 'model'
    }
  }
}

function ensureFunctionCallSignatures(request: GeminiPayload): void {
  for (const content of request.contents ?? []) {
    let foundFunctionCall = false
    for (const part of content.parts ?? []) {
      if (!part.functionCall) continue
      const signature = part.thoughtSignature
      if (!foundFunctionCall) {
        foundFunctionCall = true
        part.thoughtSignature =
          typeof signature === 'string' && signature.length >= 50
            ? signature
            : SKIP_THOUGHT_SIGNATURE
        continue
      }
      delete part.thoughtSignature
      delete part.thought_signature
    }
  }
}

function ensureTrailingUserTurn(request: GeminiPayload): void {
  if (!Array.isArray(request.contents) || request.contents.length === 0) return
  const last = request.contents.at(-1)
  if (last?.role !== 'model' && last?.role !== 'assistant') return
  request.contents.push({ role: 'user', parts: [{ text: '[Continue]' }] })
}

export function buildEnvelope(
  payload: GeminiPayload,
  resolved: ResolvedModel,
  projectID: string,
  scope: AgyRequestScope,
  options: { preserveFunctionCallSignatures?: boolean } = {},
): AntigravityEnvelope {
  const request = structuredClone(payload)
  const replaySignatures = options.preserveFunctionCallSignatures
    ? (request.contents ?? []).flatMap((content) =>
        (content.parts ?? []).flatMap((part) =>
          part.functionCall
            ? [
                typeof part.thoughtSignature === 'string'
                  ? part.thoughtSignature
                  : undefined,
              ]
            : [],
        ),
      )
    : []
  delete request.model
  delete request.project
  delete request.providerOptions
  delete request.user_prompt_id
  delete request.session_id

  const generationConfig = { ...(request.generationConfig ?? {}) }
  delete generationConfig.thinkingConfig
  if (resolved.thinkingLevel) {
    generationConfig.thinkingConfig = {
      includeThoughts: true,
      thinkingLevel: resolved.thinkingLevel,
    }
  } else if (resolved.thinkingBudget !== undefined) {
    generationConfig.thinkingConfig = {
      includeThoughts: true,
      thinkingBudget: resolved.thinkingBudget,
    }
  }
  if (Object.keys(generationConfig).length > 0)
    request.generationConfig = generationConfig
  else delete request.generationConfig

  // AGY's GPT bridge re-encodes protobuf numeric constraints as strings before
  // OpenAI JSON-Schema validation, so `minLength: 1` must move to the description.
  sanitizeCrossModelPayloadInPlace(request, {
    targetModel: resolved.actualModel,
  })
  const isGpt = /^gpt-/i.test(resolved.actualModel)
  const isImage = isImageGenerationModel(resolved.actualModel)
  const isClaude = familyFor(resolved.actualModel) === 'claude'
  if (isImage) {
    generationConfig.imageConfig = buildImageGenerationConfig()
    generationConfig.candidateCount ??= 1
    delete generationConfig.thinkingConfig
    request.generationConfig = generationConfig
    delete request.tools
    delete request.toolConfig
    request.systemInstruction = {
      parts: [
        {
          text: 'You are an AI image generator. Generate images based on user descriptions. Focus on creating high-quality, visually appealing images that match the user request.',
        },
      ],
    }
  } else if (isClaude) {
    applyClaudeTransforms(request, {
      model: resolved.actualModel,
      ...(resolved.thinkingBudget !== undefined
        ? { tierThinkingBudget: resolved.thinkingBudget }
        : {}),
      normalizedThinking: {
        includeThoughts: true,
        ...(resolved.thinkingBudget !== undefined
          ? { thinkingBudget: resolved.thinkingBudget }
          : {}),
      },
      cleanJSONSchema: (schema) => {
        const clean = toGeminiSchema(schema)
        return isRecord(clean) ? clean : {}
      },
    })
    const claudeGeneration = request.generationConfig
    if (claudeGeneration) {
      claudeGeneration.maxOutputTokens = CLAUDE_THINKING_MAX_OUTPUT_TOKENS
      delete claudeGeneration.max_output_tokens
    }
    const claudeThinking = isRecord(claudeGeneration?.thinkingConfig)
      ? claudeGeneration.thinkingConfig
      : undefined
    if (claudeThinking) {
      claudeGeneration!.thinkingConfig = {
        includeThoughts: claudeThinking.include_thoughts !== false,
        ...(typeof claudeThinking.thinking_budget === 'number'
          ? { thinkingBudget: claudeThinking.thinking_budget }
          : {}),
      }
    }
  } else {
    normalizeGeminiTools(request, {
      moveNumericConstraintsToDescription: isGpt,
    })
    configureToolCalling(request)
  }
  if (!isImage) {
    normalizeFunctionResponseRoles(request)
    if (replaySignatures.length > 0) {
      let signatureIndex = 0
      for (const content of request.contents ?? []) {
        for (const part of content.parts ?? []) {
          if (!part.functionCall) continue
          const signature = replaySignatures[signatureIndex]
          signatureIndex += 1
          if (signature) part.thoughtSignature = signature
        }
      }
    }
    ensureFunctionCallSignatures(request)
  }
  ensureTrailingUserTurn(request)

  const metadata = buildAgyAgentRequestMetadata(
    scope.session,
    request,
    resolved.actualModel,
    scope.timestamp,
  )
  request.labels = metadata.labels
  request.sessionId = metadata.sessionId
  orderAgyRequestPayloadInPlace(request)

  return {
    project: projectID,
    requestId: metadata.requestId,
    request,
    model: resolved.actualModel,
    userAgent: 'antigravity',
    requestType: 'agent',
  }
}

export function createOpenCodeV2AntigravityPlugin(
  overrides: OpenCodeV2DependencyOverrides = {},
): OpenCodePlugin.Plugin {
  const dependencies: OpenCodeV2Dependencies = {
    authorizeAntigravity:
      overrides.authorizeAntigravity ?? authorizeAntigravity,
    ensureProjectContext:
      overrides.ensureProjectContext ?? ensureProjectContext,
    exchangeAntigravity: overrides.exchangeAntigravity ?? exchangeAntigravity,
    loadAccountStorage: overrides.loadAccountStorage ?? loadAccountStorage,
    mutateAccountStorage:
      overrides.mutateAccountStorage ?? mutateAccountStorage,
    refreshAntigravityToken:
      overrides.refreshAntigravityToken ?? refreshAntigravityToken,
    waitForAntigravityCode:
      overrides.waitForAntigravityCode ?? waitForAntigravityCode,
    send: overrides.send,
  }

  return {
    id: 'cortexkit.antigravity-auth',

    async setup(ctx) {
      const requestSessions = new AgyRequestSessionStore('opencode-v2')
      const jobs = new Map<string, PendingJob>()
      const jobTimers = new Map<string, NodeJS.Timeout>()
      const lastModelBySession = new Map<string, string>()
      const activeControllers = new Set<AbortController>()
      const registrations: Registration[] = []

      let accounts = await dependencies
        .loadAccountStorage(ACCOUNTS_FILE)
        .catch((error) => {
          log('accounts-load-error', errorMessage(error))
          return null
        })
      let manager = new AccountManager(undefined, accounts, {
        store: defaultAccountStorageStore,
        storagePath: ACCOUNTS_FILE,
      })
      let poolReloadRequired = false
      let poolTransitioning = false
      let poolGeneration = 0
      const logicalByToken = new Map<string, string>()
      let transitionDone: Promise<void> | null = null
      let resolveTransition: (() => void) | null = null
      log('setup-start', 'accounts', manager.getTotalAccountCount())

      const finishTransition = (): void => {
        poolTransitioning = false
        resolveTransition?.()
        resolveTransition = null
        transitionDone = null
      }

      const waitForPool = async (signal?: AbortSignal): Promise<void> => {
        if (signal?.aborted) throw signal.reason
        while (transitionDone) {
          const settled = transitionDone
          if (!signal) {
            await settled
          } else {
            await new Promise<void>((resolve, reject) => {
              const onAbort = (): void => {
                signal.removeEventListener('abort', onAbort)
                reject(signal.reason)
              }
              signal.addEventListener('abort', onAbort, { once: true })
              settled.then(() => {
                signal.removeEventListener('abort', onAbort)
                resolve()
              })
              if (signal.aborted) onAbort()
            })
          }
        }
        if (poolReloadRequired)
          throw new Error(
            'Antigravity account pool requires an OpenCode restart',
          )
      }

      const logicalToken = (token: string): string =>
        logicalByToken.get(token) ?? token

      const currentAccount = (token: string): ManagedAccount | undefined =>
        manager
          .getAccounts()
          .find(
            (account) =>
              logicalToken(account.parts.refreshToken) === logicalToken(token),
          )

      const eligibleAccount = (token: string): ManagedAccount | undefined => {
        if (poolReloadRequired || poolTransitioning) return undefined
        const account = currentAccount(token)
        return account?.enabled !== false &&
          !account?.accountIneligible &&
          !account?.verificationRequired
          ? account
          : undefined
      }

      const recordCompletedRequest = (
        token: string,
        family: ReturnType<typeof familyFor>,
      ): void => {
        if (poolReloadRequired || poolTransitioning) return
        const live = currentAccount(token)
        if (!live) return
        manager.markRequestSuccess(live)
        manager.markAccountUsed(live.index)
        manager.recordRequest(live.index, family)
        manager.requestSaveToDisk()
      }

      // A failed write may have landed. Retire the old saver before reading the
      // authoritative pool; never replay the write to discover its outcome.
      const settlePool = async (): Promise<void> => {
        poolTransitioning = true
        const previous = manager
        try {
          await previous.stopSaving()
        } catch (error) {
          log('pool-saver-stop-error', errorMessage(error))
        }
        try {
          const loaded = await dependencies.loadAccountStorage(ACCOUNTS_FILE)
          accounts = loaded
          manager = new AccountManager(undefined, loaded, {
            store: defaultAccountStorageStore,
            storagePath: ACCOUNTS_FILE,
          })
          poolGeneration += 1
          poolReloadRequired = false
          finishTransition()
        } catch (error) {
          poolReloadRequired = true
          finishTransition()
          log('pool-settle-error', errorMessage(error))
        }
      }

      const preparePoolMutation = async (): Promise<void> => {
        await waitForPool()
        while (poolTransitioning) await waitForPool()
        poolTransitioning = true
        transitionDone = new Promise<void>((resolve) => {
          resolveTransition = resolve
        })
        poolGeneration += 1
        try {
          await manager.flushSaveToDisk()
          await manager.stopSaving()
        } catch (error) {
          await settlePool()
          throw error
        }
      }

      const reloadPool = async (
        options: { flushCurrent?: boolean } = {},
      ): Promise<void> => {
        const previous = manager
        try {
          if (options.flushCurrent !== false) await previous.flushSaveToDisk()
          accounts = await dependencies.loadAccountStorage(ACCOUNTS_FILE)
          manager = new AccountManager(undefined, accounts, {
            store: defaultAccountStorageStore,
            storagePath: ACCOUNTS_FILE,
          })
          poolGeneration += 1
          await previous.dispose().catch((error) => {
            log('previous-pool-dispose-error', errorMessage(error))
          })
          finishTransition()
          log('pool-reloaded', manager.getTotalAccountCount())
        } catch (error) {
          await settlePool()
          log('reload-pool-error', errorMessage(error))
          throw new PoolMutationUnconfirmedError()
        }
      }

      const replaceRotatedToken = async (
        oldToken: string,
        newToken: string,
      ): Promise<boolean> => {
        await preparePoolMutation()
        let expected: AccountStorageV4['accounts'][number] | undefined
        try {
          await dependencies.mutateAccountStorage(ACCOUNTS_FILE, (current) => {
            const index = current.accounts.findIndex(
              (entry) => entry.refreshToken === oldToken,
            )
            if (
              index < 0 ||
              current.accounts.some((entry) => entry.refreshToken === newToken)
            )
              return current
            const prior = current.accounts[index]
            if (!prior) return current
            expected = { ...prior, refreshToken: newToken }
            return {
              ...current,
              accounts: current.accounts.map((entry, at) =>
                at === index ? expected! : entry,
              ),
            }
          })
          await reloadPool({ flushCurrent: false })
        } catch (error) {
          if (poolTransitioning) await settlePool()
          log('refresh-rotation-error', errorMessage(error))
        }
        const durable = accounts?.accounts ?? []
        const replacement = durable.find(
          (entry) => entry.refreshToken === newToken,
        )
        if (
          poolReloadRequired ||
          !expected ||
          durable.some((entry) => entry.refreshToken === oldToken) ||
          !replacement ||
          replacement.addedAt !== expected.addedAt ||
          replacement.lastUsed !== expected.lastUsed ||
          replacement.enabled !== expected.enabled ||
          replacement.projectId !== expected.projectId ||
          replacement.managedProjectId !== expected.managedProjectId
        )
          return false
        logicalByToken.set(newToken, logicalToken(oldToken))
        return true
      }

      async function accessFor(
        token: string,
        force = false,
        generation = poolGeneration,
      ): Promise<{ auth: OAuthAuthDetails; token: string } | null> {
        if (
          poolReloadRequired ||
          poolTransitioning ||
          generation !== poolGeneration
        )
          return null
        const account = eligibleAccount(token)
        if (!account) return null
        if (
          !force &&
          account.access &&
          account.expires &&
          account.expires > Date.now() + 60_000
        ) {
          return { auth: manager.toAuthDetails(account), token }
        }
        const refreshed = await dependencies.refreshAntigravityToken(
          account.parts.refreshToken,
        )
        if (generation !== poolGeneration) return null
        if (refreshed.refresh !== token) {
          if (!refreshed.refresh)
            throw new Error('Antigravity refresh returned no refresh token')
          if (!(await replaceRotatedToken(token, refreshed.refresh)))
            throw new Error(
              'Antigravity refresh-token rotation was not confirmed',
            )
          const rotated = eligibleAccount(refreshed.refresh)
          if (!rotated) return null
          const auth: OAuthAuthDetails = {
            type: 'oauth',
            refresh: formatRefreshParts({
              refreshToken: refreshed.refresh,
              projectId: rotated.parts.projectId,
              managedProjectId: rotated.parts.managedProjectId,
            }),
            access: refreshed.access,
            expires: refreshed.expires,
          }
          manager.updateFromAuth(rotated, auth)
          return { auth, token: refreshed.refresh }
        }
        const current = eligibleAccount(token)
        if (!current) return null
        const auth: OAuthAuthDetails = {
          type: 'oauth',
          refresh: formatRefreshParts({
            refreshToken: refreshed.refresh,
            projectId: current.parts.projectId,
            managedProjectId: current.parts.managedProjectId,
          }),
          access: refreshed.access,
          expires: refreshed.expires,
        }
        manager.updateFromAuth(current, auth)
        return { auth, token: current.parts.refreshToken }
      }

      // Shared by the host OAuth method and the `/antigravity-account add`
      // command: exchange the browser code, append to the pool under lock,
      // and reload the live view.
      async function completeAntigravityLogin(
        code: string,
        state: string,
      ): Promise<Credential.OAuth> {
        const result = await dependencies.exchangeAntigravity(code, state)
        if (result.type === 'failed') {
          throw new Error(`Antigravity token exchange failed: ${result.error}`)
        }
        const now = Date.now()
        const refreshParts = parseRefreshParts(result.refresh)
        if (!refreshParts.refreshToken) {
          throw new Error(
            'Antigravity token exchange returned no refresh token',
          )
        }
        const credential: Credential.OAuth = {
          type: 'oauth',
          methodID: METHOD_ID,
          refresh: formatRefreshParts({
            refreshToken: refreshParts.refreshToken,
            projectId: refreshParts.projectId || result.projectId || undefined,
            managedProjectId: refreshParts.managedProjectId,
          }),
          access: result.access,
          expires: result.expires,
        }
        const matchesTarget = (
          candidate: unknown,
          expected: AccountStorageV4['accounts'][number],
        ): boolean => {
          if (!isRecord(candidate)) return false
          const fields = [
            'email',
            'label',
            'refreshToken',
            'projectId',
            'managedProjectId',
            'addedAt',
            'lastUsed',
            'enabled',
            'accountIneligible',
            'accountIneligibleAt',
            'accountIneligibleReason',
            'verificationRequired',
            'verificationRequiredAt',
            'verificationRequiredReason',
            'eligibilityStateUpdatedAt',
          ] as const
          return fields.every((field) => candidate[field] === expected[field])
        }
        await preparePoolMutation()
        let intended: AccountStorageV4['accounts'][number] | undefined
        let intendedChanged = false
        try {
          await dependencies.mutateAccountStorage(ACCOUNTS_FILE, (current) => {
            const next = upsertOAuthAccount(current, result, now)
            intended = next.accounts.find(
              (entry) => entry.refreshToken === refreshParts.refreshToken,
            )
            const prior = current.accounts.find((entry) =>
              result.email
                ? entry.email === result.email
                : entry.refreshToken === refreshParts.refreshToken,
            )
            intendedChanged = Boolean(
              intended && !matchesTarget(prior, intended),
            )
            return next
          })
          await reloadPool({ flushCurrent: false })
        } catch {
          if (poolTransitioning) await settlePool()
          // Read the authoritative file without another mutation or replay.
          // Mere presence of a preexisting token is insufficient evidence.
          let persisted = false
          try {
            const raw: unknown = JSON.parse(
              await readFile(ACCOUNTS_FILE, 'utf8'),
            )
            const entries =
              typeof raw === 'object' &&
              raw !== null &&
              'version' in raw &&
              raw.version === 4 &&
              'accounts' in raw
                ? raw.accounts
                : undefined
            const expected = intended
            persisted = Boolean(
              expected &&
                intendedChanged &&
                Array.isArray(entries) &&
                entries.some((entry) => matchesTarget(entry, expected)),
            )
          } catch {
            log('oauth-readback-unavailable')
          }
          if (
            persisted &&
            !poolReloadRequired &&
            currentAccount(refreshParts.refreshToken)
          ) {
            return credential
          }
          if (persisted) throw new OAuthPersistedNotLiveError()
          throw new OAuthUnconfirmedError()
        }
        log('account-added', 'pool', manager.getTotalAccountCount())
        return credential
      }

      async function loginViaCommand(
        announce: (message: string) => Promise<void>,
      ): Promise<void> {
        const authorization = await dependencies.authorizeAntigravity()
        const state = new URL(authorization.url).searchParams.get('state')
        if (!state) {
          throw new Error(
            'Antigravity authorization URL is missing OAuth state',
          )
        }
        await announce(`Open this URL to sign in:\n${authorization.url}`)
        const code = await dependencies.waitForAntigravityCode(state)
        await completeAntigravityLogin(code, state)
      }

      function send(
        envelope: AntigravityEnvelope,
        auth: OAuthAuthDetails,
        endpoint: string,
        signal: AbortSignal | undefined,
        kind: SessionRequestKind,
      ): Promise<Response> {
        if (dependencies.send) {
          return dependencies.send({ envelope, auth, endpoint, signal, kind })
        }
        return fetchWithAgyCliTransport(
          `${endpoint}/v1internal:streamGenerateContent?alt=sse`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${auth.access}`,
              'Content-Type': 'application/json',
              'Accept-Encoding': 'gzip',
              'User-Agent': buildAntigravityHarnessUserAgent(),
            },
            body: JSON.stringify(envelope),
          },
          { signal: signal ?? null, idleTimeoutMs: 300_000 },
        )
      }

      function requestSessionKey(job: PendingJob): string {
        return `${job.sessionID || '__default__'}:${job.kind}`
      }

      async function pickResponse(
        job: PendingJob,
        signal?: AbortSignal,
      ): Promise<{ response: Response; account: ManagedAccount }> {
        await waitForPool(signal)
        const family = familyFor(job.modelID)
        const requested = job.resolved.actualModel
        const identity = { id: job.sessionID ?? 'default', parentId: null }
        const excluded = new Set<string>()
        const forcedRefreshes = new Set<string>()
        const poolSize = Math.max(1, manager.getEnabledAccounts().length)
        let failure: unknown = null

        for (let attempt = 0; attempt < poolSize + 2; attempt += 1) {
          await waitForPool(signal)
          const excludedIndexes = new Set(
            manager
              .getAccounts()
              .filter((entry) =>
                excluded.has(logicalToken(entry.parts.refreshToken)),
              )
              .map((entry) => entry.index),
          )
          const account = manager.getCurrentOrNextForFamily(
            family,
            requested,
            'hybrid',
            'antigravity',
            false,
            100,
            10 * 60_000,
            identity,
            excludedIndexes,
          )
          if (!account) break
          let token = account.parts.refreshToken
          const selectedGeneration = poolGeneration

          let auth: OAuthAuthDetails
          try {
            const accessed = await accessFor(token, false, selectedGeneration)
            await waitForPool(signal)
            if (poolGeneration !== selectedGeneration) continue
            if (!accessed) {
              excluded.add(logicalToken(token))
              continue
            }
            auth = accessed.auth
            token = accessed.token
          } catch (error) {
            log('token-error', `#${account.index}`, errorMessage(error))
            excluded.add(logicalToken(token))
            failure = error
            continue
          }

          let context: Awaited<ReturnType<typeof ensureProjectContext>>
          try {
            context = await dependencies.ensureProjectContext(auth)
            await waitForPool(signal)
          } catch (error) {
            log('project-error', `#${account.index}`, errorMessage(error))
            excluded.add(logicalToken(token))
            failure = error
            continue
          }
          if (poolGeneration !== selectedGeneration) continue
          if (!eligibleAccount(token)) {
            excluded.add(logicalToken(token))
            continue
          }

          const sessionKey = requestSessionKey(job)
          const scope = requestSessions.beginRequest(sessionKey)
          const envelope = buildEnvelope(
            job.payload,
            job.resolved,
            context.effectiveProjectId,
            scope,
            {
              preserveFunctionCallSignatures:
                lastModelBySession.get(sessionKey) === job.resolved.actualModel,
            },
          )
          if (
            !lastModelBySession.has(sessionKey) &&
            lastModelBySession.size >= 256
          ) {
            const oldestKey = lastModelBySession.keys().next().value
            if (oldestKey) lastModelBySession.delete(oldestKey)
          }
          lastModelBySession.delete(sessionKey)
          lastModelBySession.set(sessionKey, job.resolved.actualModel)

          // A forced refresh happens at most once per account/request; if the
          // endpoint still answers 401 afterwards the account is excluded and the
          // pool selection continues instead of refreshing in an unbounded loop.
          let reselect = false
          for (
            let endpointIndex = 0;
            endpointIndex < ANTIGRAVITY_ENDPOINT_FALLBACKS.length;
            endpointIndex += 1
          ) {
            const endpoint = ANTIGRAVITY_ENDPOINT_FALLBACKS[endpointIndex]
            if (!endpoint) continue
            await waitForPool(signal)
            if (poolGeneration !== selectedGeneration) {
              reselect = true
              break
            }
            // No await between validation and dispatch. Once dispatched, its
            // response may finish even when a command changes the pool.
            const sendingAccount = eligibleAccount(token)
            if (!sendingAccount) {
              reselect = true
              break
            }
            let response: Response
            try {
              response = await send(envelope, auth, endpoint, signal, job.kind)
            } catch (error) {
              log(
                'transport-error',
                `#${account.index}`,
                endpoint,
                errorMessage(error),
              )
              failure = error
              continue
            }
            log(
              'upstream',
              `#${account.index}`,
              endpoint,
              job.resolved.actualModel,
              response.status,
            )

            if (response.ok) {
              if (transitionDone) {
                void waitForPool()
                  .then(() => recordCompletedRequest(token, family))
                  .catch((error) =>
                    log('request-usage-record-error', errorMessage(error)),
                  )
              } else {
                recordCompletedRequest(token, family)
              }
              return {
                response,
                account: currentAccount(token) ?? sendingAccount,
              }
            }

            const { reason, message } = await readErrorDetails(response)
            log('upstream-error', response.status, reason ?? '', message)
            await waitForPool(signal)
            const live = eligibleAccount(token)
            if (!live) {
              reselect = true
              break
            }
            if (
              poolGeneration !== selectedGeneration &&
              !(
                response.status === 403 &&
                (reason === 'ACCOUNT_INELIGIBLE' ||
                  reason === 'VALIDATION_REQUIRED')
              ) &&
              response.status !== 429
            ) {
              reselect = true
              break
            }
            if (
              response.status === 404 &&
              endpointIndex < ANTIGRAVITY_ENDPOINT_FALLBACKS.length - 1
            )
              continue

            if (response.status === 401) {
              if (!forcedRefreshes.has(logicalToken(token))) {
                try {
                  forcedRefreshes.add(logicalToken(token))
                  const accessed = await accessFor(
                    token,
                    true,
                    selectedGeneration,
                  )
                  if (!accessed) {
                    reselect = true
                    break
                  }
                  auth = accessed.auth
                  token = accessed.token
                  await waitForPool(signal)
                  if (poolGeneration !== selectedGeneration) {
                    reselect = true
                    break
                  }
                  endpointIndex -= 1
                  continue
                } catch (error) {
                  failure = error
                }
              }
              excluded.add(logicalToken(token))
              break
            }

            if (response.status === 403 && reason === 'ACCOUNT_INELIGIBLE') {
              manager.markAccountIneligible(live.index, reason)
              await manager.flushSaveToDisk()
              excluded.add(logicalToken(token))
              failure = new Error('Antigravity account is ineligible')
              break
            }

            if (response.status === 403 && reason === 'VALIDATION_REQUIRED') {
              manager.markAccountVerificationRequired(live.index, reason)
              await manager.flushSaveToDisk()
              excluded.add(logicalToken(token))
              failure = new Error('Antigravity account requires validation')
              break
            }

            if (response.status === 503 || response.status === 529) {
              failure = new Error(
                `Antigravity capacity failure ${response.status}${message ? `: ${message}` : ''}`,
              )
              if (endpointIndex < ANTIGRAVITY_ENDPOINT_FALLBACKS.length - 1)
                continue
              manager.markRateLimitedWithReason(
                live,
                family,
                'antigravity',
                requested,
                'MODEL_CAPACITY_EXHAUSTED',
                45_000,
                3_600_000,
              )
              excluded.add(logicalToken(token))
              break
            }

            if (response.status === 429) {
              const limit =
                parseRateLimitReason(reason, '', response.status) ||
                'RATE_LIMIT'
              manager.markRateLimitedWithReason(
                live,
                family,
                'antigravity',
                requested,
                limit,
                retryAfterMs(response) ?? 60_000,
                3_600_000,
              )
              excluded.add(logicalToken(token))
              failure = new Error(
                `Antigravity ${response.status}${reason ? ` (${reason})` : ''}`,
              )
              break
            }

            failure = new Error(
              `Antigravity HTTP ${response.status}${reason ? ` (${reason})` : ''}`,
            )
            excluded.add(logicalToken(token))
            break
          }
          // Transport failures may exhaust every endpoint without producing an
          // HTTP response. Move to another account instead of selecting the same
          // account again in the outer loop.
          if (!reselect || poolGeneration === selectedGeneration)
            excluded.add(logicalToken(token))
        }

        throw (
          failure ??
          new Error(
            'No Antigravity account available (all rate-limited or disabled)',
          )
        )
      }

      // Streams one upstream SSE response into the loopback response, unwrapping the
      // `{ "response": … }` Antigravity envelope. A complete terminal frame is
      // mandatory; clean EOF and embedded errors fail through the host error path.
      async function pipeStream(
        upstream: Response,
        res: ServerResponse,
      ): Promise<{
        sawContent: boolean
        hasFunctionCall: boolean
        terminal: true
      }> {
        if (!upstream.body)
          throw new Error('Antigravity response body is missing')
        const reader = upstream.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let sawContent = false
        let hasFunctionCall = false
        let terminal = false
        try {
          while (!terminal) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            buffer = buffer.replace(/\r\n/g, '\n')
            let boundary = buffer.indexOf('\n\n')
            while (boundary !== -1) {
              const frame = buffer.slice(0, boundary)
              buffer = buffer.slice(boundary + 2)
              boundary = buffer.indexOf('\n\n')
              const data = frame
                .split('\n')
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).replace(/^ /, ''))
                .join('\n')
                .trim()
              if (!data || data === '[DONE]') continue
              let parsed: unknown
              try {
                parsed = JSON.parse(data)
              } catch {
                throw new Error('Antigravity returned a malformed SSE frame')
              }
              if (isRecord(parsed) && isRecord(parsed.error)) {
                const message =
                  typeof parsed.error.message === 'string'
                    ? parsed.error.message
                    : `Antigravity stream failed (${String(parsed.error.status ?? parsed.error.code ?? 'unknown')})`
                throw new Error(message)
              }
              const inner = await persistInlineImages(
                sanitizeInner(unwrapFrame(parsed)),
              )
              const parts = inner?.candidates?.[0]?.content?.parts ?? []
              if (
                parts.some(
                  (part) =>
                    part?.text || part?.functionCall || part?.inlineData,
                )
              )
                sawContent = true
              if (parts.some((part) => part?.functionCall)) {
                hasFunctionCall = true
              }
              if (!res.headersSent) {
                res.writeHead(200, {
                  'content-type': 'text/event-stream; charset=utf-8',
                  'cache-control': 'no-cache',
                })
              }
              res.write(`data: ${JSON.stringify(inner)}\n\n`)
              if (inner?.candidates?.[0]?.finishReason) {
                terminal = true
                break
              }
            }
          }
          if (!terminal) {
            throw new Error('Antigravity stream ended before a terminal frame')
          }
        } finally {
          try {
            await reader.cancel()
          } catch (error) {
            log('stream-cancel-error', errorMessage(error))
          }
        }
        return { sawContent, hasFunctionCall, terminal: true }
      }

      // Collects one upstream SSE stream into a single JSON GenerateContentResponse
      // (used when the host issued a non-streaming `generateContent` call — the
      // loopback must not answer that with `text/event-stream`).
      async function collectNonStream(
        upstream: Response,
      ): Promise<GeminiPayload> {
        if (!upstream.body)
          throw new Error('Antigravity response body is missing')
        const reader = upstream.body.getReader()
        const decoder = new TextDecoder()
        const LF = String.fromCharCode(10)
        const CR = String.fromCharCode(13)
        let buffer = ''
        const byIndex = new Map<number, GeminiCandidate>()
        let usageMetadata: unknown
        let promptFeedback: unknown
        let terminal = false
        try {
          while (!terminal) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            buffer = buffer.split(CR).join('')
            let boundary = buffer.indexOf(LF + LF)
            while (boundary !== -1) {
              const frame = buffer.slice(0, boundary)
              buffer = buffer.slice(boundary + 2)
              boundary = buffer.indexOf(LF + LF)
              const data = frame
                .split(LF)
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).trimStart())
                .join(LF)
                .trim()
              if (!data || data === '[DONE]') continue
              let parsed: unknown
              try {
                parsed = JSON.parse(data)
              } catch {
                throw new Error('Antigravity returned a malformed SSE frame')
              }
              if (isRecord(parsed) && isRecord(parsed.error)) {
                const message =
                  typeof parsed.error.message === 'string'
                    ? parsed.error.message
                    : `Antigravity stream failed (${String(parsed.error.status ?? parsed.error.code ?? 'unknown')})`
                throw new Error(message)
              }
              const inner = sanitizeInner(unwrapFrame(parsed))
              for (const candidate of inner?.candidates ?? []) {
                const index = candidate.index ?? 0
                let entry = byIndex.get(index)
                if (!entry) {
                  entry = {
                    ...candidate,
                    content: { ...(candidate.content ?? {}), parts: [] },
                  }
                  byIndex.set(index, entry)
                }
                for (const part of candidate.content?.parts ?? []) {
                  if (part?.text || part?.inlineData || part?.functionCall)
                    entry.content?.parts?.push(part)
                }
                if (candidate.finishReason)
                  entry.finishReason = candidate.finishReason
                if (candidate.thought) entry.thought = candidate.thought
                if (candidate.index !== undefined) entry.index = index
              }
              if (inner?.usageMetadata) usageMetadata = inner.usageMetadata
              if (inner?.promptFeedback) promptFeedback = inner.promptFeedback
              if (
                inner?.candidates?.some((candidate) => candidate.finishReason)
              )
                terminal = true
            }
          }
          if (!terminal) {
            throw new Error('Antigravity stream ended before a terminal frame')
          }
        } finally {
          try {
            await reader.cancel()
          } catch (error) {
            log('non-stream-cancel-error', errorMessage(error))
          }
        }
        const merged: GeminiPayload = {
          candidates: [...byIndex.values()],
          ...(usageMetadata ? { usageMetadata } : {}),
          ...(promptFeedback ? { promptFeedback } : {}),
        }
        return persistInlineImages(merged)
      }

      const server = createServer((req, res) => {
        const id = (req.url ?? '').split('/').filter(Boolean).pop() ?? ''
        const job = jobs.get(id)
        jobs.delete(id)
        const jobTimer = jobTimers.get(id)
        if (jobTimer) clearTimeout(jobTimer)
        jobTimers.delete(id)
        req.resume()
        if (!job) {
          res.writeHead(404, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({
              error: { message: 'unknown antigravity request', status: 404 },
            }),
          )
          return
        }

        const controller = new AbortController()
        activeControllers.add(controller)
        res.on('close', () => controller.abort())
        const onOriginalAbort = (): void => controller.abort(job.signal?.reason)
        job.signal?.addEventListener('abort', onOriginalAbort, { once: true })
        if (job.signal?.aborted) onOriginalAbort()

        ;(async () => {
          const picked = await pickResponse(job, controller.signal)
          const finish = (body?: string): void => {
            if (!res.headersSent) {
              res.writeHead(200, {
                'content-type': job.stream
                  ? 'text/event-stream; charset=utf-8'
                  : 'application/json; charset=utf-8',
                'cache-control': 'no-cache',
              })
            }
            res.end(body)
          }

          if (!job.stream) {
            const collected = await collectNonStream(picked.response)
            const hasFunctionCall = collected.candidates?.some((candidate) =>
              candidate.content?.parts?.some((part) => part.functionCall),
            )
            if (!hasFunctionCall) {
              requestSessions.completeExecution(requestSessionKey(job))
            }
            log('non-stream-done', job.modelID)
            finish(JSON.stringify(collected))
            return
          }

          const { sawContent, hasFunctionCall, terminal } = await pipeStream(
            picked.response,
            res,
          )
          if (!hasFunctionCall) {
            requestSessions.completeExecution(requestSessionKey(job))
          }
          log(
            'stream-done',
            job.modelID,
            'content',
            sawContent,
            'terminal',
            terminal,
          )
          finish()
        })()
          .catch((error) => {
            log('server-error', errorMessage(error))
            try {
              if (!res.headersSent) {
                res.writeHead(502, { 'content-type': 'application/json' })
                res.end(
                  JSON.stringify({
                    error: {
                      message: errorMessage(error),
                      status: 502,
                    },
                  }),
                )
              } else {
                res.destroy(error instanceof Error ? error : undefined)
              }
            } catch (responseError) {
              log('loopback-error-response-failed', errorMessage(responseError))
            }
          })
          .finally(() => {
            job.signal?.removeEventListener('abort', onOriginalAbort)
            activeControllers.delete(controller)
          })
      })

      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject)
          resolve()
        })
      })
      const address = server.address()
      if (!address || typeof address === 'string') {
        throw new Error('OpenCode 2 loopback server did not publish a port')
      }
      const port = (address as AddressInfo).port
      log('loopback-listening', port)

      registrations.push(
        await ctx.session.hook('prompt', async (event) => {
          if (isAntigravitySlashCommand(event.prompt.text)) {
            throw new Error(
              'Antigravity slash commands require the OpenCode TUI',
            )
          }
        }),
      )

      // `opencode run` bypasses the prompt hook when it admits a raw CLI
      // argument. Check the persisted latest user text again at the model
      // boundary, before any provider (including non-Google providers) runs.
      registrations.push(
        await ctx.session.hook('model.request', async (event) => {
          let messages: Awaited<ReturnType<typeof ctx.session.context>>
          try {
            messages = await ctx.session.context({ sessionID: event.sessionID })
          } catch (error) {
            log('model-request-context-read-error', errorMessage(error))
            throw new Error('Could not verify Antigravity slash command safety')
          }
          const latestUser = messages.findLast(
            (message) => message.type === 'user',
          )
          if (
            latestUser?.type === 'user' &&
            isAntigravitySlashCommand(latestUser.text)
          ) {
            throw new Error(
              'Antigravity slash commands require the OpenCode TUI',
            )
          }
        }),
      )

      registrations.push(
        await ctx.session.hook('http.request', async (event) => {
          try {
            if (event.model.providerID !== 'google') return
            if (event.kind !== 'title' && !MODEL_IDS.has(event.model.id)) return
            const url = new URL(event.request.url)
            if (
              !/\/models\/[^:]+:(?:streamGenerateContent|generateContent)/.test(
                url.pathname,
              )
            )
              return

            const raw = Buffer.from(await event.request.arrayBuffer()).toString(
              'utf8',
            )
            const parsedPayload: unknown = JSON.parse(raw || '{}')
            if (!isRecord(parsedPayload)) {
              throw new Error('OpenCode 2 emitted a non-object Gemini request')
            }
            const payload = parsedPayload as GeminiPayload
            const requested =
              event.kind === 'title'
                ? 'gemini-3.5-flash-low'
                : requestedModel(event.model.id, event.model.variant)
            const resolved = resolveModelForHeaderStyle(
              requested,
              'antigravity',
            )
            const id = randomUUID()
            jobs.set(id, {
              payload,
              resolved,
              modelID: event.model.id,
              variant: event.model.variant,
              sessionID: event.sessionID,
              kind: event.kind,
              // The hook matches both endpoints; the loopback answers the streaming
              // one with SSE and the non-streaming one with a single JSON response.
              stream: /streamGenerateContent/.test(url.pathname),
              signal: event.request.signal,
            })
            const jobTimer = setTimeout(() => {
              jobs.delete(id)
              jobTimers.delete(id)
            }, 10 * 60_000)
            jobTimer.unref()
            jobTimers.set(id, jobTimer)
            const attachments = (payload.contents ?? []).flatMap((content) =>
              (content.parts ?? []).flatMap((part) =>
                part.inlineData
                  ? [
                      `${part.inlineData.mimeType}:${String(part.inlineData.data ?? '').length}b`,
                    ]
                  : [],
              ),
            )
            log(
              'route',
              event.model.id,
              event.model.variant ?? 'default',
              '->',
              resolved.actualModel,
              'media',
              JSON.stringify(attachments),
            )
            event.request = new Request(`http://127.0.0.1:${port}/agy/${id}`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: '{}',
              signal: event.request.signal,
            })
          } catch (error) {
            log('request-hook-error', errorMessage(error))
            throw error
          }
        }),
      )

      // OAuth: every login appends an account to the shared pool.
      registrations.push(
        await ctx.integration.transform((draft) => {
          draft.method.update({
            integrationID: INTEGRATION_ID,
            method: {
              id: METHOD_ID,
              type: 'oauth',
              label: 'Google Antigravity (add account)',
            },
            authorize: async () => {
              const authorization = await dependencies.authorizeAntigravity()
              const state = new URL(authorization.url).searchParams.get('state')
              if (!state) {
                throw new Error(
                  'Antigravity authorization URL is missing OAuth state',
                )
              }
              const pending = dependencies.waitForAntigravityCode(state)
              const callback = (async () => {
                const code = await pending
                return completeAntigravityLogin(code, state)
              })()
              return {
                url: authorization.url,
                instructions:
                  'Open the URL and sign in. The Google account is appended to the Antigravity pool.',
                mode: 'auto',
                callback,
              }
            },
            refresh: async (credential) => {
              const parts = parseRefreshParts(credential.refresh)
              const refreshed = await dependencies.refreshAntigravityToken(
                parts.refreshToken,
              )
              const nextCredential: Credential.OAuth = {
                type: 'oauth',
                methodID: METHOD_ID,
                refresh: formatRefreshParts({
                  refreshToken: refreshed.refresh,
                  projectId: parts.projectId,
                  managedProjectId: parts.managedProjectId,
                }),
                access: refreshed.access,
                expires: refreshed.expires,
                ...(credential.metadata
                  ? { metadata: credential.metadata }
                  : {}),
              }
              return nextCredential
            },
            label: () => 'Antigravity account',
          })
        }),
      )

      const commandOutputs = new Map<string, string[]>()
      const panelOutputs = new Map<
        string,
        { snapshot?: AntigravityPanelSnapshot; notices: string[] }
      >()
      const operations = new Map<
        string,
        {
          state:
            | 'pending'
            | 'complete'
            | 'failed'
            | 'persisted-not-live'
            | 'unconfirmed'
          messages: string[]
          notices: string[]
          snapshot?: AntigravityPanelSnapshot
        }
      >()
      let addInFlight = false

      const fetchAccountQuota = makeFetchAccountQuota({
        ensureProjectContext: dependencies.ensureProjectContext,
        refreshAntigravityToken: dependencies.refreshAntigravityToken,
      })

      const commandRuntime: AntigravityCommandRuntime = {
        getManager: () => manager,
        resolveToken: (token) =>
          currentAccount(token)?.parts.refreshToken ?? token,
        reloadPool,
        flushPool: preparePoolMutation,
        mutateStorage: async (mutator) => {
          try {
            await dependencies.mutateAccountStorage(ACCOUNTS_FILE, mutator)
          } catch (error) {
            await settlePool()
            log('pool-mutation-error', errorMessage(error))
            throw new PoolMutationUnconfirmedError()
          }
        },
        fetchPoolQuota: async () => {
          const snapshot = manager.getAccountsForQuotaCheck()
          const results = await refreshQuotaOnce(snapshot, fetchAccountQuota)
          return { snapshot, results }
        },
        oauthAdd: loginViaCommand,
        emit: async (callID, message) => {
          commandOutputs.get(callID)?.push(message)
          panelOutputs.get(callID)?.notices.push(message)
        },
        emitPanel: async (callID, snapshot, notice, fallbackText) => {
          const output = panelOutputs.get(callID)
          if (!output) return
          output.snapshot = snapshot
          commandOutputs.get(callID)?.push(fallbackText)
          if (notice) output.notices.push(notice)
        },
        log,
        requiresRestart: () => poolReloadRequired,
        now: () => Date.now(),
        accountsFile: ACCOUNTS_FILE,
        logFile: LOGFILE,
      }

      const commandByName = new Map(
        createAntigravityCommands(commandRuntime).map((definition) => [
          definition.name,
          definition,
        ]),
      )
      registrations.push(
        await ctx.rpc.register(antigravityRpc, {
          run: async ({ name, args }) => {
            if (poolReloadRequired) {
              return {
                messages: [
                  'The Antigravity account pool requires an OpenCode restart before further commands.',
                ],
              }
            }
            if (poolTransitioning)
              return {
                messages: [
                  'The Antigravity account pool is changing; retry this command shortly.',
                ],
              }
            if (name === 'account' && parseAccountArgs(args).kind === 'add') {
              if (addInFlight) {
                return {
                  messages: [
                    'An Antigravity OAuth login is already in progress.',
                  ],
                }
              }
              addInFlight = true
              const operationId = randomUUID()
              const operation: {
                state:
                  | 'pending'
                  | 'complete'
                  | 'failed'
                  | 'persisted-not-live'
                  | 'unconfirmed'
                messages: string[]
                notices: string[]
                snapshot?: AntigravityPanelSnapshot
              } = { state: 'pending', messages: [], notices: [] }
              operations.set(operationId, operation)
              let signalReady: (value: boolean) => void = () => {}
              const ready = new Promise<boolean>((resolve) => {
                signalReady = resolve
              })
              void commandRuntime
                .oauthAdd(async (message) => {
                  operation.messages.push(message)
                  operation.notices.push(message)
                  signalReady(true)
                })
                .then(async () => {
                  operation.messages.push(
                    'Account added to the Antigravity pool.',
                  )
                  operation.notices.push(
                    'Account added to the Antigravity pool.',
                  )
                  const callID = randomUUID()
                  const messages: string[] = []
                  commandOutputs.set(callID, messages)
                  const panelOutput: {
                    snapshot?: AntigravityPanelSnapshot
                    notices: string[]
                  } = { notices: [] }
                  panelOutputs.set(callID, panelOutput)
                  try {
                    const list = commandByName.get('antigravity-account')
                    if (!list)
                      throw new Error(
                        'Antigravity account command is unavailable',
                      )
                    await list.execute({
                      sessionID: callID,
                      prompt: { text: 'list' },
                    } as Parameters<typeof list.execute>[0])
                    operation.messages.push(...messages)
                    operation.notices.push(...panelOutput.notices)
                    operation.snapshot = panelOutput.snapshot
                  } catch {
                    const notice =
                      'Account added; the account list is temporarily unavailable.'
                    operation.messages.push(notice)
                    operation.notices.push(notice)
                  } finally {
                    commandOutputs.delete(callID)
                    panelOutputs.delete(callID)
                  }
                  operation.state = 'complete'
                })
                .catch((error) => {
                  if (error instanceof OAuthPersistedNotLiveError) {
                    operation.state = 'persisted-not-live'
                    const notice =
                      'Account saved to the pool, but the live adapter could not reload it. Restart OpenCode before using the account.'
                    operation.messages.push(notice)
                    operation.notices.push(notice)
                  } else if (error instanceof OAuthUnconfirmedError) {
                    operation.state = 'unconfirmed'
                    const notice =
                      'Account write could not be confirmed. Inspect the account pool before retrying this login.'
                    operation.messages.push(notice)
                    operation.notices.push(notice)
                  } else {
                    operation.state = 'failed'
                    const notice =
                      'Antigravity OAuth login failed. Check the adapter log before retrying.'
                    operation.messages.push(notice)
                    operation.notices.push(notice)
                  }
                  log(
                    'oauth-add-error',
                    error instanceof Error ? error.name : 'unknown',
                  )
                  signalReady(false)
                })
                .finally(() => {
                  addInFlight = false
                  setTimeout(
                    () => operations.delete(operationId),
                    10 * 60_000,
                  ).unref()
                })
              const announced = await ready
              return announced
                ? {
                    messages: [...operation.messages],
                    notices: [...operation.notices],
                    operationId,
                    snapshot: operation.snapshot,
                  }
                : {
                    messages: [...operation.messages],
                    notices: [...operation.notices],
                  }
            }
            const definition = commandByName.get(`antigravity-${name}`)
            if (!definition)
              throw new Error('Antigravity command is unavailable')
            const callID = randomUUID()
            const messages: string[] = []
            const panelOutput: {
              snapshot?: AntigravityPanelSnapshot
              notices: string[]
            } = { notices: [] }
            commandOutputs.set(callID, messages)
            panelOutputs.set(callID, panelOutput)
            try {
              await definition.execute({
                sessionID: callID,
                prompt: { text: args },
              } as Parameters<typeof definition.execute>[0])
              return {
                messages,
                notices: [...panelOutput.notices],
                snapshot: panelOutput.snapshot,
              }
            } finally {
              commandOutputs.delete(callID)
              panelOutputs.delete(callID)
            }
          },
          operation: async ({ operationId }) => {
            const operation = operations.get(operationId)
            if (!operation)
              throw new Error('Antigravity operation is unavailable or expired')
            return {
              state: operation.state,
              messages: [...operation.messages],
              notices: [...operation.notices],
              snapshot: operation.snapshot,
            }
          },
        }),
      )

      return async () => {
        for (const registration of registrations.reverse()) {
          await registration
            .dispose()
            .catch((error) =>
              log('registration-dispose-error', errorMessage(error)),
            )
        }
        jobs.clear()
        lastModelBySession.clear()
        for (const timer of jobTimers.values()) clearTimeout(timer)
        jobTimers.clear()
        for (const controller of activeControllers) controller.abort()
        server.closeAllConnections?.()
        await new Promise<void>((resolve) => server.close(() => resolve()))
        requestSessions.clear()
        if (!poolReloadRequired && !poolTransitioning) {
          await manager
            .flushSaveToDisk()
            .catch((error) => log('pool-flush-error', errorMessage(error)))
          await manager
            .dispose()
            .catch((error) => log('pool-dispose-error', errorMessage(error)))
        }
        log('dispose')
      }
    },
  }
}

export default createOpenCodeV2AntigravityPlugin()
