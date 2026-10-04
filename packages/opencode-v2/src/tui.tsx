import type { Definition } from '@opencode-ai/plugin/tui/plugin'
import { type BoxRenderable, TextAttributes } from '@opentui/core'
import {
  batch,
  createEffect,
  createRoot,
  createSignal,
  For,
  onCleanup,
  Show,
} from 'solid-js'
import type {
  AntigravityPanelSnapshot,
  PanelAccountRow,
  PanelQuotaCell,
} from './commands.ts'
import { isAntigravityModel, quotaGroupForAntigravityModel } from './models.ts'
import type { SidebarQuotaSnapshot } from './rpc.ts'
import { antigravityRpc } from './rpc.ts'

type View = 'account' | 'quota' | 'status'
const PANEL = 'cortexkit.antigravity-auth'

export const id = PANEL

export const tui = {
  id,
  setup(ctx) {
    return createRoot((dispose) => {
      const [view, setView] = createSignal<View>('account')
      const [messages, setMessages] = createSignal<string[]>([])
      const [snapshot, setSnapshot] = createSignal<AntigravityPanelSnapshot>()
      const [snapshotReceivedAt, setSnapshotReceivedAt] = createSignal<number>()
      const [now, setNow] = createSignal(Date.now())
      const [busy, setBusy] = createSignal(false)
      const [operation, setOperation] = createSignal<{
        operationId: string
        directory: string
        sequence: number
      }>()
      const rpc = ctx.client.rpc(antigravityRpc)
      const sessionData = ctx.data
      let sequence = 0
      let timer: ReturnType<typeof setInterval> | undefined
      const clock = setInterval(() => setNow(Date.now()), 60_000)

      function acceptSnapshot(value?: AntigravityPanelSnapshot) {
        const receivedAt = value ? Date.now() : undefined
        batch(() => {
          setNow(receivedAt ?? Date.now())
          setSnapshot(value)
          setSnapshotReceivedAt(receivedAt)
        })
      }

      function resolveLocation(sessionID?: string) {
        const directory =
          (sessionID
            ? sessionData.session.get(sessionID)?.location?.directory
            : undefined) ??
          ctx.location?.directory ??
          sessionData.location.default().directory
        return { directory }
      }

      function stopPolling() {
        if (timer) clearInterval(timer)
        timer = undefined
      }

      async function poll(current: {
        operationId: string
        directory: string
        sequence: number
      }) {
        try {
          const result = await rpc.operation(
            { operationId: current.operationId },
            { location: { directory: current.directory } },
          )
          if (operation() !== current || sequence !== current.sequence) return
          if (view() === 'account') {
            if (result.snapshot) acceptSnapshot(result.snapshot)
            setMessages(result.notices ?? result.messages)
          }
          if (result.state !== 'pending') {
            stopPolling()
            setOperation(undefined)
            if (result.state === 'failed')
              ctx.ui.toast.show({
                variant: 'error',
                message: 'Antigravity login failed',
              })
            if (
              result.state === 'persisted-not-live' ||
              result.state === 'unconfirmed'
            )
              ctx.ui.toast.show({
                variant: 'warning',
                message: 'Antigravity account needs attention',
              })
          }
        } catch (error) {
          if (operation() !== current || sequence !== current.sequence) return
          stopPolling()
          setOperation(undefined)
          if (view() === 'account')
            setMessages([
              `Could not check Antigravity login: ${message(error)}`,
            ])
        }
      }

      async function run(name: View, args = '') {
        const current = ++sequence
        const route = ctx.ui.router.current()
        const directory = resolveLocation(
          route.type === 'session' ? route.sessionID : undefined,
        ).directory
        stopPolling()
        setOperation(undefined)
        setView(name)
        setBusy(true)
        setMessages([])
        acceptSnapshot(undefined)
        try {
          const result = await rpc.run(
            { name, args },
            { location: { directory } },
          )
          if (current !== sequence) return
          setMessages(result.notices ?? result.messages)
          acceptSnapshot(result.snapshot)
          if (result.operationId) {
            const handle = {
              operationId: result.operationId,
              directory,
              sequence: current,
            }
            setOperation(handle)
            timer = setInterval(() => void poll(handle), 1000)
            void poll(handle)
          }
          setBusy(false)
        } catch (error) {
          if (current !== sequence) return
          setBusy(false)
          setMessages([`Antigravity command failed: ${message(error)}`])
        }
      }

      function open(name: View, args = '') {
        setView(name)
        const route = ctx.ui.router.current()
        if (route.type === 'session') {
          if (!ctx.ui.panel.open(PANEL)) {
            ctx.ui.toast.show({
              variant: 'error',
              message: 'Antigravity panel is unavailable',
            })
            return
          }
        } else {
          ctx.ui.router.navigate({ type: 'plugin', name: PANEL })
        }
        void run(name, args)
      }

      type ThemeColors = Partial<
        Record<
          | 'text'
          | 'textMuted'
          | 'accent'
          | 'success'
          | 'warning'
          | 'error'
          | 'borderSubtle',
          typeof ctx.theme.text.base | undefined
        >
      >
      const theme = (): ThemeColors => {
        const text = ctx.theme.text
        const base = text?.base
        return {
          text: base,
          textMuted: text?.muted ?? base,
          accent: text?.action?.primary?.selected ?? base,
          success: text?.feedback?.success?.base ?? base,
          warning: text?.feedback?.warning?.base ?? base,
          error: text?.feedback?.error?.base ?? base,
          borderSubtle: ctx.theme.border?.base,
        }
      }

      function QuotaCell(props: { label: string; cell: PanelQuotaCell }) {
        const percentage = () => props.cell.remainingPercent
        const bar = () => {
          const value = percentage()
          if (value === null) return '────────'
          const filled = Math.max(0, Math.min(8, Math.round(value / 12.5)))
          return `${'█'.repeat(filled)}${'░'.repeat(8 - filled)}`
        }
        const barColor = () => {
          const value = percentage()
          if (value === null) return theme().textMuted
          if (value <= 0) return theme().error
          if (value < 20) return theme().warning
          return theme().success ?? theme().accent
        }
        return (
          <box flexDirection='column' marginTop={1}>
            <text fg={theme().textMuted}>{props.label}</text>
            <box flexDirection='row'>
              <text fg={barColor()}>{bar()}</text>
              <text>
                {' '}
                {percentage() === null
                  ? 'No data'
                  : `${percentage()}% remaining`}
              </text>
            </box>
            <For each={props.cell.windows}>
              {(window) => (
                <text fg={theme().textMuted}>
                  {window.name === 'weekly' ? 'Weekly' : '5h'} ·{' '}
                  {window.remainingPercent === null
                    ? 'no data'
                    : `${window.remainingPercent}%`}
                  {window.resetAt !== undefined
                    ? ` · resets ${relative(window.resetAt - now())}`
                    : ''}
                </text>
              )}
            </For>
            {props.cell.windows.length === 0 &&
            props.cell.resetAt !== undefined ? (
              <text fg={theme().textMuted}>
                Resets {relative(props.cell.resetAt - now())}
              </text>
            ) : null}
          </box>
        )
      }

      function AccountCard(props: { account: PanelAccountRow }) {
        const stateLabel = () =>
          props.account.state === 'verification-required'
            ? 'VERIFY'
            : props.account.state.toUpperCase()
        const currentLabel = () =>
          props.account.current === 'both'
            ? 'Current · Claude + Gemini'
            : props.account.current === 'claude'
              ? 'Current · Claude'
              : props.account.current === 'gemini'
                ? 'Current · Gemini'
                : undefined
        const stateColor = () =>
          props.account.state === 'active'
            ? theme().success
            : props.account.state === 'disabled'
              ? theme().textMuted
              : theme().warning
        return (
          <box
            flexDirection='column'
            marginBottom={1}
            border
            borderStyle='single'
            borderColor={theme().borderSubtle}
            paddingX={1}
            paddingY={1}
          >
            <box flexDirection='row'>
              <text fg={theme().accent}>{props.account.label}</text>
              <text fg={stateColor()}>
                {'  '}
                {stateLabel()}
              </text>
            </box>
            <Show when={currentLabel()}>
              {(label) => <text fg={theme().success}>{label()}</text>}
            </Show>
            <QuotaCell label='Gemini' cell={props.account.gemini} />
            <QuotaCell label='Claude / other' cell={props.account.nonGemini} />
            <text fg={theme().textMuted}>
              Quota cache:{' '}
              {props.account.cacheUpdatedAt !== undefined
                ? `${relative(now() - props.account.cacheUpdatedAt)} ago`
                : 'not available'}
            </text>
          </box>
        )
      }

      function StatusView(props: {
        data: Extract<AntigravityPanelSnapshot, { kind: 'status' }>
        receivedAt?: number
      }) {
        const cacheAge = () => {
          const age = props.data.quotaCache.oldestAgeMs
          if (age === null) return null
          return age + Math.max(0, now() - (props.receivedAt ?? now()))
        }
        return (
          <box flexDirection='column'>
            <text fg={theme().accent}>Pool</text>
            <text>
              Total: {props.data.pool.total} · enabled:{' '}
              {props.data.pool.enabled}
            </text>
            <text fg={theme().textMuted}>
              Disabled: {props.data.pool.disabled} · ineligible:{' '}
              {props.data.pool.ineligible} · verification needed:{' '}
              {props.data.pool.verificationRequired}
            </text>
            <text fg={theme().accent} marginTop={1}>
              Current family accounts
            </text>
            <text>Claude: {props.data.current.claude}</text>
            <text>Gemini: {props.data.current.gemini}</text>
            <text fg={theme().accent} marginTop={1}>
              Quota cache
            </text>
            <text>
              {cacheAge() === null
                ? 'Never refreshed'
                : `Oldest enabled account cache: ${relative(cacheAge()!)} ago`}
            </text>
            <text fg={theme().accent} marginTop={1}>
              Files
            </text>
            <text fg={theme().textMuted}>
              Accounts file: {props.data.paths.accountsFile}
            </text>
            <text fg={theme().textMuted}>
              Log file: {props.data.paths.logFile}
            </text>
          </box>
        )
      }

      function quotaDetails(
        cell: SidebarQuotaSnapshot['accounts'][number]['gemini'],
        width: number,
      ): string[] {
        const state =
          cell.refreshState === 'refreshing'
            ? 'refreshing'
            : cell.refreshState === 'error'
              ? 'refresh failed'
              : cell.refreshState === 'unavailable'
                ? 'N/A'
                : undefined
        const timestamp =
          cell.updatedAt !== undefined && Number.isFinite(cell.updatedAt)
            ? new Date(cell.updatedAt)
            : undefined
        const validTimestamp = timestamp && Number.isFinite(timestamp.getTime())
        const source = cell.source === 'live' ? 'Live' : 'Cached'
        const base = validTimestamp
          ? `${source} · ${String(timestamp.getMonth() + 1).padStart(2, '0')}-${String(timestamp.getDate()).padStart(2, '0')} ${String(timestamp.getHours()).padStart(2, '0')}:${String(timestamp.getMinutes()).padStart(2, '0')}`
          : `${source} · update unknown`
        const suffix = [
          validTimestamp
            ? `${relative(now() - cell.updatedAt!)} ago`
            : undefined,
          state,
        ].filter((part): part is string => part !== undefined)
        if (suffix.length === 0) return [base]
        const tail = suffix.join(' · ')
        return base.length + 3 + tail.length > Math.max(1, width)
          ? [base, tail]
          : [`${base} · ${tail}`]
      }

      function SidebarQuotaCell(props: {
        label: 'Gm' | 'NG'
        cell: SidebarQuotaSnapshot['accounts'][number]['gemini']
        selected: boolean
        slotWidth: number
        showDetails?: boolean
      }) {
        const value = () => props.cell.remainingPercent
        const percentageText = (percentage = value()) =>
          percentage === null ? '   —' : `${String(percentage).padStart(3)}%`
        const resetText = (resetAt?: number) =>
          resetAt === undefined ? undefined : relative(resetAt - now())
        const barText = (percentage = value()) => {
          if (percentage === null) return '──────────'
          const filled =
            !Number.isFinite(percentage) || percentage <= 0
              ? 0
              : Math.round(Math.max(0, Math.min(100, percentage)) / 10)
          return `${'▰'.repeat(filled)}${'▱'.repeat(10 - filled)}`
        }
        const severityColor = (percentage = value()) => {
          if (percentage === null) return theme().textMuted
          if (percentage <= 20)
            return theme().error ?? theme().accent ?? theme().text
          if (percentage <= 50)
            return theme().warning ?? theme().accent ?? theme().text
          return theme().success ?? theme().accent ?? theme().text
        }
        const rows = () => {
          const windows = [...props.cell.windows].sort((left, right) => {
            if (left.name === right.name) return 0
            return left.name === '5h' ? -1 : 1
          })
          return windows.length > 0
            ? windows.map((window) => ({
                label: `${props.label} ${window.name === 'weekly' ? '7d' : '5h'}`,
                value: window.remainingPercent,
                resetAt: window.resetAt,
              }))
            : [
                {
                  label: props.label,
                  value: value(),
                  resetAt: props.cell.resetAt,
                },
              ]
        }
        return (
          <box flexDirection='column'>
            <For each={rows()}>
              {(row) => (
                <>
                  <Show when={props.slotWidth >= 27}>
                    <box flexDirection='row' width='100%'>
                      <text
                        width={5}
                        flexShrink={0}
                        fg={props.selected ? theme().accent : theme().textMuted}
                        attributes={props.selected ? TextAttributes.BOLD : 0}
                      >
                        {row.label}
                      </text>
                      <text> </text>
                      <text
                        width={10}
                        flexShrink={0}
                        fg={severityColor(row.value)}
                      >
                        {barText(row.value)}
                      </text>
                      <box flexGrow={1} />
                      <box width={11} flexShrink={0} flexDirection='row'>
                        <text
                          width={4}
                          flexShrink={0}
                          fg={severityColor(row.value)}
                        >
                          {percentageText(row.value)}
                        </text>
                        <text> </text>
                        <box
                          width={6}
                          flexShrink={0}
                          flexDirection='row'
                          justifyContent='flex-end'
                        >
                          <Show when={row.resetAt !== undefined}>
                            <text fg={theme().textMuted}>
                              {resetText(row.resetAt)}
                            </text>
                          </Show>
                        </box>
                      </box>
                    </box>
                  </Show>
                  <Show when={props.slotWidth >= 16 && props.slotWidth < 27}>
                    <box flexDirection='row' width='100%'>
                      <text
                        width={5}
                        flexShrink={0}
                        fg={props.selected ? theme().accent : theme().textMuted}
                        attributes={props.selected ? TextAttributes.BOLD : 0}
                      >
                        {row.label}
                      </text>
                      <text> </text>
                      <text fg={severityColor(row.value)}>
                        {barText(row.value)}
                      </text>
                    </box>
                    <box flexDirection='row' width='100%'>
                      <text fg={severityColor(row.value)}>
                        {percentageText(row.value)}
                      </text>
                      <Show when={row.resetAt !== undefined}>
                        <text fg={theme().textMuted}>
                          {' '}
                          {resetText(row.resetAt)}
                        </text>
                      </Show>
                    </box>
                  </Show>
                  <Show when={props.slotWidth < 16}>
                    <text
                      fg={props.selected ? theme().accent : theme().textMuted}
                      attributes={props.selected ? TextAttributes.BOLD : 0}
                    >
                      {wrapText(row.label, props.slotWidth)}
                    </text>
                    <For
                      each={wrapText(barText(row.value), props.slotWidth).split(
                        '\n',
                      )}
                    >
                      {(part) => (
                        <text fg={severityColor(row.value)}>{part}</text>
                      )}
                    </For>
                    <Show when={props.slotWidth >= 11}>
                      <text fg={severityColor(row.value)}>
                        {percentageText(row.value)}
                        {row.resetAt !== undefined
                          ? ` ${resetText(row.resetAt)}`
                          : ''}
                      </text>
                    </Show>
                    <Show when={props.slotWidth < 11}>
                      <text fg={severityColor(row.value)}>
                        {percentageText(row.value)}
                      </text>
                      <Show when={row.resetAt !== undefined}>
                        <text fg={theme().textMuted}>
                          {wrapText(
                            resetText(row.resetAt) ?? '',
                            props.slotWidth,
                          )}
                        </text>
                      </Show>
                    </Show>
                  </Show>
                </>
              )}
            </For>
            <Show when={props.showDetails !== false}>
              <For each={quotaDetails(props.cell, props.slotWidth)}>
                {(line) => (
                  <text fg={theme().textMuted}>
                    {props.slotWidth < 27
                      ? wrapText(line, props.slotWidth)
                      : line}
                  </text>
                )}
              </For>
            </Show>
          </box>
        )
      }

      function Sidebar(props: { sessionID: string }) {
        const [sidebarWidth, setSidebarWidth] = createSignal(0)
        let sidebarBox: BoxRenderable | undefined
        const [model, setModel] = createSignal<
          { providerID: string; id: string } | undefined
        >()
        const [data, setData] = createSignal<SidebarQuotaSnapshot>()
        const [notice, setNotice] = createSignal<string>()
        const [sessionNotice, setSessionNotice] = createSignal<string>()
        let active = false
        let generation = 0
        let contextGeneration = 0
        let generationDirectory: string | undefined
        let requestInFlight: number | undefined
        let timer: ReturnType<typeof setInterval> | undefined

        function stop() {
          if (timer) clearInterval(timer)
          timer = undefined
        }

        function readModel(sessionID: string) {
          const selected = sessionData.session.get(sessionID)?.model
          const candidate = selected as
            | { providerID?: string; id?: string }
            | undefined
          setModel(
            candidate?.providerID && candidate.id
              ? { providerID: candidate.providerID, id: candidate.id }
              : undefined,
          )
        }

        function selectFromEvent(event: unknown, sessionID: string) {
          const value = event as {
            data?: {
              sessionID?: string
              model?: { providerID?: string; id?: string }
            }
          }
          if (value.data?.sessionID !== sessionID) return
          const selected = value.data.model
          if (selected?.providerID && selected.id)
            setModel({ providerID: selected.providerID, id: selected.id })
          else readModel(sessionID)
          setSessionNotice(undefined)
        }

        async function request(
          mode: 'cache' | 'ensure',
          current: number,
          directory: string,
        ) {
          if (requestInFlight === current) return
          requestInFlight = current
          try {
            const result = await rpc.sidebarQuota(
              { mode },
              { location: { directory } },
            )
            if (current !== generation || !active) return
            batch(() => {
              setNow(Date.now())
              setData(result)
            })
            setNotice(result.notices[0])
          } catch {
            if (current !== generation || !active) return
            setNotice(
              'Quota refresh failed. Showing the last available values.',
            )
          } finally {
            if (requestInFlight === current) requestInFlight = undefined
          }
        }

        async function load(current: number, directory: string) {
          await request('cache', current, directory)
          if (current === generation && active)
            await request('ensure', current, directory)
        }

        function activate() {
          if (active) return
          active = true
          const current = ++generation
          const directory =
            generationDirectory ?? resolveLocation(props.sessionID).directory
          generationDirectory = directory
          void load(current, directory)
          timer = setInterval(() => {
            void request('ensure', current, directory)
          }, 15_000)
        }

        function deactivate() {
          if (!active) return
          active = false
          generation++
          stop()
        }

        createEffect(() => {
          const sessionID = props.sessionID
          const directory = resolveLocation(sessionID).directory
          const currentContext = ++contextGeneration
          generationDirectory = directory
          generation++
          active = false
          stop()
          setModel(undefined)
          setData(undefined)
          setNotice(undefined)
          setSessionNotice(undefined)
          const unsubscribe = sessionData.on(
            'session.model.selected',
            (event) => selectFromEvent(event, sessionID),
          )
          onCleanup(() => {
            contextGeneration++
            generation++
            active = false
            stop()
            unsubscribe()
          })
          readModel(sessionID)
          void sessionData.session
            .sync(sessionID)
            .then(() => {
              if (
                contextGeneration === currentContext &&
                props.sessionID === sessionID &&
                generationDirectory === directory
              ) {
                readModel(sessionID)
                setSessionNotice(undefined)
              }
            })
            .catch(() => {
              if (
                contextGeneration === currentContext &&
                props.sessionID === sessionID &&
                generationDirectory === directory
              )
                setSessionNotice(
                  'Could not load the selected session model yet.',
                )
            })
        })

        createEffect(() => {
          const selected = model()
          if (isAntigravityModel(selected)) activate()
          else deactivate()
        })

        const group = () => quotaGroupForAntigravityModel(model())
        const isDefaultForGroup = (
          account: SidebarQuotaSnapshot['accounts'][number],
          selectedGroup: 'gemini' | 'non-gemini',
        ) =>
          selectedGroup === 'gemini'
            ? account.current === 'gemini' || account.current === 'both'
            : account.current === 'claude' || account.current === 'both'
        const accountState = (state: string) =>
          state === 'verification-required' ? 'VERIFY' : state.toUpperCase()
        const accountLabel = (
          account: SidebarQuotaSnapshot['accounts'][number],
          selectedGroup: 'gemini' | 'non-gemini',
        ) => {
          const statusWidth =
            accountState(account.state).length +
            (isDefaultForGroup(account, selectedGroup) ? 8 : 0)
          const maxWidth = Math.max(1, sidebarWidth() - 1 - statusWidth)
          if (sidebarWidth() < 27)
            return wrapText(account.label, sidebarWidth())
          return account.label.length > maxWidth
            ? `${account.label.slice(0, maxWidth - 1)}…`
            : account.label
        }
        return (
          <Show when={group()}>
            {(selectedGroup) => (
              <box
                ref={(element) => {
                  sidebarBox = element
                  setSidebarWidth(element.width)
                }}
                onSizeChange={() => {
                  if (sidebarBox) setSidebarWidth(sidebarBox.width)
                }}
                flexDirection='column'
                width='100%'
                paddingY={1}
              >
                <box
                  flexDirection={sidebarWidth() < 27 ? 'column' : 'row'}
                  width='100%'
                >
                  <text fg={theme().accent} attributes={TextAttributes.BOLD}>
                    {sidebarWidth() < 12
                      ? wrapText('Antigravity', sidebarWidth())
                      : 'Antigravity'}
                  </text>
                  <Show when={sidebarWidth() >= 27}>
                    <box flexGrow={1} />
                  </Show>
                  <text fg={theme().accent} attributes={TextAttributes.BOLD}>
                    {sidebarWidth() < 12
                      ? wrapText(
                          selectedGroup() === 'gemini'
                            ? 'Gemini'
                            : 'Claude/other',
                          sidebarWidth(),
                        )
                      : selectedGroup() === 'gemini'
                        ? 'Gemini'
                        : 'Claude/other'}
                  </text>
                </box>
                <text fg={theme().textMuted}>
                  {wrapText(
                    data()
                      ? `${data()!.accounts.length} ${data()!.accounts.length === 1 ? 'account' : 'accounts'} · remaining`
                      : 'Loading quota…',
                    sidebarWidth(),
                  )}
                </text>
                <Show
                  when={data() && data()!.accounts.length > 0}
                  fallback={
                    <text fg={theme().textMuted}>
                      {data() ? 'No Antigravity accounts' : 'Loading quota…'}
                    </text>
                  }
                >
                  <For each={data()?.accounts ?? []}>
                    {(account) => {
                      const deduplicateDetails =
                        account.gemini.refreshState === 'idle' &&
                        account.nonGemini.refreshState === 'idle' &&
                        account.gemini.source === account.nonGemini.source &&
                        account.gemini.updatedAt === account.nonGemini.updatedAt
                      return (
                        <box flexDirection='column' marginTop={1}>
                          <box
                            flexDirection={
                              sidebarWidth() < 27 ? 'column' : 'row'
                            }
                            width='100%'
                            justifyContent='space-between'
                          >
                            <text
                              fg={theme().text}
                              attributes={TextAttributes.BOLD}
                              flexShrink={1}
                            >
                              {accountLabel(account, selectedGroup())}
                            </text>
                            <box
                              flexDirection={
                                sidebarWidth() < 19 ? 'column' : 'row'
                              }
                            >
                              <text
                                fg={
                                  account.state === 'active'
                                    ? theme().success
                                    : theme().warning
                                }
                              >
                                {sidebarWidth() < 16
                                  ? wrapText(
                                      accountState(account.state),
                                      sidebarWidth(),
                                    )
                                  : accountState(account.state)}
                              </text>
                              <Show
                                when={isDefaultForGroup(
                                  account,
                                  selectedGroup(),
                                )}
                              >
                                <text fg={theme().textMuted}>
                                  {sidebarWidth() < 16
                                    ? wrapText('Default', sidebarWidth())
                                    : ' Default'}
                                </text>
                              </Show>
                            </box>
                          </box>
                          <SidebarQuotaCell
                            label='Gm'
                            cell={account.gemini}
                            selected={selectedGroup() === 'gemini'}
                            slotWidth={sidebarWidth()}
                            showDetails={!deduplicateDetails}
                          />
                          <SidebarQuotaCell
                            label='NG'
                            cell={account.nonGemini}
                            selected={selectedGroup() === 'non-gemini'}
                            slotWidth={sidebarWidth()}
                            showDetails={!deduplicateDetails}
                          />
                          <Show when={deduplicateDetails}>
                            <For
                              each={quotaDetails(
                                account.gemini,
                                sidebarWidth(),
                              )}
                            >
                              {(line) => (
                                <text fg={theme().textMuted}>
                                  {sidebarWidth() < 27
                                    ? wrapText(line, sidebarWidth())
                                    : line}
                                </text>
                              )}
                            </For>
                          </Show>
                        </box>
                      )
                    }}
                  </For>
                </Show>
                <Show when={notice()}>
                  {(value) => (
                    <text fg={theme().warning}>
                      {sidebarWidth() < 27
                        ? wrapText(value(), sidebarWidth())
                        : value()}
                    </text>
                  )}
                </Show>
                <Show when={sessionNotice()}>
                  {(value) => (
                    <text fg={theme().warning}>
                      {sidebarWidth() < 27
                        ? wrapText(value(), sidebarWidth())
                        : value()}
                    </text>
                  )}
                </Show>
              </box>
            )}
          </Show>
        )
      }

      function Content() {
        const accounts = () => {
          const current = snapshot()
          return current?.kind === 'account' || current?.kind === 'quota'
            ? current.accounts
            : []
        }
        return (
          <box flexDirection='column' padding={1} flexGrow={1}>
            <box flexDirection='row' marginBottom={1}>
              <text fg={theme().accent}>ANTIGRAVITY</text>
              <text fg={theme().textMuted}>
                {'  '}
                {view().toUpperCase()}
                {busy() ? ' · LOADING' : ''}
                {operation() ? ' · OAUTH IN PROGRESS' : ''}
              </text>
            </box>
            <scrollbox flexGrow={1} flexShrink={1} scrollY>
              <Show
                when={snapshot()}
                fallback={
                  <Show
                    when={busy()}
                    fallback={
                      <Show when={messages().length === 0}>
                        <text fg={theme().textMuted}>
                          Use a command below to view the account pool, quota,
                          or status.
                        </text>
                      </Show>
                    }
                  >
                    <text fg={theme().textMuted}>Loading…</text>
                  </Show>
                }
              >
                {(data) =>
                  data().kind === 'status' ? (
                    <StatusView
                      data={
                        data() as Extract<
                          AntigravityPanelSnapshot,
                          { kind: 'status' }
                        >
                      }
                      receivedAt={snapshotReceivedAt()}
                    />
                  ) : (
                    <For each={accounts()}>
                      {(account) => <AccountCard account={account} />}
                    </For>
                  )
                }
              </Show>
              <Show when={messages().length > 0}>
                <box flexDirection='column' marginTop={1}>
                  <text fg={theme().warning}>Notice</text>
                  <For each={messages()}>{(entry) => <text>{entry}</text>}</For>
                </box>
              </Show>
            </scrollbox>
            <text fg={theme().textMuted}>
              {'Command: /antigravity-account'}
            </text>
            <text fg={theme().textMuted}>{'Command: /antigravity-quota'}</text>
            <text fg={theme().textMuted}>{'Command: /antigravity-status'}</text>
            <text fg={theme().textMuted}>{'Esc: Close'}</text>
          </box>
        )
      }

      const offPage = ctx.ui.router.register({
        name: PANEL,
        render: () => <Content />,
      })
      const offPanel = ctx.ui.slot({
        append: 'session.panel',
        render: (input) => (input.name === PANEL ? <Content /> : null),
      })
      const offSidebar = ctx.ui.slot({
        append: 'sidebar.content',
        render: (input) => <Sidebar sessionID={input.sessionID} />,
      })
      const offCommands = ctx.ui.slot({
        append: 'app',
        render: () => {
          ctx.keymap.layer(() => ({
            mode: 'global',
            commands: (
              [
                ['account', 'Manage Antigravity accounts'],
                ['quota', 'View Antigravity quota'],
                ['status', 'View Antigravity status'],
              ] as const
            ).map(([name, title]) => ({
              id: `antigravity.${name}`,
              title,
              group: 'Antigravity',
              slash: { name: `antigravity-${name}`, arguments: true },
              palette: true,
              run: (args?: string) => open(name, args ?? ''),
            })),
          }))
          ctx.keymap.layer(() => ({
            mode: 'base',
            priority: 1,
            enabled: () => {
              const route = ctx.ui.router.current()
              if (route.type === 'plugin') return route.name === PANEL
              if (route.type !== 'session') return false
              const panel = ctx.ui.panel.current()
              return (
                panel?.name === PANEL && panel.sessionID === route.sessionID
              )
            },
            commands: [
              {
                id: 'antigravity.close',
                title: 'Close Antigravity panel',
                group: 'Antigravity',
                bind: 'escape',
                run: () => {
                  const route = ctx.ui.router.current()
                  if (route.type === 'plugin' && route.name === PANEL) {
                    ctx.ui.router.navigate({ type: 'home' })
                    return
                  }
                  const panel = ctx.ui.panel.current()
                  if (
                    route.type === 'session' &&
                    panel?.name === PANEL &&
                    panel.sessionID === route.sessionID
                  ) {
                    ctx.ui.panel.close()
                  }
                },
              },
            ],
          }))
          return null
        },
      })
      return () => {
        sequence++
        setOperation(undefined)
        stopPolling()
        clearInterval(clock)
        offCommands()
        offPanel()
        offSidebar()
        offPage()
        dispose()
      }
    })
  },
} satisfies Definition

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function wrapText(value: string, width: number): string {
  const limit = Math.max(1, Math.floor(width))
  const lines: string[] = []
  let line = ''
  for (const input of value.split(/\s+/).filter(Boolean)) {
    let word = input
    while (Array.from(word).length > limit) {
      if (line) {
        lines.push(line)
        line = ''
      }
      const columns = Array.from(word)
      lines.push(columns.slice(0, limit).join(''))
      word = columns.slice(limit).join('')
    }
    if (line && Array.from(line).length + 1 + Array.from(word).length > limit) {
      lines.push(line)
      line = ''
    }
    line = line ? `${line} ${word}` : word
  }
  if (line) lines.push(line)
  return lines.join('\n')
}

function relative(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h${minutes % 60 ? `${minutes % 60}m` : ''}`
  return `${Math.floor(hours / 24)}d`
}

export default tui
