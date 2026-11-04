# Browse the board

The board opens on the freshest, most relevant leadership roles in the home regions, grouped by day, with a stats line about the whole board and a button to load more.

## Sub-features

- `board-load` shows at least 10 rows and the line `<n> roles match`.
- `board-stats` shows `<n> live roles, <m> new today` beside the count line and when the board last refreshed.
- `board-groups` groups rows under day headings such as `Today` and `Yesterday`.
- `board-row` shows title, company, location, salary when known, the source, the age, and `New` for jobs first seen in the last day.
- `board-more` shows `Show <n> more of <m> remaining` when more than 40 roles match, and loads the next page.
- `board-error` shows an alert with `Try again` when the backend fails.

## How to get to it (user POV)

- Open the site root. The `Roles` header link is current.

## Driving it with drive.ts

Preconditions:

- `doctor.sh <stage>` prints four `ok` lines.

- **First load.** Run `drive.ts --url <url> --out <dir> --scenario board --full-page`. The JSON has `ok: true`, `rows` of 40, and a `count` like `65 roles match`. The screenshot shows rows under day headings.
- **Phone layout.** Add `--mobile`. The PNG is 1170 pixels wide and the headline wraps without horizontal scroll.
- **Dark mode.** Add `--dark`. The JSON `background` reads near black and the screenshot is dark.
- **Load more.** Not scripted yet. Add an action that clicks the `button.more` whose text starts with `Show`, then require `.board .departure` to exceed 15.
- **Backend failure.** Stop the stage with `down.sh` mid-drive. `verify.sh` prints `FAIL alchemy dev for stage <stage> exited during the run`.

## Gotchas

- The seed rewrites ages relative to now, so day headings depend on when you seed. Seed again before a run that checks headings.
- The stats line counts every row in D1, live rows included.
- `New` depends on `first_seen_at`, which the seed sets equal to `posted_at`.
