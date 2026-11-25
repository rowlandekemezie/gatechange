------------------------------ MODULE ServerCaps ------------------------------
EXTENDS Naturals

CONSTANTS Cap

Requests == {"q1", "q2", "q3"}

VARIABLES pc, held, refused

vars == <<pc, held, refused>>

Init ==
  /\ pc = [q \in Requests |-> "sent"]
  /\ held = 1
  /\ refused = 0

ServerChecksPro(q) ==
  /\ pc[q] = "sent"
  /\ pc' = [pc EXCEPT ![q] = "checked"]
  /\ UNCHANGED <<held, refused>>

ServerInsertsIfUnderCap(q) ==
  /\ pc[q] = "checked"
  /\ IF held < Cap
       THEN /\ held' = held + 1
            /\ pc' = [pc EXCEPT ![q] = "issued"]
            /\ UNCHANGED refused
       ELSE /\ pc' = [pc EXCEPT ![q] = "refused"]
            /\ refused' = refused + 1
            /\ UNCHANGED held
  
MemberRevokesOne ==
  /\ held > 0
  /\ held' = held - 1
  /\ UNCHANGED <<pc, refused>>

Done ==
  /\ \A q \in Requests : pc[q] \in {"issued", "refused"}
  /\ UNCHANGED vars

Next ==
  \/ \E q \in Requests : ServerChecksPro(q) \/ ServerInsertsIfUnderCap(q)
  \/ MemberRevokesOne
  \/ Done

Spec == Init /\ [][Next]_vars

TypeOK == held \in 0..(Cap + 3)

NeverOverCap == held <= Cap
=============================================================================
