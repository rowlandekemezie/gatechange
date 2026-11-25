----------------------------- MODULE BoardFetch -----------------------------
(***************************************************************************)
(* The board's job list: filter changes, Show more, retry, leaving for a   *)
(* job page and coming back, with replies arriving in any order.           *)
(* Code: apps/web/src/client/board/update.ts withFilters (264),            *)
(* keepingRoles (253), entered Board arm (426), ClickedLoadMore (916),     *)
(* ClickedRetry (950), SucceededFetchJobs (1109), FailedFetchJobs (1011),  *)
(* SucceededFetchMoreJobs (1129), FailedFetchMoreJobs (1026).              *)
(* A filter value stands for the whole Filters record. GuardGeneration     *)
(* FALSE removes the generation checks (mutation check).                   *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANT GuardGeneration

FilterSets == {"A", "B"}

VARIABLES
  filters,  \* filters the controls show
  gen,      \* model.generation
  jobs,     \* "Loading", "Refreshing", "Loaded", "Failed"
  rows,     \* filters whose rows are listed
  more,     \* "Idle", "Loading", "Failed"
  route,    \* "board" or "job"
  pending,  \* in-flight fetches: [kind, gen, f, fails]
  clicks    \* bound on reader actions

vars == <<filters, gen, jobs, rows, more, route, pending, clicks>>

MaxClicks == 2

Init ==
  /\ filters = "A" /\ gen = 1 /\ jobs = "Loading" /\ rows = {}
  /\ more = "Idle" /\ route = "board" /\ clicks = 0
  /\ pending = {[kind |-> "page", gen |-> 1, f |-> "A", fails |-> FALSE],
                [kind |-> "page", gen |-> 1, f |-> "A", fails |-> TRUE]}

Refetch(f) ==
  /\ gen' = gen + 1 /\ filters' = f /\ more' = "Idle"
  /\ jobs' = IF jobs \in {"Loaded", "Refreshing"} /\ rows # {} THEN "Refreshing" ELSE "Loading"
  /\ pending' = pending \cup {[kind |-> "page", gen |-> gen + 1, f |-> f, fails |-> b] : b \in BOOLEAN}

ReaderChangesFilter ==
  /\ route = "board" /\ clicks < MaxClicks /\ clicks' = clicks + 1
  /\ Refetch(IF filters = "A" THEN "B" ELSE "A")
  /\ UNCHANGED <<rows, route>>

ReaderRetries ==
  /\ route = "board" /\ jobs = "Failed" /\ clicks < MaxClicks /\ clicks' = clicks + 1
  /\ Refetch(filters)
  /\ UNCHANGED <<rows, route>>

\* No guard on more = Loading: a double tap sends two requests.
ReaderTapsShowMore ==
  /\ route = "board" /\ jobs = "Loaded" /\ clicks < MaxClicks /\ clicks' = clicks + 1
  /\ more' = "Loading"
  /\ pending' = pending \cup {[kind |-> "more", gen |-> gen, f |-> filters, fails |-> b] : b \in BOOLEAN}
  /\ UNCHANGED <<filters, gen, jobs, rows, route>>

ReaderOpensJob ==
  /\ route = "board" /\ route' = "job"
  /\ UNCHANGED <<filters, gen, jobs, rows, more, pending, clicks>>

\* Back to the board with the same filters: entered keeps the list, no refetch.
ReaderComesBack ==
  /\ route = "job" /\ route' = "board"
  /\ UNCHANGED <<filters, gen, jobs, rows, more, pending, clicks>>

Current(p) == ~GuardGeneration \/ p.gen = gen

Gone(p) == pending' = {q \in pending : ~(q.kind = p.kind /\ q.gen = p.gen /\ q.f = p.f)}

PageArrives ==
  \E p \in pending :
    /\ p.kind = "page" /\ Gone(p)
    /\ IF Current(p)
         THEN IF p.fails
                THEN jobs' = "Failed" /\ UNCHANGED rows
                ELSE jobs' = "Loaded" /\ rows' = {p.f}
         ELSE UNCHANGED <<jobs, rows>>
    /\ UNCHANGED <<filters, gen, more, route, clicks>>

MoreArrives ==
  \E p \in pending :
    /\ p.kind = "more" /\ pending' = pending \ {p}
    /\ IF Current(p) /\ (p.fails \/ jobs = "Loaded")
         THEN IF p.fails
                THEN more' = "Failed" /\ UNCHANGED rows
                ELSE more' = "Idle" /\ rows' = rows \cup {p.f}
         ELSE UNCHANGED <<more, rows>>
    /\ UNCHANGED <<filters, gen, jobs, route, clicks>>

Done == pending = {} /\ UNCHANGED vars

Next ==
  \/ ReaderChangesFilter \/ ReaderRetries \/ ReaderTapsShowMore
  \/ ReaderOpensJob \/ ReaderComesBack
  \/ PageArrives \/ MoreArrives \/ Done

Spec == Init /\ [][Next]_vars

TypeOK == jobs \in {"Loading", "Refreshing", "Loaded", "Failed"}

\* A settled list only shows roles for the filters on screen.
ListMatchesFilters == jobs = "Loaded" => rows = {filters}

\* "Loading more" never sticks once its reply can no longer land.
ShowMoreSettles ==
  more = "Loading" => \E p \in pending : p.kind = "more" /\ p.gen = gen

\* The spinner stops: when nothing is in flight the list is Loaded or Failed.
ListSettles == pending = {} => jobs \in {"Loaded", "Failed"}
=============================================================================
