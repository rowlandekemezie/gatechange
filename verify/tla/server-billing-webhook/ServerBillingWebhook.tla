------------------------- MODULE ServerBillingWebhook -------------------------
EXTENDS Naturals

Events == {"created", "cancel", "resume"}

RealOrder == [created |-> 0, cancel |-> 1, resume |-> 2]
Second == [created |-> 0, cancel |-> 1, resume |-> 1]
Rank == [created |-> 0, cancel |-> 1, resume |-> 1]
Renews == [created |-> TRUE, cancel |-> FALSE, resume |-> TRUE]

VARIABLES idRank, delivered, stored

vars == <<idRank, delivered, stored>>

Newer(e, f) ==
  \/ Second[e] > Second[f]
  \/ Second[e] = Second[f] /\ Rank[e] > Rank[f]
  \/ Second[e] = Second[f] /\ Rank[e] = Rank[f] /\ idRank[e] > idRank[f]

Init ==
  /\ idRank \in {[created |-> 0, cancel |-> 1, resume |-> 2], [created |-> 0, cancel |-> 2, resume |-> 1]}
  /\ delivered = [e \in Events |-> 0]
  /\ stored = "none"

StripeDelivers(e) ==
  /\ delivered[e] < 2
  /\ delivered' = [delivered EXCEPT ![e] = @ + 1]
  /\ stored' = IF stored = "none" \/ Newer(e, stored) THEN e ELSE stored
  /\ UNCHANGED idRank

Done ==
  /\ \A e \in Events : delivered[e] >= 1
  /\ UNCHANGED vars

Next ==
  \/ \E e \in Events : StripeDelivers(e)
  \/ Done

Spec == Init /\ [][Next]_vars

TypeOK == stored \in Events \cup {"none"}

Latest(S) == CHOOSE e \in S : \A f \in S : RealOrder[f] <= RealOrder[e]

Seen == {e \in Events : delivered[e] > 0}

AccountShowsLatestChange ==
  (\A e \in Events : delivered[e] >= 1) => Renews[stored] = Renews["resume"]

NoRollbackToEarlierSecond ==
  Seen # {} => Second[stored] = Second[Latest(Seen)]
=============================================================================
