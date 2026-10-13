/**
 * WorkBuddy automatic daily check-in.
 *
 * A small, headless companion to `dsh-connect-workbuddy`: it claims the CN
 * daily check-in reward once a day, for every locally signed-in account, with
 * no button press.
 *
 * ## Why a separate plugin
 *
 * The base plugin is third-party (MIT, dingminhua) and updated often. Patching
 * its `lib/` in place would be lost on the next `pnpm update`, and forking it
 * means re-merging every upstream release. A companion plugin that IMPORTS its
 * public exports survives both: upstream can change freely underneath, and this
 * package only breaks if the exports it names actually go away — which it
 * reports as a clear message rather than a crash (`src/base.ts`).
 *
 * ## What it does NOT do
 *
 * - It does not register a model provider, touch the base plugin's config, or
 *   render UI. It is headless and owns exactly one thing: the daily timer.
 * - It does not reimplement auth or HTTP. Both come from the base plugin.
 * - It does not handle the international (`workbuddy.ai`) region: only the CN
 *   app runs a check-in reward, which is why `runCheckin` is scoped to `cn`.
 *
 * @module dsh-connect-workbuddy-autocheckin
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CHECKIN_REGION, loadBasePlugin } from './base.ts'
import type { BaseClient, BaseStore } from './base.ts'
import {
  createCheckinScheduler,
  localDayKey,
  runCheckin,
  type CheckinRow,
  type CheckinScheduler,
} from './checkin.ts'

/** Stable Cordis plugin name. */
export const name = 'dsh-connect-workbuddy-autocheckin'

/**
 * Services required before this plugin can run.
 *
 * Deliberately minimal: this plugin serves no models and renders no UI, so it
 * needs no `llm`. `settings` is optional-by-design — the scheduler works
 * without a settings card, which is why it is read through `ctx.get` rather
 * than injected as a hard dependency.
 */
export const inject = []

/** Plugin configuration. */
export interface Config {
  /** Master switch. Off means no timer is ever created. */
  enabled?: boolean
  /**
   * Explicit WorkBuddy auth file, overriding the platform default.
   *
   * Passed straight to the base plugin's credential store, which owns the
   * per-platform discovery rules. Rarely needed; exists for machines where the
   * app is installed somewhere unusual.
   */
  authFile?: string
  /**
   * Account ids to check in. Empty means EVERY locally signed-in account.
   *
   * Inverted from the base plugin's pool, where empty means "nobody": here the
   * plugin's own `enabled` flag is the opt-in, so a user who turns it on and
   * configures nothing else still gets the behaviour they asked for.
   */
  accountIds?: string[]
  /**
   * Run once shortly after startup, in addition to the daily timer.
   *
   * On by default. Without it, a machine that is shut down before the hourly
   * tick ever lands would never check in; with it, launching DSH performs the
   * day's claim immediately. The once-per-day guard is what makes this safe.
   */
  checkOnStart?: boolean
}

/**
 * Let the settings service own this instance's presentation.
 *
 * `auto: true` asks for the automatic settings page. Registered through an
 * effect so the disposer is tied to this plugin's lifetime rather than leaked.
 */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false).description(
    'Claim the WorkBuddy CN daily check-in reward automatically, once a day (opt-in). '
    + 'Runs the same claim the plugin card\'s button does, with no button press.',
  ),
  authFile: z.string().description(
    'WorkBuddy desktop auth file (defaults to the app\'s own location)',
  ),
  accountIds: z.array(z.string()).default([]).description(
    'Account ids to check in; empty means every locally signed-in account',
  ),
  checkOnStart: z.boolean().default(true).description(
    'Also claim on startup, so a short-lived session still covers the day '
    + '(the once-per-day guard makes this safe)',
  ),
})

/**
 * Mount the plugin.
 *
 * The base plugin is resolved once, lazily, and reported through the logger if
 * missing. The scheduler is created either way, so a user who installs the base
 * plugin later only has to re-enable this one rather than restart the host.
 */
export function apply(ctx: Context, config: Config): void {
  const log = (message: string): void => ctx.logger.info(`${name}: ${message}`)

  const enabled = (): boolean => config.enabled === true
  const accountIds = (): readonly string[] => config.accountIds ?? []

  /** Resolved base plugin handles, or the reason they are unavailable. */
  let base: { store: BaseStore, client: BaseClient } | undefined
  let baseFailure: string | undefined

  /** Resolve (once) the base plugin, logging the reason on failure. */
  const ensureBase = async (): Promise<{ store: BaseStore, client: BaseClient } | undefined> => {
    if (base !== undefined) return base
    const resolved = await loadBasePlugin(
      config.authFile === undefined ? {} : { authFile: config.authFile },
    )
    if (!resolved.ok) {
      // Logged once per resolution attempt, and the scheduler reports the run
      // as failed rather than silently succeeding with nothing to do.
      baseFailure = resolved.reason
      return undefined
    }
    base = { store: resolved.store, client: resolved.client }
    baseFailure = undefined
    return base
  }

  const scheduler: CheckinScheduler = createCheckinScheduler({
    enabled,
    log,
    run: async (): Promise<CheckinRow[]> => {
      const handles = await ensureBase()
      if (handles === undefined) {
        log(`cannot check in: ${baseFailure ?? 'base plugin unavailable'}`)
        return []
      }
      return runCheckin({
        accounts: () => handles.store.accounts(),
        credentialFor: id => handles.store.credentialFor(id),
        fetchCheckinStatus: credential => handles.client.fetchCheckinStatus(credential),
        claimDailyCheckin: credential => handles.client.claimDailyCheckin(credential),
        memberIds: accountIds,
        log,
      })
    },
  })

  // Arm on mount. `rearm` is idempotent while a timer is live, and the
  // scheduler reads `enabled` live, so this is also the re-arm path after a
  // settings write — no reload needed.
  ctx.effect(() => {
    if (config.checkOnStart !== false && enabled()) {
      // Fire and forget: a startup claim must not block mounting, and the
      // scheduler already reduces every failure to a log line.
      void scheduler.check().catch(() => undefined)
    }
    scheduler.rearm()
    return () => scheduler.stop()
  })

  // Re-arm whenever this entry's settings change: turning the switch on must
  // start the timer without a restart, and turning it off must stop it.
  //
  // `settings/document-updated` is the catalogued event for "one profile
  // entry's form values changed" — the base plugin listens on an internal
  // Loader event instead, which is not part of the public catalog and would be
  // a fragile thing to depend on from another plugin.
  ctx.on('settings/document-updated', () => {
    if (enabled()) scheduler.rearm()
    else scheduler.stop()
  })
}

/**
 * Exposed for the CLI and tests.
 *
 * `localDayKey` is re-exported so a caller can reason about the guard without
 * importing the internals module directly.
 */
export { localDayKey, runCheckin, createCheckinScheduler, CHECKIN_REGION }
export type { CheckinRow, CheckinScheduler }
