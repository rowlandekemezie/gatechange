# How it works

## What the board does with listings

- Reads 804 public company job boards on Greenhouse, Ashby, Lever and Workable, plus Remote OK, Remotive, Himalayas, Jobicy and the monthly Hacker News "Who is hiring?" thread.
- Keeps only leadership titles, and tags each role with where it can be worked from, such as remote Canada, remote US, or Vancouver and BC.
- Lists every role a company board still lists, however old the posting, and ranks older roles lower. Takes aggregator roles posted in the last 30 days.
- Removes a role when its company board stops listing it, so the board does not show ghost jobs. Aggregators return only their newest postings, so a role they stop listing stays until 30 days after it was posted.
- Links every listing to the original posting, and prefers the company's own board over an aggregator copy of the same role.
- Shows the freshest, most relevant roles first. Relevance adds weights for role, region, a stated salary and remote work, then subtracts 2.5 points per day of age.
- Serves the board over MCP, so an agent can search it for you.

## Sources

Gate Change reads public job APIs and feeds, and uses each one within its published terms.

- Every listing links to its original posting.
- The footer credits each aggregator with a link: Remote OK, Remotive, Himalayas, Jobicy and Hacker News.
- The crawler identifies itself with the `USER_AGENT` in `packages/job-sources/src/http.ts`.
- Each source has a minimum refresh interval. Company boards and most aggregators are fetched at most every two or three hours, Hacker News every six hours and Remotive every twelve.
- `packages/core/src/source-terms.ts` records each source's published terms. The board applies them. For example, email alerts include only sources whose terms allow alerts, and the MCP server leaves out sources whose terms forbid agent access.

If you run a source and want a change, open an issue.
