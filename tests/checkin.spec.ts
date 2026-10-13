/**
 * The check-in engine and its scheduler.
 *
 * Everything is injected: no network, no auth file, no real timer. The
 * assertions are about the DECISIONS (which accounts, claim or not, how often),
 * because those are the parts that can silently do the wrong thing on a real
 * machine — claiming twice, skipping an account, or firing after being turned
 * off.
 */

import { describe, expect, it } from 'vitest'
import {
  ACCOUNT_GAP_MS,
  INITIAL_DELAY_MS,
  INTERVAL_MS,
  createCheckinScheduler,
  localDayKey,
  runCheckin,
  type CheckinAccount,
  type CheckinRow,
  type CheckinStatus,
  type WorkBuddyCredentialLike,
} from '../src/checkin.ts'

const CREDENTIAL: WorkBuddyCredentialLike = { accessToken: 't', domain: 'codebuddy.cn', uid: 'u1' }

const ACTIVE_UNCLAIMED: CheckinStatus = {
  active: true,
  todayCheckedIn: false,
  streakDays: 0,
  dailyCredit: 5,
  todayCredit: 0,
}

const ACTIVE_CLAIMED: CheckinStatus = { ...ACTIVE_UNCLAIMED, todayCheckedIn: true, streakDays: 3 }
const INACTIVE: CheckinStatus = { ...ACTIVE_UNCLAIMED, active: false }

/** A fake Host: accounts, credentials, status per account, and call counts. */
function engine (options: {
  accounts?: CheckinAccount[]
  status?: Record<string, CheckinStatus>
  claim?: { credit: number, streakDays: number, isStreakDay: boolean }
  memberIds?: string[]
  failClaimFor?: string
  failStatusFor?: string
  missingCredentialFor?: string
} = {}) {
  const accounts = options.accounts ?? [
    { id: 'a', accountName: 'Account A' },
    { id: 'b', accountName: 'Account B' },
  ]
  const calls = { status: [] as string[], claim: [] as string[], waits: [] as number[] }

  return {
    calls,
    deps: {
      accounts: async () => accounts,
      credentialFor: async (id: string) => {
        if (id === options.missingCredentialFor) return undefined
        return { ...CREDENTIAL, uid: id }
      },
      fetchCheckinStatus: async (credential: WorkBuddyCredentialLike) => {
        calls.status.push(credential.uid)
        if (credential.uid === options.failStatusFor) throw new Error('status exploded')
        return options.status?.[credential.uid] ?? ACTIVE_UNCLAIMED
      },
      claimDailyCheckin: async (credential: WorkBuddyCredentialLike) => {
        calls.claim.push(credential.uid)
        if (credential.uid === options.failClaimFor) throw new Error('claim exploded')
        return options.claim ?? { credit: 5, streakDays: 1, isStreakDay: false }
      },
      memberIds: () => options.memberIds ?? [],
      log: () => {},
      wait: async (ms: number) => { calls.waits.push(ms) },
    },
  }
}

describe('localDayKey', () => {
  it('uses the local calendar day rather than the UTC one', () => {
    // 00:30 local on Jan 1 is the previous day in UTC for an eastern zone.
    // Reading UTC would report a day as handled before it began.
    const local = new Date(2026, 0, 1, 0, 30, 0).getTime()
    expect(localDayKey(local)).toBe('2026-01-01')
  })
})

