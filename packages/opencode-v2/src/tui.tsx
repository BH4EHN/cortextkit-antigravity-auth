import type { Definition } from '@opencode-ai/plugin/tui/plugin'
import { createRoot, createSignal, For, Show } from 'solid-js'
import type {
  AntigravityPanelSnapshot,
  PanelAccountRow,
  PanelQuotaCell,
} from './commands.ts'

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
