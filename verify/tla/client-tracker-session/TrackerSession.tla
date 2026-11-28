--------------------------- MODULE TrackerSession ---------------------------
(***************************************************************************)
(* The shortlist across sign-in, the "move them to your account" offer and *)
(* sign-out, with the browser list in localStorage.                        *)
(* Code: apps/web/src/client/board/update.ts followedSession (703),        *)
(* movedShortlist (664), CompletedSyncTracker (981), FailedSyncTracker     *)
(* (1033), SucceededTrackerChange (1165), withServerTracker (622),         *)
(* shortlistWith (522), CompletedReadShortlist (978); board/command.ts     *)
(* SyncTracker (261), ImportStoredShortlist (275), ReadShortlist (183),    *)
(* WriteShortlist (199). Sign-out is folded into one step: the session     *)
(* check answers signed out after SignOut.                                 *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

VARIABLES
  session,   \* "checking", "in", "out"
  tracker,   \* "Local" or "Remote"
  loaded,    \* Remote tracker has a server list
  offer,     \* "None", "Asking", "Moving", "Declined"
  rev,       \* model.trackerRevision
  pending,   \* in-flight commands: [kind, rev]
  marks,     \* browser shortlist shown on screen (Local)
  stored,    \* localStorage jobs.shortlist.v1
  account,   \* jobs saved in the signed-in account
  tracked    \* the reader tracked a job while signed in

vars == <<session, tracker, loaded, offer, rev, pending, marks, stored, account, tracked>>

Init ==
  /\ session = "checking" /\ tracker = "Local" /\ loaded = FALSE
  /\ offer = "None" /\ rev = 0
  /\ pending = {[kind |-> "read", rev |-> 0]}
  /\ marks = {} /\ stored = {"old"} /\ account = {} /\ tracked = FALSE

BrowserListRead ==
  /\ \E p \in pending : p.kind = "read"
  /\ marks' = stored
  /\ pending' = {p \in pending : p.kind # "read"}
  /\ UNCHANGED <<session, tracker, loaded, offer, rev, stored, account, tracked>>

SessionSaysSignedIn ==
  /\ session = "checking"
  /\ session' = "in" /\ tracker' = "Remote" /\ loaded' = FALSE
  /\ offer' = "None" /\ rev' = rev + 1
  /\ pending' = pending \cup {[kind |-> "sync", rev |-> rev + 1]}
  /\ UNCHANGED <<marks, stored, account, tracked>>

SessionSaysSignedOut ==
  /\ session = "checking"
  /\ session' = "out"
  /\ UNCHANGED <<tracker, loaded, offer, rev, pending, marks, stored, account, tracked>>

\* CompletedSyncTracker: marks cleared always; offer and list only when current.
Answered(p, waiting) ==
  /\ marks' = {}
  /\ IF tracker = "Remote" /\ p.rev = rev
       THEN /\ offer' = IF offer = "Declined" THEN "Declined"
                        ELSE IF waiting > 0 THEN "Asking" ELSE "None"
            /\ loaded' = TRUE
       ELSE UNCHANGED <<offer, loaded>>

SyncAnswers ==
  \E p \in pending :
    /\ p.kind = "sync"
    /\ pending' = pending \ {p}
    /\ Answered(p, Cardinality(stored))
    /\ UNCHANGED <<session, tracker, rev, stored, account, tracked>>

ReaderMovesBrowserJobs ==
  /\ tracker = "Remote" /\ offer = "Asking"
  /\ offer' = "Moving" /\ rev' = rev + 1
  /\ pending' = pending \cup {[kind |-> "import", rev |-> rev + 1]}
  /\ UNCHANGED <<session, tracker, loaded, marks, stored, account, tracked>>

ImportAnswers ==
  \E p \in pending :
    /\ p.kind = "import"
    /\ pending' = pending \ {p}
    /\ account' = account \cup stored /\ stored' = {}
    /\ Answered(p, 0)
    /\ UNCHANGED <<session, tracker, rev, tracked>>

ImportFails ==
  \E p \in pending :
    /\ p.kind = "import"
    /\ pending' = pending \ {p}
    /\ offer' = IF tracker = "Remote" /\ p.rev = rev /\ offer = "Moving" THEN "Asking" ELSE offer
    /\ UNCHANGED <<session, tracker, loaded, rev, marks, stored, account, tracked>>

ReaderTracksJob ==
  /\ tracker = "Remote" /\ ~tracked
  /\ tracked' = TRUE /\ rev' = rev + 1
  /\ pending' = pending \cup {[kind |-> "change", rev |-> rev + 1]}
  /\ UNCHANGED <<session, tracker, loaded, offer, marks, stored, account>>

ChangeAnswers ==
  \E p \in pending :
    /\ p.kind = "change"
    /\ pending' = pending \ {p}
    /\ account' = account \cup {"new"}
    /\ loaded' = IF tracker = "Remote" /\ p.rev = rev THEN TRUE ELSE loaded
    /\ UNCHANGED <<session, tracker, offer, rev, marks, stored, tracked>>

ReaderSignsOut ==
  /\ session = "in"
  /\ session' = "out" /\ tracker' = "Local" /\ marks' = {}
  /\ pending' = pending \cup {[kind |-> "read", rev |-> rev]}
  /\ UNCHANGED <<loaded, offer, rev, stored, account, tracked>>

\* ReadShortlist is Effect.sync and runs in the tick after the update that
\* issued it, so no click lands before it answers.
\* Signed out, the reader saves another job in the browser: WriteShortlist(marks).
ReaderSavesInBrowser ==
  /\ session = "out" /\ tracker = "Local" /\ "local2" \notin marks
  /\ ~\E p \in pending : p.kind = "read"
  /\ marks' = marks \cup {"local2"} /\ stored' = marks \cup {"local2"}
  /\ UNCHANGED <<session, tracker, loaded, offer, rev, pending, account, tracked>>

Done == pending = {} /\ UNCHANGED vars

Next ==
  \/ BrowserListRead \/ SessionSaysSignedIn \/ SessionSaysSignedOut
  \/ SyncAnswers \/ ReaderMovesBrowserJobs \/ ImportAnswers \/ ImportFails
  \/ ReaderTracksJob \/ ChangeAnswers \/ ReaderSignsOut \/ ReaderSavesInBrowser
  \/ Done

Bounded == rev <= 4

Spec == Init /\ [][Next]_vars

TypeOK == offer \in {"None", "Asking", "Moving", "Declined"}

Reads == {p \in pending : p.kind = "read"}

\* "Moving..." is only on screen while the move is still running.
MovingOnlyWhileMoving ==
  (tracker = "Remote" /\ offer = "Moving") => \E p \in pending : p.kind = "import"

\* Signed out, the shortlist page shows what this browser has saved.
BrowserListShown ==
  (tracker = "Local" /\ Reads = {} /\ session # "checking") => marks = stored

\* A job saved in the browser is never lost: it stays there or moved to the account.
NoBrowserJobLost == "old" \in stored \cup account

\* Signed in, the tracker stops saying "Loading" once nothing is in flight.
TrackerSettles == (tracker = "Remote" /\ pending = {}) => loaded
=============================================================================
