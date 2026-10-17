# Job board verification map

This directory is the maintained source for verifying what a person sees on the job board. Read this index before driving the board, then use the matching feature file as the recipe.

## Baseline preconditions

- Boot a `verify-<name>` stage only this run uses with `scripts/up.sh <stage>` and seed it with `scripts/seed.sh <stage>`, or run both through `scripts/verify.sh`.
- Run `scripts/doctor.sh <stage>` and require four `ok` lines.
- The board holds the 100 fixture jobs. A stage that also ran live ingest holds more, so assert relative changes, not exact totals.
- Never drive a stage this run did not start.

## Driving conventions

- Every drive starts from a fresh Chrome profile, so the shortlist starts empty and the filters start at their defaults: every role, the three home regions (`remote in Canada`, `remote in the US`, `in Vancouver and BC`), the last `week`, and `most relevant` first.
- Find controls by their visible text: chips are `button.phrase`, tabs are `nav.tabs button.tab`, row buttons are `li.job button.mark`.
- Wait for the count line `p.count` to change, not for a fixed time.
- Restore nothing by hand. `down.sh` removes the stage, and a new drive gets a new browser profile.

## Proof and skip reporting

- Keep the JSON line `drive.ts` prints next to the screenshot. It records the state before and after the action.
- A screenshot alone does not prove a filter. The row count and count text must change in the JSON.
- Report a scenario you could not run with the command and the reason. Do not report it as passed through another path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the behavior. It then has four H2 sections in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with drive.ts`, and `Gotchas`.

## Features

- [Browse the board](./board.md) covers the first load, the stats line, day groups, and loading more.
- [Filter the board](./filters.md) covers the role, region, age, and sort chips in the headline sentence.
- [Search](./search.md) covers the search box by company, title, or city.
- [Shortlist](./shortlist.md) covers Save, Applied, the shortlist tab, and removal.
