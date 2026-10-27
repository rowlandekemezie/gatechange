# Shortlist

A person marks roles as Saved or Applied. Signed out, the `Shortlist (n)` header link lists them in two sections from the browser's `localStorage`. Signed in, the same tab shows the account's tracker: a pipeline of five stages and a card per job with a stage picker, notes, dates, and a closed-posting note. On sign-in with a browser list, a prompt names the signed-in email and asks before it moves the list into the account. Declining keeps the list in the browser.

## Sub-features

- `shortlist-save` marks a role Saved, and its button reads `Saved`.
- `shortlist-applied` marks a role Applied and gives its row the `job-applied` class.
- `shortlist-tab` lists marks under `Saved (n)` and `Applied (n)`.
- `shortlist-remove` removes a mark from the shortlist tab.
- `shortlist-empty` explains the shortlist when nothing is marked.
- `shortlist-persist` keeps marks across reloads in the same browser.

## How to get to it (user POV)

- Press the `Save` or `Applied` icon on a row (desktop) or the text button on the job page (phone), then open `Shortlist (n)` in the header.

## Driving it with drive.ts

Preconditions:

- `doctor.sh <stage>` prints four `ok` lines.

- **Save.** Run `drive.ts --url <url> --out <dir> --scenario shortlist`. It saves the first row and opens the shortlist. The JSON shows `heading: "Saved (1)"`, that row's title in `titles`, and `localStorageKeys: 1`.
- **Tracker.** The `tracker-*` scenarios in `SKILL.md` drive the import prompt (move and keep), stages, notes, removal, the closed-posting note, and isolation, including a cross-site replay of the session cookie.
- **Applied, remove, persist (signed out).** Not scripted yet. Add actions that press `Applied`, `Remove`, or reload the page, and check the section headings after each.

## Gotchas

- Each drive uses a fresh Chrome profile, so marks never carry over between runs.
- The `Save` button text changes to `Saved` once pressed. Match buttons by the text before the click.
