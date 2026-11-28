------------------------------- MODULE Billing -------------------------------
(***************************************************************************)
(* Membership and checkout in one page lifetime: the sign-in check, the    *)
(* membership fetch and polls, choosing a plan, and signing out.           *)
(* Code: apps/web/src/client/billing/update.ts signedIn (37), signedOut    *)
(* (47), entered (52), fetched (66), ClickedChoosePlan (98),               *)
(* FailedBillingAction (127); billing/command.ts FetchMembership (53),     *)
(* PollMembership (58); board/update.ts followedBilling (685).             *)
(* A membership request carries the session cookie it was sent with.      *)
(* Sign-out is folded into one step (SignOut, CompletedSignOut, session    *)
(* check answers signed out), during which replies may still arrive.       *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

VARIABLES
  plan,        \* the reader's real plan: "Free" or "Pro"
  session,     \* "checking", "in", "out"
  membership,  \* "Unknown", "Loading", "Free", "Pro", "Failed"
  action,      \* "Idle", "Redirecting", "Problem"
  pending,     \* membership requests in flight: the session they were sent as
  checkouts,   \* checkout requests in flight
  sent         \* bound on requests

vars == <<plan, session, membership, action, pending, checkouts, sent>>

Init ==
  /\ plan \in {"Free", "Pro"} /\ session = "checking" /\ membership = "Unknown"
  /\ action = "Idle" /\ pending = {} /\ checkouts = 0 /\ sent = 0

Ask(as) == pending' = pending \cup {[as |-> as, n |-> sent]} /\ sent' = sent + 1

SessionSaysSignedIn ==
  /\ session = "checking" /\ session' = "in"
  /\ membership' = IF membership = "Unknown" THEN "Loading" ELSE membership
  /\ Ask("in")
  /\ UNCHANGED <<plan, action, checkouts>>

\* Account or Pricing page entered while signed in: entered fetches again.
ReaderOpensAccount ==
  /\ session = "in" /\ sent < 3
  /\ action' = "Idle" /\ Ask("in")
  /\ UNCHANGED <<plan, session, membership, checkouts>>

ReaderSignsOut ==
  /\ session = "in" /\ session' = "out"
  /\ membership' = "Unknown" /\ action' = "Idle"
  /\ UNCHANGED <<plan, pending, checkouts, sent>>

MembershipArrives ==
  \E p \in pending :
    /\ pending' = pending \ {p}
    /\ membership' = IF p.as = "in" THEN plan
                     ELSE IF membership \in {"Free", "Pro"} THEN membership ELSE "Failed"
    /\ UNCHANGED <<plan, session, action, checkouts, sent>>

ReaderChoosesPlan ==
  /\ session = "in" /\ membership = "Free" /\ action # "Redirecting"
  /\ action' = "Redirecting" /\ checkouts' = checkouts + 1
  /\ UNCHANGED <<plan, session, membership, pending, sent>>

CheckoutFails ==
  /\ checkouts > 0 /\ checkouts' = checkouts - 1
  /\ action' = "Problem"
  /\ UNCHANGED <<plan, session, membership, pending, sent>>

Done == pending = {} /\ UNCHANGED vars

Next ==
  \/ SessionSaysSignedIn \/ ReaderOpensAccount \/ ReaderSignsOut
  \/ MembershipArrives \/ ReaderChoosesPlan \/ CheckoutFails \/ Done

Spec == Init /\ [][Next]_vars

Bounded == checkouts <= 2

TypeOK == membership \in {"Unknown", "Loading", "Free", "Pro", "Failed"}

\* After signing out, the header shows Pricing, not a Pro badge.
NoProBadgeSignedOut == session = "out" => membership # "Pro"

\* The badge never claims Pro for a reader who does not have it.
BadgeTellsTruth == membership = "Pro" => plan = "Pro"

\* A double click on a plan opens one Stripe checkout, not two.
OneCheckoutAtATime == checkouts <= 1
=============================================================================
