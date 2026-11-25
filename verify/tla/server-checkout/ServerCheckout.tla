---------------------------- MODULE ServerCheckout ----------------------------
EXTENDS Naturals, FiniteSets

Tabs == {"t1", "t2"}

VARIABLES tab, subs, applied

vars == <<tab, subs, applied>>

Pro == applied > 0

Init ==
  /\ tab = [t \in Tabs |-> "pricing"]
  /\ subs = 0
  /\ applied = 0

MemberStartsCheckout(t) ==
  /\ tab[t] = "pricing"
  /\ tab' = [tab EXCEPT ![t] = IF Pro THEN "refused" ELSE "checkout"]
  /\ UNCHANGED <<subs, applied>>

MemberPaysInStripe(t) ==
  /\ tab[t] = "checkout"
  /\ tab' = [tab EXCEPT ![t] = "paid"]
  /\ subs' = subs + 1
  /\ UNCHANGED applied

WebhookGrantsPro ==
  /\ applied < subs
  /\ applied' = applied + 1
  /\ UNCHANGED <<tab, subs>>

MemberAbandons(t) ==
  /\ tab[t] = "checkout"
  /\ tab' = [tab EXCEPT ![t] = "abandoned"]
  /\ UNCHANGED <<subs, applied>>

Done ==
  /\ \A t \in Tabs : tab[t] \in {"paid", "refused", "abandoned"}
  /\ applied = subs
  /\ UNCHANGED vars

Next ==
  \/ \E t \in Tabs : MemberStartsCheckout(t) \/ MemberPaysInStripe(t) \/ MemberAbandons(t)
  \/ WebhookGrantsPro
  \/ Done

Spec == Init /\ [][Next]_vars

TypeOK == subs \in 0..2 /\ applied \in 0..subs

ChargedForOneProAtMost == subs <= 1

ProMemberCannotStartCheckout ==
  \A t \in Tabs : tab[t] = "refused" => Pro
=============================================================================
