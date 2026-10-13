/**
 * The check-in engine: read one region's accounts, ask each whether today is
 * already claimed, and claim it if not.
 *
 * ## Why this imports the base plugin
 *
 * `dsh-connect-workbuddy` already owns the hard parts: locating the desktop
 * auth file on three platforms, decrypting `$wbEncrypted` fields through the
 * installed app, refreshing tokens, and knowing the two billing endpoints.
 * Re-implementing any of that here would duplicate a moving target and would
 * break the moment WorkBuddy changes its `X-*` header conventions.
 *
 * So this module imports the base plugin's PUBLIC exports
 * (`WorkBuddyCredentialStore`, `WorkBuddyUpstreamClient`) and adds only what
 * the base plugin does not do: running that check on a schedule, for every
 * account, guarded to once per local day.
 *
 * ## The contract, as established by the base plugin
 *
 * - status: `POST {billingBase}/v2/billing/meter/checkin-activity-status`
 * - claim:  `POST {billingBase}/v2/billing/meter/daily-checkin`
 *
 * Both are methods on `WorkBuddyUpstreamClient`; this module never builds a URL
 * itself, so a change to either endpoint is the base plugin's business.
 *
 * ## Safety properties
 *
 * 1. **Never claims twice in one local day, per account.** The upstream claim is
 *    idempotent, so a second call is harmless but wasteful; the guard avoids it.
 * 2. **Status is always re-read before claiming.** `todayCheckedIn` is the
 *    authority, never local bookkeeping alone — a claim made from another
 *    machine (or the phone app) must not be duplicated here.
 * 3. **Never throws.** Every failure becomes a row, so one bad account cannot
 *    hide the state of the others (same rule as the base plugin's batch).
 * 4. **Never resolves the region's selection.** `credentialFor(id)` is used
 *    rather than `resolve()`, so checking account B in never changes which
 *    account is billing the user's live traffic.
 *
 * @module dsh-connect-workbuddy-autocheckin/checkin
 */

/**
 * The subset of the base plugin this module depends on.
 *
 * Declared structurally rather than by importing the base plugin's types, so
 * this file compiles (and its tests run) without `dsh-connect-workbuddy`
 * installed. The runtime import is resolved lazily in `loadBasePlugin`, which
 * is what lets the plugin mount, explain itself, and report a useful error on a
 * machine where the base plugin is missing — instead of failing to load.
 */
export interface WorkBuddyCredentialLike {
  accessToken: string
  domain: string
  uid: string
  enterpriseId?: string
  nickname?: string
}

/** Status of the CN daily check-in activity for one credential. */
export interface CheckinStatus {
  active: boolean
  todayCheckedIn: boolean
  streakDays: number
  dailyCredit: number
  todayCredit: number
  claimButtonText?: string
}

/** Result of a successful claim. */
export interface CheckinClaim {
  credit: number
  streakDays: number
  isStreakDay: boolean
}

/** One account as the engine addresses it. */
export interface CheckinAccount {
  id: string
  accountName: string
}

/** One account's outcome, for the log line and the CLI. */
export interface CheckinRow {
  accountId: string
  accountName: string
  status: 'claimed' | 'already' | 'failed' | 'inactive'
  /** Credits gained, when the upstream stated a figure. */
  credit?: number
  /** Streak length after the claim, when the upstream stated one. */
  streakDays?: number
  /** Why it failed. Never contains a token. */
  message?: string
}

/**
 * What the engine needs from the base plugin.
 *
 * An interface rather than the concrete classes so the tests inject fakes and
 * the plugin's behaviour is asserted without a network or a real auth file.
 */
export interface CheckinEngineDeps {
  /** Every locally stored account, in the user's saved order. */
  accounts(): Promise<readonly CheckinAccount[]>
  /** The stored credential for one account, WITHOUT changing the selection. */
  credentialFor(accountId: string): Promise<WorkBuddyCredentialLike | undefined>
  /** Today's check-in state; a read, never a write. */
  fetchCheckinStatus(credential: WorkBuddyCredentialLike): Promise<CheckinStatus>
  /** Claim today's reward. Called only when the status says it is unclaimed. */
  claimDailyCheckin(credential: WorkBuddyCredentialLike): Promise<CheckinClaim>
  /** Which account ids to act on. Empty means "everybody found locally". */
  memberIds(): readonly string[]
  /** One log line. */
  log(message: string): void
  /** Pause between accounts; injected so tests do not wait. */
  wait?: (ms: number) => Promise<void>
}

