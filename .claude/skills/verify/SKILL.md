---
name: verify
description: Boot the jobs.rowlandekemezie.com board locally with alchemy dev, seed its local D1 from recorded fixtures, drive the Foldkit board in headless Chrome, and save screenshots. Use to prove any change a person can see on the board, such as filters, search, the shortlist, layout, or dark mode, before calling it done.
---

# Verify the job board

The board is a Foldkit web app served by the `Website` Worker, which forwards `/rpc` to the `JobsBackend` Worker over a local D1. This skill runs the real stack through `alchemy dev` on a stage you name, fills D1 with 100 recorded company-board listings, and drives the page in headless Chrome over the DevTools protocol. It needs no network for the board itself and adds no dependencies. It needs Node 24.18 (for `node:sqlite` and TypeScript stripping), pnpm 11.3 through `mise`, `curl`, `lsof`, and Google Chrome or Chromium.

Every script takes the stage name first. Use a stage nobody else uses, such as `verify-lane-3` or `verify-j7-owner`. `lib.sh` refuses any stage that is not `verify-` followed by lowercase letters, digits, and dashes, and any name containing `prod` or `staging` in any case, before it runs any command. Run state lives in `/tmp/verify-jobs/<stage>/` (`dev.log`, `pid`, `url`).

## Quick run

```sh
S=.claude/skills/verify/scripts
VERIFY_OUT=/tmp/swarm-J7/worker-1 $S/verify.sh verify-lane-1 --scenario board --full-page --name verify-cold
$S/down.sh verify-lane-1
```

`verify.sh` runs launch, seed, doctor, and one drive, then prints `PASS in <n>s from start to screenshot` or a `FAIL` line and exits non-zero. A run on a new stage took 25 seconds in a fresh clone after `pnpm install`, and 10 to 17 seconds once the build was cached. Run it again on the same stage and it reuses the running `alchemy dev`.

## Launch

`scripts/up.sh <stage>` first runs `turbo run build --filter=@rat-stack/infra...`, because `alchemy dev` imports the workspace packages' `dist` output and a fresh checkout has none. Turbo's cache makes this a no-op on later runs. It then starts `mise exec node@24.18.0 pnpm@11.3.0 -- pnpm alchemy dev --stage <stage> --no-input` in the background and waits for the line `{ websiteUrl: 'http://localhost:<port>' }` in `dev.log`. It writes the URL to `/tmp/verify-jobs/<stage>/url` and prints it.

- The first free port from 1337 goes to whichever Worker starts first. `alchemy dev` moves the other one up and logs `Port 1337 is in use by another process; serving on 1338 instead`. `up.sh` echoes that note. Always read the URL from `up.sh`, never assume a port.
- If `alchemy dev` exits during boot, `up.sh` prints the last 20 log lines and exits 1. If it logs `alchemy dev: run failed`, it stays alive waiting for a file change, so `up.sh` prints the error and exits 1, and you run `down.sh`. The boot timeout is 150 seconds, or `VERIFY_BOOT_TIMEOUT`.
- If the stage is already running and its URL answers 200, `up.sh` reuses it. A recorded pid counts as running only while `ps` shows it as `alchemy dev --stage <stage> --no-input`, so a stale pid that the system gave to another process is ignored.
- `alchemy dev` reads and writes stage rows in the Cloudflare state store of the active Alchemy profile (`ALCHEMY_PROFILE`, or `default`). The rows are stamped `local`, but the store itself is a Worker on that account. `alchemy dev` plans with `updateStateStore` on (`Cli/exec.ts` in alchemy), so when that Worker is missing or older than the installed alchemy, as after an alchemy bump, `up.sh` deploys or upgrades it without asking, exactly as `pnpm dev` does.

`lib.sh` exports a throwaway `BETTER_AUTH_SECRET` when the shell has none, because `JobsBackend` refuses to start without one and `down.sh` evaluates the same stack.

