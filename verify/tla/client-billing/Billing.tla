------------------------------- MODULE Billing -------------------------------
(***************************************************************************)
(* Membership and checkout in one page lifetime: the sign-in check, the    *)
(* membership fetch and polls, choosing a plan, and signing out.           *)
(* Code: apps/web/src/client/billing/update.ts signedIn (37), signedOut    *)
(* (47), entered (52), fetched (66), ClickedChoosePlan (98),               *)
(* FailedBillingAction (127); billing/command.ts FetchMembership (53),     *)
(* PollMembership (58); board/update.ts followedBilling (685).             *)
(* A membership request carries the generation it was sent in; sign-out  *)
(* bumps the generation, so an older reply is dropped.                     *)
(* Sign-out is folded into one step (SignOut, CompletedSignOut, session    *)
(* check answers signed out), during which replies may still arrive.       *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

VARIABLES
  plan,        \* the reader's real plan: "Free" or "Pro"
  session,     \* "checking", "in", "out"
  membership,  \* "Unknown", "Loading", "Free", "Pro", "Failed"
  action,      \* "Idle", "Redirecting", "Problem"
  gen,         \* billing.generation, bumped by signedOut
  pending,     \* membership requests in flight: the generation they were sent in
  checkouts,   \* checkout requests in flight
  sent         \* bound on requests

vars == <<plan, session, membership, action, gen, pending, checkouts, sent>>

Init ==
  /\ plan \in {"Free", "Pro"} /\ session = "checking" /\ membership = "Unknown"
  /\ action = "Idle" /\ gen = 0 /\ pending = {} /\ checkouts = 0 /\ sent = 0

Ask == pending' = pending \cup {[gen |-> gen, n |-> sent]} /\ sent' = sent + 1

SessionSaysSignedIn ==
  /\ session = "checking" /\ session' = "in"
  /\ membership' = IF membership = "Unknown" THEN "Loading" ELSE membership
  /\ Ask
  /\ UNCHANGED <<plan, action, gen, checkouts>>

\* Account or Pricing page entered while signed in: entered fetches again
\* and clears a shown Problem, but keeps a checkout that is opening.
ReaderOpensAccount ==
  /\ session = "in" /\ sent < 3
  /\ action' = IF action = "Problem" THEN "Idle" ELSE action
  /\ Ask
  /\ UNCHANGED <<plan, session, membership, gen, checkouts>>

ReaderSignsOut ==
  /\ session = "in" /\ session' = "out"
  /\ membership' = "Unknown" /\ action' = "Idle" /\ gen' = gen + 1
  /\ UNCHANGED <<plan, pending, checkouts, sent>>

MembershipArrives ==
  \E p \in pending :
    /\ pending' = pending \ {p}
    /\ membership' = IF p.gen = gen THEN plan ELSE membership
    /\ UNCHANGED <<plan, session, action, gen, checkouts, sent>>

ReaderChoosesPlan ==
  /\ session = "in" /\ membership = "Free" /\ action \in {"Idle", "Problem"}
  /\ action' = "Redirecting" /\ checkouts' = checkouts + 1
  /\ UNCHANGED <<plan, session, membership, gen, pending, sent>>

CheckoutFails ==
  /\ checkouts > 0 /\ checkouts' = checkouts - 1
  /\ action' = "Problem"
  /\ UNCHANGED <<plan, session, membership, gen, pending, sent>>

Done == pending = {} /\ UNCHANGED vars

Next ==
  \/ SessionSaysSignedIn \/ ReaderOpensAccount \/ ReaderSignsOut
  \/ MembershipArrives \/ ReaderChoosesPlan \/ CheckoutFails \/ Done

Spec == Init /\ [][Next]_vars

Bounded == checkouts <= 2 /\ gen <= 2

TypeOK == membership \in {"Unknown", "Loading", "Free", "Pro", "Failed"}

\* After signing out, the header shows Pricing, not a Pro badge.
NoProBadgeSignedOut == session = "out" => membership # "Pro"

\* The badge never claims Pro for a reader who does not have it.
BadgeTellsTruth == membership = "Pro" => plan = "Pro"

\* A double click on a plan opens one Stripe checkout, not two.
OneCheckoutAtATime == checkouts <= 1
=============================================================================
