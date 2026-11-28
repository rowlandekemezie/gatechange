# L2: a hidden 5,000-row limit could stop the board from refreshing

## The bug

Nobody has seen this one yet. Every 20 minutes the cron fetches the 90 feeds that have waited longest. To decide, it reads each feed's last attempt from the `feeds` table. That read stopped at 5,000 rows, sorted by key. The table also keeps rows for boards that have left the catalog, and it holds about 1,100 rows today. Past 5,000 rows, any feed whose key sorted late would read as "never fetched". It would jump the queue on every run. With more than 90 such feeds, the rest of the board would never refresh again, and listings would go stale with no error anywhere.

## How we found it

The Lean copy of the scheduler proves that every due feed is fetched within a bounded number of runs. That proof assumes the scheduler sees every feed's state. We modelled the capped read with a cap of one row and two feeds. `decide` showed one feed fetched five times in a row while the other waited. A new entity test does the same against real SQLite with 5,000 departed feed rows. It fetched `zz:a` four times and `zz:b` never.

## The fix

We removed the `ORDER BY key LIMIT 5000`. The read now returns every feed row, which is the view the Lean proof assumes, so the refresh bound holds for the real code again. The cost is one row read per feed row on each run. That is the same as today, because the cap was never reached.

## What we learned

A limit that looks like a safety net can break a guarantee without anyone noticing. The proof made the assumption visible. It needed the whole state, and the SQL quietly gave it only part.