One checkout runs one stage at a time, and `up.sh` refuses to start a second. Every stage keeps its D1 as a SQLite file in `apps/infra/.alchemy/local/d1/cloudflare-runtime-D1DatabaseObject/`. `up.sh` records the file the stage created in `/tmp/verify-jobs/<stage>/d1`, and the seed, doctor, and teardown use that path. To run lanes side by side, give each lane its own worktree.

## Seed

`scripts/seed.sh <stage>` loads `fixtures/jobs.json` into the running stage's local D1 with `node:sqlite`. It deletes rows whose feed starts with `fixture:`, inserts the 100 fixture jobs, and checks the count. Running it again gives the same 100 rows. Live rows from other feeds stay.

- Fixture feed keys carry the `fixture:` prefix. `runIngest` replaces rows per feed key, so a cron run never deletes or overwrites a fixture row.
- The fixture stores each job's age in hours, already divided by four, and the seed sets `posted_at` to now minus that age. About 92 of the 100 jobs fall inside the board's default 7-day window, and about 17 inside the 1-day window.
- The fixtures hold only Greenhouse, Lever, and Ashby listings, which are the companies' own public postings. Aggregator listings stay out because their terms limit redistribution.
- `packages/job-store/test/verify-seed.test.ts` loads the fixture into sql.js with the real migrations and checks the row count, idempotence, and that live rows survive.

To refresh the fixtures, boot a stage, trigger live ingest runs through the dev cron hook (several runs, since each run takes 20 feeds), then record:

```sh
curl "$(cat /tmp/verify-jobs/<stage>/backend-url)/cdn-cgi/handler/scheduled?cron=*/20+*+*+*+*"
mise exec node@24.18.0 -- node .claude/skills/verify/scripts/record-fixtures.ts --db "$(cat /tmp/verify-jobs/<stage>/d1)"
```

Recording reads live public job boards, so do it by hand and commit the result. Never record during a verification run. If the fixture count changes, update `FIXTURE_JOBS` in the seed test.

## Doctor

`scripts/doctor.sh <stage>` is read-only. Run it first whenever anything looks off. It prints one `ok` or `FAIL` line per check and exits 1 on any failure:

- `alchemy dev` for the stage is running.
- The Website answers 200 at the recorded URL.
- The port is held by a process this stage started, not someone else's server.
- The local D1 holds every fixture job.

## Drive

`scripts/drive.ts` launches headless Chrome with a throwaway profile, so `localStorage` starts empty, sends a random `cf-connecting-ip` on requests to the board's own origin so each run gets its own better-auth rate-limit bucket (other origins, such as Google Fonts, get no extra header), and drives the page over the DevTools protocol with Node's built-in `WebSocket`. It waits for at least `--min-rows` job rows (default 10; the board shows 15 rows per page) and fails as soon as the board shows its error alert.

```sh
mise exec node@24.18.0 -- node .claude/skills/verify/scripts/drive.ts \
  --url "$(cat /tmp/verify-jobs/<stage>/url)" --out <dir> --scenario <name> [--mobile] [--dark] [--full-page] [--name <slug>]
```

Scenarios:

