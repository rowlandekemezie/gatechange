--------------------------- MODULE TrackerChanges ---------------------------
(***************************************************************************)
(* Two quick stage moves on one tracked job, signed in.                    *)
(* Code: apps/web/src/client/board/update.ts queuedWrite, finishedWrite,   *)
(* withServerJobs, SucceededTrackerChange, FailedTrackerChange;            *)
(* board/command.ts SendTrackerChange.                                     *)
(* Each move bumps trackerRevision and joins the tracker's write lane. The *)
(* head of the lane is the only write in flight; its reply sends the next  *)
(* and shows the server list with the waiting moves laid on top.           *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, Sequences

Stages == {"Saved", "Applied", "Interviewing"}
MaxMoves == 2

VARIABLES
  server,   \* stage stored in D1
  screen,   \* stage the tracker card shows (optimistic copy)
  rev,      \* model.trackerRevision
  moves,    \* moves the reader made
  reqs,     \* requests in flight: [rev, kind, stage, phase, snap]
  waiting,  \* moves queued behind the write in flight: <<[rev, stage]>>
  problem   \* error banner shown

vars == <<server, screen, rev, moves, reqs, waiting, problem>>

Sent(r, s) == [rev |-> r, kind |-> "change", stage |-> s, phase |-> "sent", snap |-> "none"]

Writing == \E r \in reqs : r.kind = "change"

Init ==
  /\ server = "Saved" /\ screen = "Saved" /\ rev = 1 /\ moves = 0
  /\ reqs = {} /\ waiting = <<>> /\ problem = FALSE

ReaderMovesStage(s) ==
  /\ moves < MaxMoves /\ s # screen
  /\ rev' = rev + 1 /\ moves' = moves + 1 /\ screen' = s /\ problem' = FALSE
  /\ IF Writing
       THEN /\ waiting' = Append(waiting, [rev |-> rev + 1, stage |-> s])
            /\ UNCHANGED reqs
       ELSE /\ reqs' = reqs \cup {Sent(rev + 1, s)}
            /\ UNCHANGED waiting
  /\ UNCHANGED server

WorkerRuns(r) ==
  /\ r \in reqs /\ r.phase = "sent"
  /\ server' = IF r.kind = "change" THEN r.stage ELSE server
  /\ reqs' = (reqs \ {r}) \cup {[r EXCEPT !.phase = "ok", !.snap = server']}
  /\ UNCHANGED <<screen, rev, moves, waiting, problem>>

WorkerFails(r) ==
  /\ r \in reqs /\ r.phase = "sent" /\ r.kind = "change"
  /\ reqs' = (reqs \ {r}) \cup {[r EXCEPT !.phase = "failed"]}
  /\ UNCHANGED <<server, screen, rev, moves, waiting, problem>>

\* The lane's head answered: send the next waiting move, if any.
NextWrite(r) ==
  IF waiting = <<>>
    THEN /\ reqs' = reqs \ {r} /\ UNCHANGED waiting
    ELSE /\ reqs' = (reqs \ {r}) \cup {Sent(Head(waiting).rev, Head(waiting).stage)}
         /\ waiting' = Tail(waiting)

ChangeReplyArrives(r) ==
  /\ r \in reqs /\ r.phase = "ok" /\ r.kind = "change"
  /\ screen' = IF waiting = <<>> THEN r.snap ELSE waiting[Len(waiting)].stage
  /\ NextWrite(r)
  /\ UNCHANGED <<server, rev, moves, problem>>

SyncReplyArrives(r) ==
  /\ r \in reqs /\ r.phase = "ok" /\ r.kind = "sync"
  /\ screen' = IF r.rev = rev THEN r.snap ELSE screen
  /\ reqs' = reqs \ {r}
  /\ UNCHANGED <<server, rev, moves, waiting, problem>>

\* A failed head shows the banner; with nothing waiting it reloads the tracker.
FailureArrives(r) ==
  /\ r \in reqs /\ r.phase = "failed"
  /\ problem' = TRUE
  /\ IF waiting = <<>>
       THEN /\ rev' = rev + 1
            /\ reqs' = (reqs \ {r}) \cup {[rev |-> rev + 1, kind |-> "sync",
                         stage |-> "none", phase |-> "sent", snap |-> "none"]}
            /\ UNCHANGED waiting
       ELSE /\ NextWrite(r) /\ UNCHANGED rev
  /\ UNCHANGED <<server, screen, moves>>

ServerSavesOne == \E r \in reqs : WorkerRuns(r)
ServerFailsOne == \E r \in reqs : WorkerFails(r)
ReplyReachesPage == \E r \in reqs : ChangeReplyArrives(r) \/ SyncReplyArrives(r)
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

\* At most one tracker write is in flight.
OneWriteAtATime == Cardinality({r \in reqs : r.kind = "change"}) <= 1

\* Once every reply is in, the card shows the stage the server kept.
SettledCardMatchesServer == reqs = {} => screen = server

\* A failed save never goes unannounced once replies are in.
FailureIsAnnounced ==
  (reqs = {} /\ screen # server) => problem
=============================================================================
