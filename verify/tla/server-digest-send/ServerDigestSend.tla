--------------------------- MODULE ServerDigestSend ---------------------------
EXTENDS Naturals, FiniteSets

CONSTANTS Cap

Runs == {"r1", "r2"}
Members == {"m1", "m2"}
Procs == Runs \X Members

VARIABLES pc, row, mailed, unsub, mailedAfterUnsub

vars == <<pc, row, mailed, unsub, mailedAfterUnsub>>

Claimed == {m \in Members : row[m] # "none"}

Init ==
  /\ pc = [p \in Procs |-> "due"]
  /\ row = [m \in Members |-> "none"]
  /\ mailed = [m \in Members |-> 0]
  /\ unsub = FALSE
  /\ mailedAfterUnsub = FALSE

RunRechecksMember(p) ==
  /\ pc[p] = "due"
  /\ pc' = [pc EXCEPT ![p] = IF (p[2] = "m1" /\ unsub) \/ row[p[2]] # "none" THEN "skipped" ELSE "checked"]
  /\ UNCHANGED <<row, mailed, unsub, mailedAfterUnsub>>

RunClaimsSend(p) ==
  /\ pc[p] = "checked"
  /\ IF row[p[2]] = "none" /\ Cardinality(Claimed) < Cap /\ ~(p[2] = "m1" /\ unsub)
       THEN /\ row' = [row EXCEPT ![p[2]] = "claimed"]
            /\ pc' = [pc EXCEPT ![p] = "claimed"]
            /\ mailedAfterUnsub' = (mailedAfterUnsub \/ (p[2] = "m1" /\ unsub))
       ELSE /\ pc' = [pc EXCEPT ![p] = "skipped"]
            /\ UNCHANGED <<row, mailedAfterUnsub>>
  /\ UNCHANGED <<mailed, unsub>>

RunMailsDigest(p) ==
  /\ pc[p] = "claimed"
  /\ mailed' = [mailed EXCEPT ![p[2]] = @ + 1]
  /\ pc' = [pc EXCEPT ![p] = "mailed"]
  /\ UNCHANGED <<row, unsub, mailedAfterUnsub>>

RunQuotaRefusal(p) ==
  /\ pc[p] = "claimed"
  /\ row' = [row EXCEPT ![p[2]] = "none"]
  /\ pc' = [pc EXCEPT ![p] = "skipped"]
  /\ UNCHANGED <<mailed, unsub, mailedAfterUnsub>>

RunMarksSent(p) ==
  /\ pc[p] = "mailed"
  /\ row' = [row EXCEPT ![p[2]] = "sent"]
  /\ pc' = [pc EXCEPT ![p] = "done"]
  /\ UNCHANGED <<mailed, unsub, mailedAfterUnsub>>

MemberUnsubscribes ==
  /\ ~unsub
  /\ unsub' = TRUE
  /\ UNCHANGED <<pc, row, mailed, mailedAfterUnsub>>

Done ==
  /\ \A p \in Procs : pc[p] \in {"skipped", "done"}
  /\ UNCHANGED vars

Next ==
  \/ \E p \in Procs :
       \/ RunRechecksMember(p)
       \/ RunClaimsSend(p)
       \/ RunMailsDigest(p)
       \/ RunQuotaRefusal(p)
       \/ RunMarksSent(p)
  \/ MemberUnsubscribes
  \/ Done

Spec == Init /\ [][Next]_vars

TypeOK == unsub \in BOOLEAN /\ \A m \in Members : mailed[m] \in 0..2

OneDigestPerPeriod == \A m \in Members : mailed[m] <= 1

DailyCapHolds == Cardinality({m \in Members : mailed[m] > 0}) <= Cap

NoSendReservedAfterUnsubscribe == ~mailedAfterUnsub
=============================================================================