- `board` loads the board and screenshots it.
- `filter` clicks the `day` age chip and requires the count line and the row count to drop. Every chip click needs a visible chip, so on `--mobile` the scenario opens the `Filters` panel first and fails if that does not reveal it.
- `filter-steady` clicks the `day` age chip and fails if the board leaves the page at any point before the new rows arrive.
- `search` types the first row's company into the search box, submits, and requires every row to show that company.
- `shortlist` saves the first row (the `Save` icon button on desktop; on `--mobile` the row's `Save` text button on its job page, because the row's buttons are hidden on a phone), opens the `Shortlist (n)` header link, and requires `Saved (1)` with that job's title, plus one `localStorage` key.
- `signin` clicks the header's `Sign in` link, submits `--email` (default `verify@example.com`), waits for the check-your-email notice, opens the newest `/account/confirm` link in `apps/infra/.alchemy/local/email/text/` (where `alchemy dev` writes outgoing mail), requires the page to name the account, presses `Finish signing in`, and requires the header to show the email.
- `signout` runs `signin`, presses `Sign out`, reloads, and requires the header to say `Sign in`.
- `link-reuse` runs `signout`, opens the same link again, and requires the refused-link notice with no address on the page and the viewer still signed out.
- `link-budget` needs a stage booted with `MAGIC_LINK_DAILY_SEND_LIMIT=5`, so new addresses get 2 sends. It signs in as `--email`, signs out, spends the second new-address send, requires the next new address to be refused, and requires `--email` to sign in again.
- `confirm-other-account` mails a link for `other-<--email>`, signs in as `--email`, opens the first link, and requires a warning naming both addresses with the header unchanged. It saves the warning as `<name>-warning.png`, then presses `Switch to <address>` and requires the header to show that address.
- `confirm-retry` mails a link for `--email`, opens it with the preview request blocked, requires the failed-check notice, saves it as `<name>-failed.png`, unblocks, presses `Check this link again`, and requires the sign-in to finish.
- `bad-email` submits `not-an-email` and requires an inline `role=alert` error with no new file in the mail outbox.
- `tracker-import` presses `Save` on the first two rows and `Applied` on the third while signed out, then signs in. It requires a `.import-offer` prompt that names `--email` and `3 jobs` while the tracker is still empty and the `jobs.shortlist.v1` key is still set. It saves the prompt as `<name>-prompt.png`, then presses `Move them` and requires all three in the tracker exactly once with the key gone. Run it twice with the same `--email` to prove a second import adds nothing.
- `tracker-import-decline` saves the same three rows, signs in, presses `Keep them in this browser`, and requires the prompt gone, the tracker empty, and all three titles still in the `jobs.shortlist.v1` key.
- `tracker-list` signs in and reports the tracker's sections and titles. Run it with the same `--email` as another drive to act as a second browser.
- `tracker-stages` signs in, saves the first row if the tracker is empty, and moves the first card through Applied, Offer, Rejected, Saved, and Interviewing, reloading after each move. It fails if the page scrolls sideways.
- `tracker-note` signs in, writes a note on the first card, reloads, and requires the note.
- `tracker-remove` signs in, removes the first card, reloads, and requires it gone.
- `tracker-closed` signs in and requires at least one card with the closed-posting note. Delete that job's row from the stage's local D1 first.
- `tracker-gone` signs in, opens the first closed card, and requires the job page to show the saved title and a link to the original posting. Set that job's `departed_at` in the stage's local D1 first.
- `tracker-isolation` calls `/rpc` signed out and requires `Unauthorized`, then signs in as `--email` and calls `trackedJobs`, `noteTrackedJob`, and `untrackJob` with `--victim-job`, another member's tracked job id. It fails if that id comes back. It then reads the session cookie over the DevTools protocol and replays it from Node: a `trackJob` with `sec-fetch-site: cross-site` and a foreign `Origin` must answer 403, and a `trackedJobs` with the same cookie and same-origin headers must answer as a member, which proves the refusal came from the cross-site guard. Read the victim's row from the local D1 afterwards to prove it did not change.

- `pricing` opens `/pricing` and requires three plan cards with their prices and no sideways scroll. Add `--mobile` for the phone check.
- `free-gate` signs in as a Free member, turns on `Only roles that state a salary`, and requires the upgrade prompt with the same row count and count line as before, so a Free member never loses listings.

