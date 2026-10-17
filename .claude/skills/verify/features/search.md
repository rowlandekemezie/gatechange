# Search

The search box filters the current view by company, title, or city. It works together with the headline filters.

## Sub-features

- `search-company` narrows the list to one company.
- `search-title` narrows the list by words in the title.
- `search-miss` shows the empty state for text that matches nothing.

## How to get to it (user POV)

- Type in the box labeled `Filter by company, title or city` and press `Search` or Enter.

## Driving it with drive.ts

Preconditions:

- `doctor.sh <stage>` prints four `ok` lines.

- **Company.** Run `drive.ts --url <url> --out <dir> --scenario search`. It searches for the first row's company. The JSON lists `companies` with only that name, and the count drops.
- **Miss.** Not scripted yet. Search for `volcano` and require the empty state.

## Gotchas

- The query is trimmed and cut to 80 characters before it reaches the backend.
- Search applies within the selected regions, roles, and age window. A company outside them returns nothing.
