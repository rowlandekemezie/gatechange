--------------------------- MODULE TrackerSession ---------------------------
(***************************************************************************)
(* The shortlist across sign-in, the "move them to your account" offer and *)
(* sign-out, with the browser list in localStorage.                        *)
(* Code: apps/web/src/client/board/update.ts followedSession,              *)
(* queuedWrite, finishedWrite, movedShortlist, CompletedSyncTracker,       *)
(* FailedSyncTracker, SucceededTrackerChange, shortlistWith,               *)
(* CompletedReadShortlist; board/command.ts SyncTracker,                   *)
(* ImportStoredShortlist, ReadShortlist, WriteShortlist. Sign-out is       *)
(* folded into one step: the session check answers signed out after        *)
(* SignOut. Writes (import, change) form a lane inside the Remote tracker: *)
(* one in flight (head), at most one waiting (queued). Sign-out drops it.  *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

VARIABLES
  session,   \* "checking", "in", "out"
  tracker,   \* "Local" or "Remote"
  loaded,    \* Remote tracker has a server list
  offer,     \* "None", "Asking", "Moving", "Declined"
  rev,       \* model.trackerRevision
  pending,   \* in-flight commands: [kind, rev]
  head,      \* revision of the write in flight in the lane, 0 when none
  queued,    \* the write waiting behind it, or NoWrite
  marks,     \* browser shortlist shown on screen (Local)
  stored,    \* localStorage jobs.shortlist.v1
  account,   \* jobs saved in the signed-in account
  tracked    \* the reader tracked a job while signed in

vars == <<session, tracker, loaded, offer, rev, pending, head, queued, marks, stored, account, tracked>>

NoWrite == [kind |-> "none", rev |-> 0]

Init ==
  /\ session = "checking" /\ tracker = "Local" /\ loaded = FALSE
  /\ offer = "None" /\ rev = 0
  /\ pending = {[kind |-> "read", rev |-> 0]}
  /\ head = 0 /\ queued = NoWrite
  /\ marks = {} /\ stored = {"old"} /\ account = {} /\ tracked = FALSE

\* queuedWrite: send now when the lane is idle, otherwise wait.
Enqueue(kind) ==
  /\ rev' = rev + 1
  /\ IF head = 0
       THEN /\ head' = rev + 1
            /\ pending' = pending \cup {[kind |-> kind, rev |-> rev + 1]}
            /\ UNCHANGED queued
       ELSE /\ queued' = [kind |-> kind, rev |-> rev + 1]
            /\ UNCHANGED <<head, pending>>

\* finishedWrite: the head answered; send the waiting write, if any.
Advance(p) ==
  IF queued = NoWrite
    THEN /\ head' = 0 /\ pending' = pending \ {p} /\ UNCHANGED queued
    ELSE /\ head' = queued.rev
         /\ pending' = (pending \ {p}) \cup {queued}
         /\ queued' = NoWrite

IsHead(p) == tracker = "Remote" /\ p.rev = head

Dropped(p) == pending' = pending \ {p} /\ UNCHANGED <<head, queued>>

BrowserListRead ==
  /\ \E p \in pending : p.kind = "read"
  /\ marks' = stored
  /\ pending' = {p \in pending : p.kind # "read"}
  /\ UNCHANGED <<session, tracker, loaded, offer, rev, head, queued, stored, account, tracked>>

SessionSaysSignedIn ==
  /\ session = "checking"
  /\ session' = "in" /\ tracker' = "Remote" /\ loaded' = FALSE
  /\ offer' = "None" /\ rev' = rev + 1
  /\ pending' = pending \cup {[kind |-> "sync", rev |-> rev + 1]}
  /\ UNCHANGED <<head, queued, marks, stored, account, tracked>>

SessionSaysSignedOut ==
  /\ session = "checking"
  /\ session' = "out"
  /\ UNCHANGED <<tracker, loaded, offer, rev, pending, head, queued, marks, stored, account, tracked>>

\* A plain sync counts only while Remote and current; it never clears Moving.
SyncAnswers ==
  \E p \in pending :
    /\ p.kind = "sync"
    /\ pending' = pending \ {p}
    /\ IF tracker = "Remote" /\ p.rev = rev
         THEN /\ marks' = {} /\ loaded' = TRUE
              /\ offer' = IF offer \in {"Declined", "Moving"} THEN offer
                          ELSE IF Cardinality(stored) > 0 THEN "Asking" ELSE "None"
         ELSE UNCHANGED <<marks, loaded, offer>>
    /\ UNCHANGED <<session, tracker, rev, head, queued, stored, account, tracked>>

ReaderMovesBrowserJobs ==
  /\ tracker = "Remote" /\ offer = "Asking"
  /\ offer' = "Moving"
  /\ Enqueue("import")
  /\ UNCHANGED <<session, tracker, loaded, marks, stored, account, tracked>>

\* An import that lands after sign-out has emptied localStorage, so the
\* signed-out page reads the browser list again.
ImportAnswers ==
  \E p \in pending :
    /\ p.kind = "import"
    /\ account' = account \cup stored /\ stored' = {}
    /\ IF IsHead(p)
         THEN /\ Advance(p) /\ marks' = {} /\ loaded' = TRUE
              /\ offer' = IF offer = "Declined" THEN "Declined" ELSE "None"
         ELSE /\ UNCHANGED <<head, queued, marks, loaded, offer>>
              /\ pending' = IF tracker = "Local"
                             THEN (pending \ {p}) \cup {[kind |-> "read", rev |-> rev]}
                             ELSE pending \ {p}
    /\ UNCHANGED <<session, tracker, rev, tracked>>

ImportFails ==
  \E p \in pending :
    /\ p.kind = "import"
    /\ IF IsHead(p)
         THEN /\ Advance(p)
              /\ offer' = IF offer = "Moving" THEN "Asking" ELSE offer
         ELSE /\ Dropped(p) /\ UNCHANGED offer
    /\ UNCHANGED <<session, tracker, loaded, rev, marks, stored, account, tracked>>

ReaderTracksJob ==
  /\ tracker = "Remote" /\ ~tracked
  /\ tracked' = TRUE
  /\ Enqueue("change")
  /\ UNCHANGED <<session, tracker, loaded, offer, marks, stored, account>>

ChangeAnswers ==
  \E p \in pending :
    /\ p.kind = "change"
    /\ account' = account \cup {"new"}
    /\ IF IsHead(p)
         THEN Advance(p) /\ loaded' = TRUE
         ELSE Dropped(p) /\ UNCHANGED loaded
    /\ UNCHANGED <<session, tracker, offer, rev, marks, stored, tracked>>

\* Sign-out swaps the tracker to Local, which drops its write lane.
ReaderSignsOut ==
  /\ session = "in"
  /\ session' = "out" /\ tracker' = "Local" /\ marks' = {}
  /\ head' = 0 /\ queued' = NoWrite
  /\ pending' = pending \cup {[kind |-> "read", rev |-> rev]}
  /\ UNCHANGED <<loaded, offer, rev, stored, account, tracked>>

\* ReadShortlist is Effect.sync and runs in the tick after the update that
\* issued it, so no click lands before it answers.
\* Signed out, the reader saves another job in the browser: WriteShortlist(marks).
ReaderSavesInBrowser ==
  /\ session = "out" /\ tracker = "Local" /\ "local2" \notin marks
  /\ ~\E p \in pending : p.kind = "read"
  /\ marks' = marks \cup {"local2"} /\ stored' = marks \cup {"local2"}
  /\ UNCHANGED <<session, tracker, loaded, offer, rev, pending, head, queued, account, tracked>>

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

\* "Moving..." is only on screen while the move is running or waiting its turn.
MovingOnlyWhileMoving ==
  (tracker = "Remote" /\ offer = "Moving") =>
    \/ \E p \in pending : p.kind = "import" /\ p.rev = head
    \/ queued.kind = "import"

\* Signed out, the shortlist page shows what this browser has saved.
BrowserListShown ==
  (tracker = "Local" /\ Reads = {} /\ session # "checking") => marks = stored

\* A job saved in the browser is never lost: it stays there or moved to the account.
NoBrowserJobLost == "old" \in stored \cup account

\* Signed in, the tracker stops saying "Loading" once nothing is in flight.
TrackerSettles == (tracker = "Remote" /\ pending = {}) => loaded
=============================================================================