Saved-search digest scenarios take `--backend "$(cat /tmp/verify-jobs/<stage>/backend-url)"` and `--log /tmp/verify-jobs/<stage>/dev.log`. They sign in as `--email` first, so give each run its own address: a member gets at most one digest a week, and a second run with the same address sends nothing. The digest cron is fired through the backend's `/cdn-cgi/handler/scheduled?cron=7+*+*+*+*&time=<ms>` route, and a digest counts when `dev.log` shows `alchemy dev` handing one to `--email`.

- `save-search` presses `Email me new matches weekly` under the board search (after typing `--search` when given), waits for the saved notice, and requires the search on `/account`.
- `digest` saves, fires the cron, requires `--expect-digests` (default 1) new digests, and when one arrived opens its HTML and requires no sideways scroll. Add `--mobile` for the phone check.
- `no-double-send` saves, fires the cron twice for the same moment and once three hours later, and requires exactly one digest.
- `unsubscribe` opens the emailed unsubscribe link on the stage, presses `Unsubscribe`, requires `You are unsubscribed`, and requires no digest a week later.
- `digest-links` opens every job link in the digest on the stage and requires each job page to load.
- `delete-search` deletes the saved search on `/account` and requires no digest from the next run.

Flags:

- `--mobile` emulates a 390 by 844 phone at 3x, so the PNG is 1170 pixels wide.
- `--dark` sets `prefers-color-scheme: dark`. The report's `background` field shows the body color, so a dark run reads near black.
- `--full-page` captures the whole page instead of the viewport.

The handles come from `apps/web/src/features/board/view.ts`, `apps/web/src/features/job/view.ts`, `apps/web/src/client/board/marks.ts`, and `apps/web/src/client/board/view.ts`: `.board .departure` rows (`a.departure-tiles`, `.role-title`, `.cell-company`), `p.count` for the match count, `.status` for the board stats line, `button.phrase` chips by text (`day`, `3 days`, `week`, `remote in Canada`, `director`, and so on), `form.search input`, `.departure button.mark[aria-label="Save"|"Applied"]` for the desktop icon buttons and `.detail-actions button.mark` for the text buttons on a job page, `a.nav-link` for `Roles` and `Shortlist (n)`, `a.nav-account` for `Sign in` or the email, and `.empty[role=alert]` for the load error. To add a scenario, add an entry to `actions` in `drive.ts` that clicks through these handles and throws when the end state is wrong.

`drive.ts` prints one JSON line. On success it has `ok: true`, each step's row count and count text, and the screenshot path, and exits 0. On failure it has `ok: false`, a `reason`, and a `<name>-failed.png` screenshot when Chrome can still take one, and exits 1. Bad arguments exit 2.

## Evidence

Screenshots go to `--out`, which `drive.ts` requires. `verify.sh` passes `VERIFY_OUT`, or `/tmp/verify-jobs/<stage>/shots/` when it is unset, and `down.sh` names the same directory as it finishes. A failed drive saves `<name>-failed.png` there instead of `<name>.png`, showing the page at the moment the scenario failed. Swarm lanes save to `/tmp/swarm-<pr>/worker-<n>/<slug>.png`.

A proof drives the page the way a person does: chips, the search box, and buttons. It never calls `/rpc` directly or writes UI state into `localStorage`. Keep the JSON line with the screenshot, since it records the action and the state after it. For a change that writes data, also read the local D1 after the drive with `node:sqlite`. The stage's database is the file named in `/tmp/verify-jobs/<stage>/d1`, and `seed-local-d1.ts --check` shows how to open it read-only.

## Cleanup

`scripts/down.sh <stage>` stops the processes this stage started and nothing else. It signals the recorded pid only while `ps` still shows it as this stage's `alchemy dev`, then its descendants, and before the final `SIGKILL` it re-checks that each pid still runs the command it ran when listed. A pid that now runs a different command is reported and left alone. A pid that has exited, which macOS `ps` shows as a zombie or as a parenthesized name such as `(node)`, is skipped without a report.

