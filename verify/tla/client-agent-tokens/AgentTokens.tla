----------------------------- MODULE AgentTokens -----------------------------
(***************************************************************************)
(* Agent tokens on the account page: create (secret shown once), revoke,   *)
(* the server cap, and leaving the page while a request is out.            *)
(* Code: apps/web/src/client/agent-tokens/update.ts invalidated (25),      *)
(* entered (30), submitted (44), the generation gate (59),                 *)
(* ClickedRevokeToken (67), CompletedIssueToken (86),                      *)
(* CompletedRevokeToken (101), FailedIssueToken (115); model.ts canIssue   *)
(* (38); board/update.ts entered (416) invalidates on leaving Account.     *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

Cap == 2

VARIABLES
  route,     \* "account" or "board"
  gen,       \* agentTokens.generation
  issue,     \* "Idle", "Issuing", "Issued", "Refused"
  server,    \* tokens on the server
  revealed,  \* tokens whose secret the page showed
  next,      \* next token id
  issues,    \* in-flight issue requests: [gen, phase, id]
  revokes,   \* in-flight revokes: [gen, id]
  revoking,  \* ids the page marks Revoking
  listed,    \* tokens listed on the page
  steps

vars == <<route, gen, issue, server, revealed, next, issues, revokes, revoking, listed, steps>>

Init ==
  /\ route = "account" /\ gen = 1 /\ issue = "Idle" /\ server = {}
  /\ revealed = {} /\ next = 1 /\ issues = {} /\ revokes = {}
  /\ revoking = {} /\ listed = {} /\ steps = 0

Tick == steps < 4 /\ steps' = steps + 1

ReaderCreates ==
  /\ Tick /\ route = "account" /\ issue # "Issuing"
  /\ issue' = "Issuing"
  /\ issues' = issues \cup {[gen |-> gen, n |-> steps, phase |-> "sent", id |-> 0]}
  /\ UNCHANGED <<route, gen, server, revealed, next, revokes, revoking, listed>>

ServerIssues ==
  \E r \in issues :
    /\ r.phase = "sent"
    /\ IF Cardinality(server) < Cap
         THEN /\ server' = server \cup {next} /\ next' = next + 1
              /\ issues' = (issues \ {r}) \cup {[r EXCEPT !.phase = "ok", !.id = next]}
         ELSE /\ issues' = (issues \ {r}) \cup {[r EXCEPT !.phase = "limit"]}
              /\ UNCHANGED <<server, next>>
    /\ UNCHANGED <<route, gen, issue, revealed, revokes, revoking, listed, steps>>

IssueAnswers ==
  \E r \in issues :
    /\ r.phase \in {"ok", "limit"} /\ issues' = issues \ {r}
    /\ IF route = "account" /\ r.gen = gen /\ issue = "Issuing"
         THEN IF r.phase = "ok"
                THEN /\ issue' = "Issued" /\ revealed' = revealed \cup {r.id}
                     /\ listed' = listed \cup {r.id}
                ELSE /\ issue' = "Refused" /\ UNCHANGED <<revealed, listed>>
         ELSE UNCHANGED <<issue, revealed, listed>>
    /\ UNCHANGED <<route, gen, server, next, revokes, revoking, steps>>

ReaderRevokes(id) ==
  /\ Tick /\ route = "account" /\ id \in listed /\ id \notin revoking
  /\ revoking' = revoking \cup {id}
  /\ revokes' = revokes \cup {[gen |-> gen, id |-> id]}
  /\ UNCHANGED <<route, gen, issue, server, revealed, next, issues, listed>>

RevokeAnswers ==
  \E r \in revokes :
    /\ revokes' = revokes \ {r} /\ server' = server \ {r.id}
    /\ IF route = "account" /\ r.gen = gen /\ r.id \in revoking
         THEN revoking' = revoking \ {r.id} /\ listed' = listed \ {r.id}
         ELSE UNCHANGED <<revoking, listed>>
    /\ UNCHANGED <<route, gen, issue, revealed, next, issues, steps>>

ReaderLeaves ==
  /\ Tick /\ route = "account" /\ route' = "board" /\ gen' = gen + 1
  /\ issue' = "Idle" /\ revoking' = {} /\ listed' = {}
  /\ UNCHANGED <<server, revealed, next, issues, revokes>>

\* entered: fetch the list again; the fetch is folded into the step.
ReaderComesBack ==
  /\ route = "board" /\ route' = "account" /\ gen' = gen + 1
  /\ issue' = "Idle" /\ revoking' = {} /\ listed' = server
  /\ UNCHANGED <<server, revealed, next, issues, revokes, steps>>

Done == issues = {} /\ revokes = {} /\ UNCHANGED vars

Next ==
  \/ ReaderCreates \/ ServerIssues \/ IssueAnswers
  \/ ReaderRevokes(1) \/ ReaderRevokes(2) \/ RevokeAnswers
  \/ ReaderLeaves \/ ReaderComesBack \/ Done

Spec == Init /\ [][Next]_vars

TypeOK == issue \in {"Idle", "Issuing", "Issued", "Refused"}

Issued == {r \in issues : r.phase = "ok"}

\* Every token the server made had its secret shown, or is still on its way.
EverySecretShown ==
  \A id \in server : id \in revealed \/ \E r \in Issued : r.id = id

\* A double tap on Create sends one request, never two, for one page visit.
OneCreateAtATime == \A a, b \in issues : a.gen = b.gen => a = b

\* The server never holds more than the cap.
CapHolds == Cardinality(server) <= Cap

\* The secret is never on screen after you leave the account page.
SecretGoneAfterLeaving == route = "board" => issue # "Issued"
=============================================================================
