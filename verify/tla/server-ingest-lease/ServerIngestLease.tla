-------------------------- MODULE ServerIngestLease --------------------------
EXTENDS Naturals

CONSTANTS GuardInClaim, Lease, MaxTime

Runs == {"a", "b"}

VARIABLES now, pc, start, leaseStart, heldUntil, receipts, writesByRejected

vars == <<now, pc, start, leaseStart, heldUntil, receipts, writesByRejected>>

Init ==
  /\ now = 0
  /\ pc = [r \in Runs |-> "waiting"]
  /\ start = [r \in Runs |-> 0]
  /\ leaseStart = 0
  /\ heldUntil = 0
  /\ receipts = 0
  /\ writesByRejected = FALSE

CronClaimsLease(r) ==
  /\ pc[r] = "waiting"
  /\ \A s \in Runs : pc[s] # "waiting" => start[s] # now
  /\ start' = [start EXCEPT ![r] = now]
  /\ IF ~GuardInClaim \/ heldUntil <= now
       THEN /\ leaseStart' = now
            /\ heldUntil' = now + Lease
            /\ pc' = [pc EXCEPT ![r] = "ingesting"]
       ELSE /\ pc' = [pc EXCEPT ![r] = "rejected"]
            /\ UNCHANGED <<leaseStart, heldUntil>>
  /\ UNCHANGED <<now, receipts, writesByRejected>>

RunWritesReceipt(r) ==
  /\ pc[r] = "ingesting"
  /\ receipts' = receipts + 1
  /\ pc' = [pc EXCEPT ![r] = "recorded"]
  /\ UNCHANGED <<now, start, leaseStart, heldUntil, writesByRejected>>

RunReleasesLease(r) ==
  /\ pc[r] = "recorded"
  /\ heldUntil' = IF leaseStart = start[r] THEN leaseStart ELSE heldUntil
  /\ pc' = [pc EXCEPT ![r] = "finished"]
  /\ UNCHANGED <<now, start, leaseStart, receipts, writesByRejected>>

TwentyMinutesPass ==
  /\ now < MaxTime
  /\ now' = now + 1
  /\ pc' = [r \in Runs |-> IF pc[r] \in {"ingesting", "recorded"} /\ start[r] + Lease <= now + 1 THEN "killed" ELSE pc[r]]
  /\ UNCHANGED <<start, leaseStart, heldUntil, receipts, writesByRejected>>

Done ==
  /\ \A r \in Runs : pc[r] \in {"finished", "rejected", "killed", "waiting"}
  /\ (now = MaxTime \/ \A r \in Runs : pc[r] # "waiting")
  /\ UNCHANGED vars

Next ==
  \/ \E r \in Runs : CronClaimsLease(r) \/ RunWritesReceipt(r) \/ RunReleasesLease(r)
  \/ TwentyMinutesPass
  \/ Done

Spec == Init /\ [][Next]_vars

Ingesting == {r \in Runs : pc[r] \in {"ingesting", "recorded"}}

TypeOK == now \in 0..MaxTime /\ receipts \in 0..2

RunsNeverOverlap == \A r, s \in Ingesting : r = s

RejectedRunWritesNothing == ~writesByRejected

FinishedRunFreesLease ==
  (\E r \in Runs : pc[r] = "finished" /\ leaseStart = start[r]) => heldUntil <= now
=============================================================================
