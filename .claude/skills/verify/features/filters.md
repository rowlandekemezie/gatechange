# Filter the board

The headline sentence is the filter: "Show me VP, head of engineering, director and engineering manager roles that are remote in Canada, remote in the US, in Vancouver and BC ... posted in the last week, with the most relevant first." Each phrase is a chip that toggles or selects a filter.

## Sub-features

- `filter-role` toggles `VP`, `head of engineering`, `director`, and `engineering manager`.
- `filter-region` toggles `remote in Canada`, `remote in the US`, `in Vancouver and BC`, `elsewhere in Canada`, `on-site in the US`, and `anywhere else`.
- `filter-age` selects one of `day`, `3 days`, `week`, `2 weeks`, or `month`.
- `filter-sort` selects `most relevant` or `newest`.
- `filter-none` shows an empty state when no role or no region is selected.

## How to get to it (user POV)

- Click a chip in the headline. A selected chip has a filled background and `aria-pressed="true"`.

## Driving it with drive.ts

Preconditions:

- `doctor.sh <stage>` prints four `ok` lines.

- **Age.** Run `drive.ts --url <url> --out <dir> --scenario filter`. It clicks `day`. The JSON shows the count drop from the week view, for example `65 roles match` to `17 roles match`, and no more rows (a page holds 15).
- **Region or role.** Not scripted yet. Copy the `filter` action, click a chip such as `anywhere else`, and require the count to change.
- **Sort.** Not scripted yet. Click `newest` and require the first row's age to be the newest in the list.

## Gotchas

- Region chips map to several stored regions. `remote in Canada` includes remote North America and remote global roles.
- Turning off every role or every region shows the empty state, not zero rows with a count.
- Filters live in the page state only. Reloading resets them.
