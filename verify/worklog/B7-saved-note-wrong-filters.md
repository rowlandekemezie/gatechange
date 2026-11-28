# B7: "Saved" shows under filters that were never saved

## The bug

You press "Email me new matches weekly" on the board. While it saves, you change a filter, for example you turn off "director". When the save finishes, the board says "Saved. We email new matches…" under the new filters, which you never saved.

## How we found it

The TLA+ model `verify/tla/client-saved-searches` lets filters change while a save is in flight. TLC broke SavedNoteIsTrue: the note said Saved while the filters on screen differed from the ones saved. The Vitest replay sends ClickedSaveSearch, ToggledRole and CompletedSaveSearch to the real `update` and ends in `SaveState.Saved`. Playwright held the `saveSearch` request, clicked a role chip, released the request, and saw the note.

## The fix

`SaveState.Saving` now records the filters being saved, and `CompletedSaveSearch` carries the filters it saved. A filter change keeps Saving only when the new search filters are the same ones being saved. Otherwise it goes back to Idle. The reply sets Saved or Failed only when the model is still Saving those exact filters. A successful save always marks the account list stale, so the account page reloads and shows the new search.

## Lesson

A confirmation is a claim about what is on screen. Tie it to the request it confirms, and drop it when the screen has moved on.
