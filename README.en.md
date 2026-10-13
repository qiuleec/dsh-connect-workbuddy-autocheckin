<p align="center">
  <b>Automatically claim the WorkBuddy CN daily check-in reward</b><br>
  <sub>自动领取 WorkBuddy 国内版每日签到奖励</sub>
</p>

<p align="center">
  <a href="README.md">中文</a> ·
  <a href="#install">Install</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#cli">CLI</a> ·
  <a href="#known-limits">Known limits</a>
</p>

---

# dsh-connect-workbuddy-autocheckin

Automatically claim the **WorkBuddy CN daily check-in reward**, once a day, for
every locally signed-in account — without pressing the button.

A headless companion plugin for
[`dsh-connect-workbuddy`](https://github.com/dingminhua/dsh-connect-workbuddy).

## Why a separate plugin

`dsh-connect-workbuddy` is third-party and updated often. Two alternatives were
rejected:

| Approach | Why not |
| --- | --- |
| Patch its `lib/` in place | Lost on the next `pnpm update` |
| Fork it | Re-merge every upstream release, forever |

This plugin instead **imports the base plugin's public exports** and adds only
the scheduling that the base plugin deliberately leaves to the user. Upstream
can change freely underneath: this package breaks only if the exports it names
actually disappear, and it then reports that as a readable message rather than a
stack trace (see `src/base.ts`).

## What it reuses vs. what it adds

**Reused from the base plugin** (never reimplemented here):

- per-platform auth-file discovery (macOS / Windows / Linux)
- `$wbEncrypted` credential decryption through the installed app
- token refresh
- both billing endpoints:
  - status: `POST {billingBase}/v2/billing/meter/checkin-activity-status`
  - claim: `POST {billingBase}/v2/billing/meter/daily-checkin`

**Added here:**

- the daily timer, and the once-per-local-day guard
- multi-account iteration (`credentialFor` per account, never `resolve`, so the
  account billing your live traffic is never silently switched)
- a CLI to test the whole chain without waiting for a schedule

## Install

Requires `dsh-connect-workbuddy` **>= 3.0.0** to be installed in the same
profile. This plugin does not provide model access on its own.

```sh
dsh plugin --profile desktop add github:qiuleec/dsh-connect-workbuddy-autocheckin
```

Then open **Settings → Plugins → dsh-connect-workbuddy-autocheckin** and turn on
**enabled**.

It is **off by default**: it is the only thing in either plugin that grants a
real reward with no user action, so it must be asked for.

> Recommended first run: `status --json` (read-only, grants nothing) to confirm
> the chain works on your machine before enabling the timer.

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Master switch. Off means no timer is ever created. |
| `authFile` | *(platform default)* | Explicit WorkBuddy auth file. Rarely needed. |
| `accountIds` | `[]` | Accounts to check in. **Empty means every local account.** |
| `checkOnStart` | `true` | Also claim on startup, so a short-lived session still covers the day. |

`accountIds` is deliberately **inverted** from the base plugin's pool, where
empty means "nobody". There, membership guards an action that spends credits;
here the plugin's own `enabled` flag is the opt-in, so a user who turns it on
and configures nothing else gets what they asked for.

## Timing

| | |
| --- | --- |
| First run | 30 s after mount |
| Interval | hourly |
| Guard | at most one **automatic** run per local calendar day |

The interval is hourly rather than 24-hourly on purpose. The guard does the real
work, and an hourly check means a machine asleep at the intended moment still
checks in soon after waking — and a DST shift, which moves local midnight, cannot
skip a day.

The day key is built from LOCAL getters, not `toISOString()`: the UTC form
reports yesterday for anyone east of Greenwich until 08:00, which would mark the
day handled before it began and skip the real check-in.

## CLI

```sh
# Read-only: shows today's status per account. Never claims.
dsh plugin --profile desktop exec dsh-connect-workbuddy-autocheckin status

# Claims now, bypassing the once-per-day guard (a manual request means it).
dsh plugin --profile desktop exec dsh-connect-workbuddy-autocheckin checkin

# Reports whether the base plugin resolves.
dsh plugin --profile desktop exec dsh-connect-workbuddy-autocheckin doctor
```

All three accept `--json`, plus `--auth-file <path>` and repeated
`--account <id>`.

Recommended first run: **`status --json`**. It exercises the whole chain (auth
discovery → decryption → the status endpoint) without granting anything, so you
can confirm the contract on your machine before letting the timer claim.

## Behaviour on failure

- A failure on **one account** is recorded on that account's row; the run
  continues. One bad account cannot hide the state of the others.
- `active: false` is reported as **`inactive`**, not `failed` — the reward
  programme being off is a state, not an error to retry.
- `todayCheckedIn: true` is **`already`**, and no claim is sent. The upstream is
  the authority on "today", so a check-in made from the phone app or another
  machine is never duplicated.
- The base plugin missing is reported as a log line, not a crash.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success (`status` is read-only and always succeeds) |
| `1` | The base plugin is unavailable, or at least one account failed |

## Development

```sh
pnpm install
pnpm run check     # typecheck + test + build
```

Tests inject the clock, the timers, and the whole Host surface, so the suite never
touches the network, an auth file, or a real timer.

## Known limits

- **CN only.** Only the CN app runs a check-in reward; the international
  (`workbuddy.ai`) region has no equivalent, so this plugin does not address it.
- **Depends on the base plugin's exports by name.** If `WorkBuddyCredentialStore`
  or `WorkBuddyUpstreamClient` is renamed, this plugin needs a matching update.
  `doctor` says so explicitly.
- **The upstream contract is unofficial.** Like the base plugin, this relies on
  WorkBuddy's app-facing endpoints, which can change without notice.

## Disclaimer

This plugin is intended for personal study and research, to automate the daily
check-in of your own accounts. Please comply with WorkBuddy's terms of service;
you are responsible for any consequences of using it.

This project is not affiliated with Tencent, WorkBuddy, or DeepSeek.

## Licence

MIT