/**
 * Gap between accounts inside one run.
 *
 * Deliberately small. Both endpoints are cheap reads/writes with no measured
 * rate limit, and the value exists only to avoid firing N requests back to
 * back — politeness, not a workaround.
 */
export const ACCOUNT_GAP_MS = 400

/**
 * Run the check-in for every account, one at a time.
 *
 * Never throws: a failure on one account is recorded on that row and the run
 * continues. The caller gets rows it can log or print regardless of outcome.
 */
export async function runCheckin(deps: CheckinEngineDeps): Promise<CheckinRow[]> {
  const all = await deps.accounts()
  const wanted = new Set(deps.memberIds())
  // An empty membership list means "everybody found locally" rather than
  // "nobody": this plugin's own switch is the opt-in, so a user who turns it on
  // without also configuring the base plugin's pool still gets checked in.
  const targets = wanted.size === 0 ? all : all.filter(account => wanted.has(account.id))

  const rows: CheckinRow[] = []
  for (const [index, account] of targets.entries()) {
    if (index > 0) await (deps.wait ?? defaultWait)(ACCOUNT_GAP_MS)
    rows.push(await checkinAccount(account, deps))
  }
  return rows
}

/** One account's check-in, reduced to its row. */
async function checkinAccount(
  account: CheckinAccount,
  deps: CheckinEngineDeps,
): Promise<CheckinRow> {
  const base = { accountId: account.id, accountName: account.accountName }

  let credential: WorkBuddyCredentialLike | undefined
  try {
    credential = await deps.credentialFor(account.id)
  } catch (error: unknown) {
    return { ...base, status: 'failed', message: messageOf(error) }
  }
  if (credential === undefined) {
    return { ...base, status: 'failed', message: 'no stored credential for this account' }
  }

  try {
    const status = await deps.fetchCheckinStatus(credential)
    // `active: false` is not a failure: the upstream is telling us the reward
    // programme is off for this account, which is a state to report plainly
    // rather than retry.
    if (!status.active) return { ...base, status: 'inactive' }
    // The upstream is the authority on "today", not our own last-run memory: a
    // check-in made from the phone app or another machine must not be repeated.
    if (status.todayCheckedIn) {
      return { ...base, status: 'already', streakDays: status.streakDays }
    }
    const claim = await deps.claimDailyCheckin(credential)
    return {
      ...base,
      status: 'claimed',
      credit: claim.credit,
      streakDays: claim.streakDays,
    }
  } catch (error: unknown) {
    return { ...base, status: 'failed', message: messageOf(error) }
  }
}

/**
 * Local calendar day as `YYYY-MM-DD`.
 *
 * Built from LOCAL getters, not `toISOString()`. The UTC form reports the
 * previous day for anyone east of Greenwich until 08:00 local, which would mark
 * a day handled before it began and skip the real check-in.
 */
