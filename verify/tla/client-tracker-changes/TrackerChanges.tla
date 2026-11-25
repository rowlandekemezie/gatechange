--------------------------- MODULE TrackerChanges ---------------------------
(***************************************************************************)
(* Two quick stage moves on one tracked job, signed in.                    *)
(* Code: apps/web/src/client/board/update.ts sentChange (544),             *)
(* withServerTracker (622), isCurrentRevision (619), FailedTrackerChange   *)
(* (1038); board/command.ts SendTrackerChange (317).                       *)
(* Each move bumps trackerRevision and sends its own request at once; the  *)
(* Worker may run the two requests in either order. Only the reply whose   *)
(* revision is current replaces the optimistic copy.                       *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

Stages == {"Saved", "Applied", "Interviewing"}
MaxMoves == 2

VARIABLES
  server,   \* stage stored in D1
  screen,   \* stage the tracker card shows (optimistic copy)
  rev,      \* model.trackerRevision
  moves,    \* moves the reader made
  reqs,     \* requests in flight: [rev, kind, stage, phase, snap]
  problem   \* error banner shown

vars == <<server, screen, rev, moves, reqs, problem>>

Init ==
  /\ server = "Saved" /\ screen = "Saved" /\ rev = 1 /\ moves = 0
  /\ reqs = {} /\ problem = FALSE

ReaderMovesStage(s) ==
  /\ moves < MaxMoves /\ s # screen
  /\ rev' = rev + 1 /\ moves' = moves + 1 /\ screen' = s /\ problem' = FALSE
  /\ reqs' = reqs \cup {[rev |-> rev + 1, kind |-> "change", stage |-> s,
                         phase |-> "sent", snap |-> "none"]}
  /\ UNCHANGED server

WorkerRuns(r) ==
  /\ r \in reqs /\ r.phase = "sent"
  /\ server' = IF r.kind = "change" THEN r.stage ELSE server
  /\ reqs' = (reqs \ {r}) \cup {[r EXCEPT !.phase = "ok", !.snap = server']}
  /\ UNCHANGED <<screen, rev, moves, problem>>

WorkerFails(r) ==
  /\ r \in reqs /\ r.phase = "sent" /\ r.kind = "change"
  /\ reqs' = (reqs \ {r}) \cup {[r EXCEPT !.phase = "failed"]}
  /\ UNCHANGED <<server, screen, rev, moves, problem>>

ReplyArrives(r) ==
  /\ r \in reqs /\ r.phase = "ok"
  /\ screen' = IF r.rev = rev THEN r.snap ELSE screen
  /\ reqs' = reqs \ {r}
  /\ UNCHANGED <<server, rev, moves, problem>>

FailureArrives(r) ==
  /\ r \in reqs /\ r.phase = "failed"
  /\ problem' = TRUE
  /\ IF r.rev = rev
       THEN /\ rev' = rev + 1
            /\ reqs' = (reqs \ {r}) \cup {[rev |-> rev + 1, kind |-> "sync",
                         stage |-> "none", phase |-> "sent", snap |-> "none"]}
       ELSE /\ reqs' = reqs \ {r} /\ UNCHANGED rev
  /\ UNCHANGED <<server, screen, moves>>

ServerSavesOne == \E r \in reqs : WorkerRuns(r)
ServerFailsOne == \E r \in reqs : WorkerFails(r)
ReplyReachesPage == \E r \in reqs : ReplyArrives(r)
FailureReachesPage == \E r \in reqs : FailureArrives(r)

Done == reqs = {} /\ UNCHANGED vars

Next ==
  \/ \E s \in Stages : ReaderMovesStage(s)
  \/ ServerSavesOne
  \/ ServerFailsOne
  \/ ReplyReachesPage
  \/ FailureReachesPage
  \/ Done

Spec == Init /\ [][Next]_vars

TypeOK == screen \in Stages /\ server \in Stages /\ moves <= MaxMoves

\* Once every reply is in, the card shows the stage the server kept.
SettledCardMatchesServer == reqs = {} => screen = server

\* A failed save never goes unannounced once replies are in.
FailureIsAnnounced ==
  (reqs = {} /\ screen # server) => problem
=============================================================================
