/**
 * Command line for the auto check-in plugin.
 *
 * The point of these commands is to make the feature TESTABLE without waiting
 * for a schedule: `checkin` claims now, and `status` reports what the guard
 * thinks the current day is. Both work from a plain shell, outside the GUI,
 * which is the only way to confirm the upstream contract on a real machine.
 *
 * Usage (from the profile directory):
 *
 *   dsh plugin --profile desktop exec dsh-connect-workbuddy-autocheckin status
 *   dsh plugin --profile desktop exec dsh-connect-workbuddy-autocheckin checkin
 *   dsh plugin --profile desktop exec dsh-connect-workbuddy-autocheckin doctor
 *
 * `--json` prints machine-readable output.
 *
 * @module dsh-connect-workbuddy-autocheckin/bin
 */

import { CHECKIN_REGION, loadBasePlugin } from './base.ts'
import { localDayKey, runCheckin, type CheckinRow } from './checkin.ts'

/** Exit code for a run in which at least one account failed. */
const EXIT_FAILURE = 1

interface Args {
  command: string
  json: boolean
  authFile?: string
  accountIds: string[]
}

/** Parse argv. Hand-rolled to keep the package dependency-free. */
function parseArgs(argv: readonly string[]): Args {
  const args: Args = { command: argv[0] ?? 'status', json: false, accountIds: [] }
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--json') {
      args.json = true
    } else if (token === '--auth-file') {
      const value = argv[i + 1]
      if (value === undefined) throw new Error('--auth-file requires a path')
      args.authFile = value
      i += 1
    } else if (token === '--account') {
      const value = argv[i + 1]
      if (value === undefined) throw new Error('--account requires an account id')
      args.accountIds.push(value)
      i += 1
    } else {
      throw new Error(`unknown option: ${token}`)
    }
  }
  return args
}

/** Build the engine deps from the base plugin, or explain why we cannot. */
async function depsFor(args: Args) {
  const base = await loadBasePlugin(args.authFile === undefined ? {} : { authFile: args.authFile })
  if (!base.ok) return { ok: false as const, reason: base.reason }
  return {
    ok: true as const,
    deps: {
      accounts: () => base.store.accounts(),
      credentialFor: (id: string) => base.store.credentialFor(id),
      fetchCheckinStatus: (credential: Parameters<typeof base.client.fetchCheckinStatus>[0]) =>
        base.client.fetchCheckinStatus(credential),
      claimDailyCheckin: (credential: Parameters<typeof base.client.claimDailyCheckin>[0]) =>
        base.client.claimDailyCheckin(credential),
      memberIds: () => args.accountIds,
      log: (message: string) => { if (!args.json) console.log(message) },
    },
  }
}

function printRows(rows: readonly CheckinRow[], json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ rows }, null, 2))
    return
  }
  if (rows.length === 0) {
    console.log('no accounts found')
    return
  }
  for (const row of rows) {
    const label = row.accountName === '' ? row.accountId : row.accountName
    const extra = row.status === 'claimed'
      ? ` +${row.credit ?? 0} credits (streak ${row.streakDays ?? 0})`
      : row.status === 'already'
        ? ` (streak ${row.streakDays ?? 0})`
        : row.message === undefined ? '' : `: ${row.message}`
    console.log(`${row.status.padEnd(8)} ${label}${extra}`)
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))

  if (args.command === 'help' || args.command === '--help' || args.command === '-h') {
    console.log('commands: status | checkin | doctor')
    return 0
  }

  if (args.command === 'doctor') {
    const base = await loadBasePlugin(args.authFile === undefined ? {} : { authFile: args.authFile })
    const report = {
      region: CHECKIN_REGION,
      today: localDayKey(Date.now()),
      basePlugin: base.ok ? 'available' : base.reason,
    }
    if (args.json) console.log(JSON.stringify(report, null, 2))
    else {
      console.log(`region    : ${report.region}`)
      console.log(`today     : ${report.today}`)
      console.log(`base      : ${report.basePlugin}`)
    }
    return base.ok ? 0 : EXIT_FAILURE
  }

  const resolved = await depsFor(args)
  if (!resolved.ok) {
    // A missing base plugin is the single most likely reason this command is
    // run at all, so it is reported plainly rather than as a stack trace.
    if (args.json) console.log(JSON.stringify({ error: resolved.reason }, null, 2))
    else console.error(`error: ${resolved.reason}`)
    return EXIT_FAILURE
  }

  if (args.command === 'status') {
    // A read-only look: status per account, and NEVER a claim. `runCheckin` is
    // not used here precisely because it claims.
    const accounts = await resolved.deps.accounts()
    const wanted = new Set(args.accountIds)
    const targets = wanted.size === 0 ? accounts : accounts.filter(a => wanted.has(a.id))
    const report = []
    for (const account of targets) {
      const credential = await resolved.deps.credentialFor(account.id)
      if (credential === undefined) {
        report.push({ accountId: account.id, accountName: account.accountName, error: 'no credential' })
        continue
      }
      try {
        const status = await resolved.deps.fetchCheckinStatus(credential)
        report.push({
          accountId: account.id,
          accountName: account.accountName,
          active: status.active,
          todayCheckedIn: status.todayCheckedIn,
          streakDays: status.streakDays,
          todayCredit: status.todayCredit,
        })
      } catch (error: unknown) {
        report.push({
          accountId: account.id,
          accountName: account.accountName,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    if (args.json) console.log(JSON.stringify({ today: localDayKey(Date.now()), accounts: report }, null, 2))
    else {
      for (const entry of report) {
        const label = entry.accountName === '' ? entry.accountId : entry.accountName
        if ('error' in entry) console.log(`unknown  ${label}: ${entry.error}`)
        else {
          console.log(
            `${entry.todayCheckedIn ? 'checked' : 'pending'}  ${label}`
            + ` (active=${entry.active}, streak=${entry.streakDays}, today=${entry.todayCredit})`,
          )
        }
      }
    }
    return 0
  }

  if (args.command === 'checkin') {
    const rows = await runCheckin(resolved.deps)
    printRows(rows, args.json)
    return rows.some(row => row.status === 'failed') ? EXIT_FAILURE : 0
  }

  console.error(`error: unknown command: ${args.command}`)
  return EXIT_FAILURE
}

main()
  .then(code => { process.exitCode = code })
  .catch((error: unknown) => {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = EXIT_FAILURE
  })