export function localDayKey(nowMs: number): string {
  const date = new Date(nowMs)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** How long after start the first run happens, letting the host finish booting. */
export const INITIAL_DELAY_MS = 30_000

/**
 * Gap between runs.
 *
 * One hour rather than 24h. The once-per-day guard does the real work, and an
 * hourly check means a machine that was asleep at the intended moment still
 * checks in soon after waking — and a DST shift, which moves local midnight,
 * cannot skip a day.
 */
export const INTERVAL_MS = 60 * 60 * 1000

/**
 * A running auto check-in loop.
 *
 * `rearm` is idempotent while a timer is live and reads {@link SchedulerDeps.enabled}
 * live, so a settings change takes effect without reloading the plugin.
 */
export interface CheckinScheduler {
  /** Cancel every pending run. Safe to call more than once. */
  stop(): void
  /** Start the loop if it is not running and the feature is enabled. */
  rearm(): void
  /** Run one check now, regardless of the schedule or the daily guard. */
  check(): Promise<CheckinRow[]>
  /** The last result, or undefined when none has run. */
  last(): readonly CheckinRow[] | undefined
  /** Local day of the last AUTOMATIC run, or undefined. */
  lastAutoDay(): string | undefined
}

/** What the scheduler needs. */
export interface SchedulerDeps {
  /** Whether the feature is on. Read live on every decision. */
  enabled(): boolean
  /** Run the check-in. Expected to resolve to rows and never throw. */
  run(): Promise<CheckinRow[]>
  /** One log line. */
  log(message: string): void
  /** Current time. */
  now?(): number
  /** Timer primitives, injected so tests drive time. */
  setTimeout?(handler: () => void, ms: number): unknown
  clearTimeout?(handle: unknown): void
}

/**
 * Create the scheduler.
 *
 * Inert until {@link CheckinScheduler.rearm} is called, so the caller decides
 * when the grace period starts.
 */
export function createCheckinScheduler(deps: SchedulerDeps): CheckinScheduler {
  const now = deps.now ?? Date.now
  const schedule = deps.setTimeout ?? ((handler: () => void, ms: number) => setTimeout(handler, ms))
  const unschedule = deps.clearTimeout
    ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))

  let lastAutoDay: string | undefined
  let lastRows: readonly CheckinRow[] | undefined
  let handle: unknown
  let running = false
  let stopped = false

  const clear = (): void => {
    if (handle !== undefined) {
      unschedule(handle)
      handle = undefined
    }
  }

  /** The guarded automatic run: once per local day. */
  const autoRun = async (): Promise<void> => {
    const day = localDayKey(now())
    if (day === lastAutoDay) return
    // Recorded BEFORE the await: two runs must not interleave across it and
    // both observe an unclaimed day.
    lastAutoDay = day
    try {
      lastRows = await deps.run()
    } catch (error: unknown) {
      // A rejection escaping a timer callback is an unhandled rejection in
      // Node, which can take the host down. `run` should not throw; this is
      // the belt to that braces.
      deps.log(`check-in run failed: ${messageOf(error)}`)
      return
    }
    logRows(lastRows, deps)
  }

  const arm = (): void => {
    clear()
    if (stopped) return
    if (!deps.enabled()) return
    handle = schedule(() => {
      handle = undefined
      void autoRun().then(() => arm())
    }, INTERVAL_MS)
  }

  return {
    stop(): void {
      stopped = true
      // Cleared so `rearm` can resume: `running` means "a timer is live", not
      // "has ever been started". Leaving it set would make the loop
      // permanently unresumable after a stop.
      running = false
      clear()
    },
    rearm(): void {
      stopped = false
      if (running) return
      // Gated HERE, not only in the callback: a disabled feature must own no
      // timer at all, or the handle would outlive the explanation for it.
      if (!deps.enabled()) return
      running = true
      handle = schedule(() => {
        handle = undefined
        if (stopped) return
        if (!deps.enabled()) {
          running = false
          return
        }
        void autoRun().then(() => arm())
      }, INITIAL_DELAY_MS)
    },
    async check(): Promise<CheckinRow[]> {
      // Deliberately ignores the daily guard: this is the manual path (the CLI
      // and the explicit "check now" action), and a user asking for it means it.
      const rows = await deps.run()
      lastRows = rows
      return [...rows]
    },
    last(): readonly CheckinRow[] | undefined {
      return lastRows
    },
    lastAutoDay(): string | undefined {
      return lastAutoDay
    },
  }
}

/** One summary line per run, naming what actually happened. */
function logRows(rows: readonly CheckinRow[], deps: SchedulerDeps): void {
  const claimed = rows.filter(row => row.status === 'claimed')
  const already = rows.filter(row => row.status === 'already')
  const failed = rows.filter(row => row.status === 'failed')
  if (rows.length === 0) {
    deps.log('check-in: no accounts to act on')
    return
  }
  const credit = claimed.reduce((total, row) => total + (row.credit ?? 0), 0)
  deps.log(
    `check-in: ${claimed.length} claimed (+${credit}), ${already.length} already, ${failed.length} failed`,
  )
  for (const row of failed) {
    deps.log(`check-in failed for ${row.accountName || row.accountId}: ${row.message ?? 'unknown'}`)
  }
}

function defaultWait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
