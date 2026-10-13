/**
 * The bridge to `dsh-connect-workbuddy`.
 *
 * ## Why the import is lazy
 *
 * This plugin is useless without the base plugin, but it must still MOUNT
 * without it. A top-level `import 'dsh-connect-workbuddy'` would turn a missing
 * dependency into "the plugin failed to load", which tells the user nothing:
 * the entry disappears and the only symptom is silence.
 *
 * Importing inside an async function instead means the plugin mounts, its
 * settings card renders, and a run reports
 * "dsh-connect-workbuddy is not installed" — a message the user can act on.
 * It also keeps this package's own tests runnable without the base plugin.
 *
 * ## Why the exports are used rather than the HTTP routes
 *
 * The base plugin exposes a local route (`/plugins/dsh-connect-workbuddy/checkin`)
 * that does the status-then-claim dance for ONE account. Going through it would
 * mean trusting an HTTP contract that exists for the browser half, and would
 * not cover multiple accounts in one run.
 *
 * The classes are the honest dependency: `WorkBuddyCredentialStore` owns the
 * per-platform auth discovery and token refresh, and `WorkBuddyUpstreamClient`
 * owns the two billing endpoints. Both are documented as importable without a
 * cordis context, which is exactly what this plugin needs.
 *
 * @module dsh-connect-workbuddy-autocheckin/base
 */

import type { CheckinStatus, WorkBuddyCredentialLike } from './checkin.ts'

/** The region the reward exists in. The international app has no equivalent. */
export const CHECKIN_REGION = 'cn'

/** The result of resolving the base plugin. */
export type BasePlugin =
  | { ok: true, store: BaseStore, client: BaseClient }
  | { ok: false, reason: string }

/** The parts of the base plugin's credential store this plugin calls. */
export interface BaseStore {
  accounts(): Promise<readonly { id: string, accountName: string }[]>
  credentialFor(accountId: string): Promise<WorkBuddyCredentialLike | undefined>
}

/** The parts of the base plugin's upstream client this plugin calls. */
export interface BaseClient {
  fetchCheckinStatus(credential: WorkBuddyCredentialLike): Promise<CheckinStatus>
  claimDailyCheckin(
    credential: WorkBuddyCredentialLike,
  ): Promise<{ credit: number, streakDays: number, isStreakDay: boolean }>
}

/**
 * Resolve the base plugin's exports.
 *
 * Returns a discriminated result rather than throwing, because "the base plugin
 * is missing" is an ordinary state on a machine where the user has not
 * installed it yet, not an error condition to crash on.
 */
export async function loadBasePlugin(options: { authFile?: string } = {}): Promise<BasePlugin> {
  let mod: Record<string, unknown>
  try {
    mod = await import('dsh-connect-workbuddy') as Record<string, unknown>
  } catch (error: unknown) {
    // Deliberately does not claim "not installed": the same failure also
    // happens when the package IS installed but this plugin is being loaded
    // outside a DSH host (the base plugin's own imports need Host peers), or
    // from a directory Node cannot resolve it from. Reporting the underlying
    // error lets the user tell those apart instead of chasing the wrong one.
    return {
      ok: false,
      reason:
        'cannot load dsh-connect-workbuddy (is it installed in this profile?): '
        + messageOf(error),
    }
  }

  const StoreCtor = mod['WorkBuddyCredentialStore'] as
    | (new (options: Record<string, unknown>) => BaseStore)
    | undefined
  const ClientCtor = mod['WorkBuddyUpstreamClient'] as
    | (new (onFallback?: (message: string) => void) => BaseClient)
    | undefined

  if (typeof StoreCtor !== 'function' || typeof ClientCtor !== 'function') {
    // A base plugin that loaded but does not export these is a version
    // mismatch, and saying so is far more useful than a TypeError later.
    return {
      ok: false,
      reason:
        'dsh-connect-workbuddy is installed but does not export '
        + 'WorkBuddyCredentialStore/WorkBuddyUpstreamClient (expected >= 3.0.0)',
    }
  }

  const store = new StoreCtor({
    region: CHECKIN_REGION,
    // Spread rather than assign: the base plugin documents an absent
    // `desktopPath` as "use the platform default", which is a different thing
    // from an explicit `undefined` under exactOptionalPropertyTypes.
    ...options.authFile === undefined ? {} : { desktopPath: options.authFile },
  })

  return { ok: true, store, client: new ClientCtor() }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
