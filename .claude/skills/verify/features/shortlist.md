# Shortlist

A person marks roles as Saved or Applied. The `Your shortlist (n)` tab lists them in two sections. The shortlist lives in the browser's `localStorage` and never leaves the device.

## Sub-features

- `shortlist-save` marks a role Saved, and its button reads `Saved`.
- `shortlist-applied` marks a role Applied and gives its row the `job-applied` class.
- `shortlist-tab` lists marks under `Saved (n)` and `Applied (n)`.
- `shortlist-remove` removes a mark from the shortlist tab.
- `shortlist-empty` explains the shortlist when nothing is marked.
- `shortlist-persist` keeps marks across reloads in the same browser.

## How to get to it (user POV)

- Press `Save` or `Applied` on a row, then open the `Your shortlist (n)` tab.

## Driving it with drive.ts

Preconditions:

- `doctor.sh <stage>` prints four `ok` lines.

- **Save.** Run `drive.ts --url <url> --out <dir> --scenario shortlist`. It presses `Save` on the first row and opens the tab. The JSON shows `heading: "Saved (1)"`, that row's title in `titles`, and `localStorageKeys: 1`.
- **Applied, remove, persist.** Not scripted yet. Add actions that press `Applied`, `Remove`, or reload the page, and check the section headings after each.

## Gotchas

- Each drive uses a fresh Chrome profile, so marks never carry over between runs.
- The `Save` button text changes to `Saved` once pressed. Match buttons by the text before the click.