describe('runCheckin', () => {
  it('claims every unclaimed account and reports the credits', async () => {
    const h = engine()
    const rows = await runCheckin(h.deps)
    expect(rows.map(r => r.status)).toEqual(['claimed', 'claimed'])
    expect(rows[0]?.credit).toBe(5)
    expect(h.calls.claim).toEqual(['a', 'b'])
  })

  it('never claims an account the upstream says is already checked in', async () => {
    const h = engine({ status: { a: ACTIVE_CLAIMED } })
    const rows = await runCheckin(h.deps)
    expect(rows[0]).toMatchObject({ accountId: 'a', status: 'already', streakDays: 3 })
    expect(h.calls.claim).toEqual(['b'])
  })

  it('reports an inactive reward as its own state, not a failure', async () => {
    const h = engine({ status: { a: INACTIVE } })
    const rows = await runCheckin(h.deps)
    expect(rows[0]?.status).toBe('inactive')
    expect(h.calls.claim).toEqual(['b'])
  })

  it('keeps going when one account fails, and names the reason', async () => {
    const h = engine({ failClaimFor: 'a' })
    const rows = await runCheckin(h.deps)
    expect(rows[0]).toMatchObject({ accountId: 'a', status: 'failed', message: 'claim exploded' })
    expect(rows[1]).toMatchObject({ accountId: 'b', status: 'claimed' })
  })

  it('reports a missing credential rather than throwing', async () => {
    const h = engine({ missingCredentialFor: 'a' })
    const rows = await runCheckin(h.deps)
    expect(rows[0]).toMatchObject({ status: 'failed', message: 'no stored credential for this account' })
  })

  it('covers EVERY local account when no membership list is configured', async () => {
    const h = engine()
    const rows = await runCheckin(h.deps)
    expect(rows).toHaveLength(2)
  })

  it('narrows to the configured accounts when a list is given', async () => {
    const h = engine({ memberIds: ['b'] })
    const rows = await runCheckin(h.deps)
    expect(rows.map(r => r.accountId)).toEqual(['b'])
    expect(h.calls.status).toEqual(['b'])
  })

  it('pauses between accounts but not before the first', async () => {
    const h = engine()
    await runCheckin(h.deps)
    expect(h.calls.waits).toEqual([ACCOUNT_GAP_MS])
  })

  it('never asks for a credential before the day is known to be unclaimed', async () => {
    // Ordering matters: reading status first means a claim is only ever issued
    // against a live credential whose reward is genuinely outstanding. Account
    // `a` is already checked in, so it must never appear in the claim calls.
    const h = engine({ status: { a: ACTIVE_CLAIMED } })
    await runCheckin(h.deps)
    expect(h.calls.status[0]).toBe('a')
    expect(h.calls.claim.includes('a')).toBe(false)
  })

  it('returns no rows when there are no accounts', async () => {
    const h = engine({ accounts: [] })
    expect(await runCheckin(h.deps)).toEqual([])
  })
})

/** A controllable clock and timers, plus the scheduler wired to them. */
function schedulerHarness (options: { enabled?: boolean, rows?: CheckinRow[], fail?: boolean } = {}) {
  let clock = new Date(2026, 0, 5, 10, 0, 0).getTime()
  const timers: { handler: () => void, ms: number, cancelled: boolean }[] = []
  const logs: string[] = []
  let runs = 0

  const scheduler = createCheckinScheduler({
    enabled: () => options.enabled ?? true,
    run: async () => {
      runs += 1
      if (options.fail === true) throw new Error('boom')
      return options.rows ?? []
    },
    log: message => logs.push(message),
    now: () => clock,
    setTimeout: (handler, ms) => {
      const timer = { handler, ms, cancelled: false }
      timers.push(timer)
      return timer
    },
    clearTimeout: handle => { (handle as { cancelled: boolean }).cancelled = true },
  })

  return {
    scheduler,
    logs,
    get runs () { return runs },
    live: () => timers.filter(t => !t.cancelled),
    fire () {
      const timer = timers.find(t => !t.cancelled)
      if (timer === undefined) throw new Error('no live timer')
      timer.cancelled = true
      timer.handler()
    },
    advanceDays: (days: number) => { clock += days * 24 * 60 * 60 * 1000 },
  }
}

