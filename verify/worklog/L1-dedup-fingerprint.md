# L1: the duplicate check hid real jobs

## The bug

The same job often shows up on a company board and on two aggregators, so the board shows it once. To find those copies it built a key from the company and title. The key kept only ASCII letters, digits and `|`. So a role at 株式会社メルカリ and the same title at ソニー株式会社 got one key, and one of them vanished from the board. "Engineering Manager, C++" and "Engineering Manager, C" did too. So did "Acme | Labs" with "Engineering Manager" and "Acme" with "Labs | Engineering Manager".

## How we found it

We copied the key and the collapse into Lean 4. The collapse proofs held, and `decide` produced the three collisions. The drift test checks that TypeScript and Lean give the same keys.

## The fix

Each part is now NFKC-normalised and lowercased. It keeps letters, marks and digits in any script, plus `+` and `#`. The company drops `|` and the title keeps it, so the first `|` always splits the key cleanly. Lean proves two roles share a key only when both cleaned parts match. Lean also proves that an ASCII role without `+`, `#`, or `|` in the company keeps its old key.

## What we learned

The main risk was the rows already in D1, not the new rule. Feed rows rewrite their key on each refresh. The history tables keep old keys forever, so a renamed key would restart "open since" dates and repost counts. Keeping the ASCII key the same limits the change to a few rows, such as Grüns, Pokémon and Ōura in the board registry. For those rows, a small UPDATE moves the history to the new key when the role is next seen. No migration and no backfill.
