import type { Definition } from '@opencode-ai/plugin/tui/plugin'
import {
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
      const [busy, setBusy] = createSignal(false)
      const [operationId, setOperationId] = createSignal<string>()
      const rpc = ctx.client.rpc(antigravityRpc)
      const sessionData = ctx.data
      let sequence = 0
      let timer: ReturnType<typeof setInterval> | undefined

      function stopPolling() {
        if (timer) clearInterval(timer)
        timer = undefined
      }

      async function poll(id: string) {
        try {
          const result = await rpc.operation({ operationId: id })
          if (operationId() !== id) return
          if (view() === 'account') {
            if (result.snapshot) setSnapshot(result.snapshot)
            setMessages(result.notices ?? result.messages)
          }
          if (result.state !== 'pending') {
            stopPolling()
            setOperationId(undefined)
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
          if (operationId() !== id) return
          stopPolling()
          setOperationId(undefined)
          if (view() === 'account')
            setMessages([
              `Could not check Antigravity login: ${message(error)}`,
            ])
        }
      }

      async function run(name: View, args = '') {
        const current = ++sequence
        setView(name)
        setBusy(true)
        setMessages([])
        setSnapshot(undefined)
        try {
          const result = await rpc.run({ name, args })
          if (current !== sequence) return
          setMessages(result.notices ?? result.messages)
          setSnapshot(result.snapshot)
          if (result.operationId) {
            setOperationId(result.operationId)
            stopPolling()
            timer = setInterval(() => void poll(result.operationId!), 1000)
            void poll(result.operationId)
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

      type ThemeColors = {
        text?: string
        textMuted?: string
        accent?: string
        success?: string
        warning?: string
        error?: string
        borderSubtle?: string
      }
      const hostTheme = (
        ctx as unknown as {
          theme?: { current?: ThemeColors }
        }
      ).theme
      const theme = (): ThemeColors => hostTheme?.current ?? {}

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
                    ? ` · resets ${relative(window.resetAt - Date.now())}`
                    : ''}
                </text>
              )}
            </For>
            {props.cell.windows.length === 0 &&
            props.cell.resetAt !== undefined ? (
              <text fg={theme().textMuted}>
                Resets {relative(props.cell.resetAt - Date.now())}
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
                ? `${relative(Date.now() - props.account.cacheUpdatedAt)} ago`
                : 'not available'}
            </text>
          </box>
        )
      }

      function StatusView(props: {
        data: Extract<AntigravityPanelSnapshot, { kind: 'status' }>
      }) {
        const cacheAge = () => props.data.quotaCache.oldestAgeMs
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

      function SidebarQuotaCell(props: {
        label: string
        cell: SidebarQuotaSnapshot['accounts'][number]['gemini']
        selected: boolean
      }) {
        const value = () => props.cell.remainingPercent
        const color = () =>
          props.selected ? theme().accent : theme().textMuted
        const state = () =>
          props.cell.refreshState === 'refreshing'
            ? ' · refreshing'
            : props.cell.refreshState === 'error'
              ? ' · refresh failed'
              : props.cell.refreshState === 'unavailable'
                ? ' · unavailable'
                : ''
        return (
          <box flexDirection='column'>
            <text fg={color()}>
              {props.selected ? '› ' : '  '}
              {props.label}: {value() === null ? '—' : `${value()}%`}
              {state()}
            </text>
            <For each={props.cell.windows}>
              {(window) => (
                <text fg={theme().textMuted}>
                  {'    '}
                  {window.name === 'weekly' ? 'Weekly' : '5h'}{' '}
                  {window.remainingPercent === null
                    ? '—'
                    : `${window.remainingPercent}%`}
                  {window.resetAt !== undefined
                    ? ` · ${relative(window.resetAt - Date.now())}`
                    : ''}
                </text>
              )}
            </For>
            <text fg={theme().textMuted}>
              {'    '}
              {props.cell.source === 'live' ? 'Live' : 'Cached'}
              {props.cell.updatedAt !== undefined
                ? ` ${relative(Date.now() - props.cell.updatedAt)} ago`
                : ''}
            </text>
          </box>
        )
      }

      function Sidebar(props: { sessionID: string }) {
        const [model, setModel] = createSignal<
          { providerID: string; id: string } | undefined
        >()
        const [data, setData] = createSignal<SidebarQuotaSnapshot>()
        const [notice, setNotice] = createSignal<string>()
        const [sessionNotice, setSessionNotice] = createSignal<string>()
        let active = false
        let generation = 0
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

        async function request(mode: 'cache' | 'ensure', current: number) {
          if (requestInFlight === current) return
          requestInFlight = current
          try {
            const result = await rpc.sidebarQuota({ mode })
            if (current !== generation || !active) return
            setData(result)
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

        async function load(current: number) {
          await request('cache', current)
          if (current === generation && active) await request('ensure', current)
        }

        function activate() {
          if (active) return
          active = true
          const current = ++generation
          void load(current)
          timer = setInterval(() => {
            void request('ensure', current)
          }, 15_000)
        }

        function deactivate() {
          if (!active) return
          active = false
          generation++
          stop()
        }

        createEffect(() => {
          const selected = model()
          if (isAntigravityModel(selected)) activate()
          else deactivate()
        })

        createEffect(() => {
          const sessionID = props.sessionID
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
            generation++
            active = false
            stop()
            unsubscribe()
          })
          readModel(sessionID)
          void sessionData.session
            .sync(sessionID)
            .then(() => {
              if (props.sessionID === sessionID) {
                readModel(sessionID)
                setSessionNotice(undefined)
              }
            })
            .catch(() => {
              if (props.sessionID === sessionID)
                setSessionNotice(
                  'Could not load the selected session model yet.',
                )
            })
        })

        const group = () => quotaGroupForAntigravityModel(model())
        return (
          <Show when={group()}>
            {(selectedGroup) => (
              <box flexDirection='column' paddingX={1} paddingY={1}>
                <text fg={theme().accent}>Antigravity quota</text>
                <text fg={theme().textMuted}>
                  All accounts · automatic updates while this model is selected
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
                    {(account) => (
                      <box
                        flexDirection='column'
                        marginTop={1}
                        paddingX={1}
                        border
                        borderStyle='single'
                        borderColor={theme().borderSubtle}
                      >
                        <box flexDirection='row'>
                          <text fg={theme().text}>{account.label}</text>
                          <text
                            fg={
                              account.state === 'active'
                                ? theme().success
                                : theme().warning
                            }
                          >
                            {'  '}
                            {account.state === 'verification-required'
                              ? 'VERIFY'
                              : account.state.toUpperCase()}
                          </text>
                          <Show when={account.current !== 'none'}>
                            <text fg={theme().success}> Default</text>
                          </Show>
                        </box>
                        <SidebarQuotaCell
                          label='Gemini'
                          cell={account.gemini}
                          selected={selectedGroup() === 'gemini'}
                        />
                        <SidebarQuotaCell
                          label='Claude / other'
                          cell={account.nonGemini}
                          selected={selectedGroup() === 'non-gemini'}
                        />
                      </box>
                    )}
                  </For>
                </Show>
                <Show when={notice()}>
                  {(value) => <text fg={theme().warning}>{value()}</text>}
                </Show>
                <Show when={sessionNotice()}>
                  {(value) => <text fg={theme().warning}>{value()}</text>}
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
                {operationId() ? ' · OAUTH IN PROGRESS' : ''}
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
        stopPolling()
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

function relative(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h${minutes % 60 ? `${minutes % 60}m` : ''}`
  return `${Math.floor(hours / 24)}d`
}

export default tui