// Let every queued promise continuation run.
//
// Two microtask drains plus a macrotask: the scheduler chains
// `run().then(() => arm())`, so one drain is not always enough, and the timer
// turn is where a `setTimeout(0)` edge would land. Written without
// `setImmediate` because that is an OS handle some sandboxes refuse.
const settle = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('createCheckinScheduler', () => {
  it('schedules nothing while disabled', () => {
    const h = schedulerHarness({ enabled: false })
    h.scheduler.rearm()
    expect(h.live()).toHaveLength(0)
    expect(h.runs).toBe(0)
  })

  it('uses the startup grace period, then the hourly interval', async () => {
    const h = schedulerHarness()
    h.scheduler.rearm()
    expect(h.live()[0]?.ms).toBe(INITIAL_DELAY_MS)
    h.fire()
    await settle()
    expect(h.runs).toBe(1)
    expect(h.live()[0]?.ms).toBe(INTERVAL_MS)
  })

  it('runs at most once per local day', async () => {
    const h = schedulerHarness()
    h.scheduler.rearm()
    h.fire()
    await settle()
    expect(h.runs).toBe(1)

    // A second tick on the SAME local day must be refused by the guard, so the
    // upstream is not asked to re-claim a reward it already granted.
    h.fire()
    await settle()
    expect(h.runs).toBe(1)

    h.advanceDays(1)
    h.fire()
    await settle()
    expect(h.runs).toBe(2)
  })

  it('swallows a throwing run instead of rejecting inside a timer', async () => {
    const h = schedulerHarness({ fail: true })
    h.scheduler.rearm()
    h.fire()
    await settle()
    expect(h.logs.some(line => line.includes('failed'))).toBe(true)
    expect(h.runs).toBe(1)
  })

  it('stops, stays stopped, and can be rearmed', () => {
    const h = schedulerHarness()
    h.scheduler.rearm()
    expect(h.live()).toHaveLength(1)
    h.scheduler.stop()
    expect(h.live()).toHaveLength(0)
    h.scheduler.stop()
    expect(h.live()).toHaveLength(0)
    h.scheduler.rearm()
    expect(h.live()).toHaveLength(1)
  })

  it('rearms idempotently without stacking timers', () => {
    const h = schedulerHarness()
    h.scheduler.rearm()
    h.scheduler.rearm()
    expect(h.live()).toHaveLength(1)
  })

  it('lets the manual check bypass the daily guard', async () => {
    const rows: CheckinRow[] = [{ accountId: 'a', accountName: 'A', status: 'claimed', credit: 5 }]
    const h = schedulerHarness({ rows })
    expect((await h.scheduler.check())[0]?.status).toBe('claimed')
    expect((await h.scheduler.check())[0]?.status).toBe('claimed')
    expect(h.runs).toBe(2)
  })

  it('logs a summary naming the claimed and failed counts', async () => {
    const h = schedulerHarness({
      rows: [
        { accountId: 'a', accountName: 'A', status: 'claimed', credit: 4 },
        { accountId: 'b', accountName: 'B', status: 'already' },
        { accountId: 'c', accountName: 'C', status: 'failed', message: 'nope' },
      ],
    })
    h.scheduler.rearm()
    h.fire()
    await settle()
    expect(h.logs.some(l => l.includes('1 claimed (+4)') && l.includes('1 already'))).toBe(true)
    expect(h.logs.some(l => l.includes('check-in failed for C'))).toBe(true)
  })

  it('says so when there is nobody to check in', async () => {
    const h = schedulerHarness({ rows: [] })
    h.scheduler.rearm()
    h.fire()
    await settle()
    expect(h.logs.some(l => l.includes('no accounts'))).toBe(true)
  })

  it('records the automatic day, so a later caller can explain the guard', async () => {
    const h = schedulerHarness()
    expect(h.scheduler.lastAutoDay()).toBeUndefined()
    h.scheduler.rearm()
    h.fire()
    await settle()
    expect(h.scheduler.lastAutoDay()).toBe('2026-01-05')
  })
})