alchemy dev starts a sidecar (`Local/Sidecar.js`) in its own process group, so killing the dev process group leaves the sidecar and its children running. While `up.sh` boots a stage, it starts a fresh `procs` file in the run dir and records each process in the stage's tree whose command line contains this checkout's path, with its start time and command line. `down.sh` also stops each recorded pid whose start time and command both still match, and its descendants, even after alchemy dev itself has died, so a reused pid is left alone; it deletes `procs` right after the final `SIGKILL`. It never matches processes by name, so another checkout's alchemy processes are not touched.

`alchemy destroy` has no local mode. It loads the stage's rows from the same Cloudflare state store `alchemy dev` used and deletes each resource with the provider of the mode stamped on its row, so a `live` row would delete a real Cloudflare resource. `down.sh` therefore lists the stage with `alchemy state ls` and pipes each row through `scripts/local-only-state.ts`, which fails unless the row carries `providerMode: "local"`. For a `replacing` or `replaced` row, every older generation in its `old` chain must carry it too. An `updating` row's `old` holds only the previous props and attributes, so the row's own mode decides, and a status it does not recognize fails. The check proves each resource was reconciled by a local-mode provider, not that the stage left nothing in the cloud. A resource wrapped in `Alchemy.remote()` runs live in dev and is stamped `live`, and a mode-agnostic provider (`providerForMode` in alchemy's `Provider.ts`) runs its one live implementation in dev and writes no mode. Both rows are refused, so such a stage stops `down.sh` instead of being destroyed. Today's stack writes three rows, the two Workers and the D1 database, all from dual-mode providers and stamped `local`. One row that is not local, or a state store it cannot read, stops `down.sh` before `alchemy destroy` runs. Those reads run without `--yes`, so they fail instead of upgrading an out-of-date state store, and a store they can read is current, so the `--yes` that `destroy` needs in a non-interactive shell has no upgrade left to approve. A stage with no rows skips `alchemy destroy`.

`alchemy destroy` then deletes the local Workers and D1, which stops their local runtime, and removes their rows from the state store. `up.sh` and `down.sh` run alchemy with `DOCKER_CONFIG` pointing at an empty directory. The local Cloudflare runtime's Docker layer (`src/core/Docker.ts` in `@alchemy.run/cloudflare-runtime`) runs `docker image inspect` on start and `docker pull` of the `cloudflare/proxy-everything` egress image when it is missing, even for a stack with no containers. With the default Docker config, that pull waits on `docker-credential-desktop` while Docker Desktop is not running. `destroy` never exited, and under `dev` the hung pull outlived a crashed alchemy dev. With the empty config the pull fails at once. Last, `down.sh` removes the stage's D1 file, which `alchemy destroy` leaves on disk. The output and `destroy.log` list each step. Screenshots in `VERIFY_OUT` or `shots/` stay. Always run `down.sh` after a lane, including after a failure.

## Failure modes

- `alchemy dev exited before the Website was ready`: read the log tail. A stale stage often clears with `down.sh` then `up.sh`.
- `FAIL alchemy dev for stage <stage> exited during the run`: the dev server died mid-drive. `verify.sh` reports it even when the drive passed.
- `board shows an error`: the RPC call failed. Check `dev.log` and `apps/infra/.alchemy/log/<stage>/JobsBackend`.
- `timed out waiting for at least 10 job rows`: the seed did not reach this stage's D1. Run `doctor.sh`.
- `cannot tell which local D1 belongs to stage`: an old stage left its D1 file behind. Run `down.sh` on the old stage, or boot under a new stage name.
- `refusing stage '<stage>'`: the name is not `verify-<name>`, or it contains `prod` or `staging`. Nothing ran.
- `refusing to destroy stage <stage>: <row> is not a local alchemy dev resource`: the stage holds a row a deploy wrote. Stop and ask the owner; never remove it from a verify run.

## Feature map

`features/README.md` lists every user-facing feature and how to drive it. Keep it current with `/maintain-verification-skill`.
