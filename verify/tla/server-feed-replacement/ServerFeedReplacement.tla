------------------------ MODULE ServerFeedReplacement ------------------------
EXTENDS Naturals, FiniteSets

Jobs == {"vp", "em"}
MaxFetches == 3

VARIABLES rows, phase, fetched, pending, before, lastOk, fetches

vars == <<rows, phase, fetched, pending, before, lastOk, fetches>>

Init ==
  /\ rows = [j \in Jobs |-> "absent"]
  /\ phase = "idle"
  /\ fetched = {}
  /\ pending = {}
  /\ before = rows
  /\ lastOk = "none"
  /\ fetches = 0

BoardAnswers(list) ==
  /\ phase = "idle" /\ fetches < MaxFetches
  /\ phase' = "upserting"
  /\ fetched' = list
  /\ pending' = list
  /\ before' = rows
  /\ fetches' = fetches + 1
  /\ lastOk' = "saving"
  /\ UNCHANGED rows

BoardFails ==
  /\ phase = "idle" /\ fetches < MaxFetches
  /\ before' = rows
  /\ lastOk' = "failed"
  /\ fetches' = fetches + 1
  /\ UNCHANGED <<rows, phase, fetched, pending>>

StoreUpsertsOneChunk ==
  /\ phase = "upserting" /\ pending # {}
  /\ \E j \in pending :
       /\ rows' = [rows EXCEPT ![j] = "open"]
       /\ pending' = pending \ {j}
  /\ UNCHANGED <<phase, fetched, before, lastOk, fetches>>

StoreDepartsUnlisted ==
  /\ phase = "upserting" /\ pending = {}
  /\ rows' = [j \in Jobs |-> IF j \notin fetched /\ rows[j] = "open" THEN "departed" ELSE rows[j]]
  /\ phase' = "idle"
  /\ lastOk' = "ok"
  /\ UNCHANGED <<fetched, pending, before, fetches>>

StoreFailsMidWrite ==
  /\ phase = "upserting"
  /\ phase' = "idle"
  /\ lastOk' = "storeFailed"
  /\ pending' = {}
  /\ UNCHANGED <<rows, fetched, before, fetches>>

DayPassesAndPrunes ==
  /\ phase = "idle"
  /\ \E j \in Jobs : rows[j] = "departed"
  /\ rows' = [j \in Jobs |-> IF rows[j] = "departed" THEN "absent" ELSE rows[j]]
  /\ lastOk' = "pruned"
  /\ UNCHANGED <<phase, fetched, pending, before, fetches>>

Done ==
  /\ phase = "idle" /\ fetches = MaxFetches
  /\ UNCHANGED vars

Next ==
  \/ \E list \in SUBSET Jobs : BoardAnswers(list)
  \/ BoardFails
  \/ StoreUpsertsOneChunk
  \/ StoreDepartsUnlisted
  \/ StoreFailsMidWrite
  \/ DayPassesAndPrunes
  \/ Done

Spec == Init /\ [][Next]_vars

TypeOK == \A j \in Jobs : rows[j] \in {"absent", "open", "departed"}

ListedRoleIsOpen == lastOk = "ok" => \A j \in fetched : rows[j] = "open"

UnlistedRoleDeparts == lastOk = "ok" => \A j \in Jobs \ fetched : rows[j] # "open"

FailedFetchChangesNothing == lastOk = "failed" => rows = before

DepartedRolePruned == lastOk = "pruned" => \A j \in Jobs : rows[j] # "departed"
=============================================================================
