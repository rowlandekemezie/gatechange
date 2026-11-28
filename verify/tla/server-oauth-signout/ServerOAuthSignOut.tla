------------------------- MODULE ServerOAuthSignOut -------------------------
EXTENDS Naturals, FiniteSets

VARIABLES refresh, access, session, out, outLive, outRecent, rot

vars == <<refresh, access, session, out, outLive, outRecent, rot>>

Tokens == {"R1", "R2"}

Init ==
  /\ refresh = [r \in Tokens |-> IF r = "R1" THEN [st |-> "live", sid |-> "S"] ELSE [st |-> "none", sid |-> "none"]]
  /\ access = [r \in Tokens |-> IF r = "R1" THEN "live" ELSE "none"]
  /\ session = "live"
  /\ out = "idle"
  /\ outLive = {}
  /\ outRecent = {}
  /\ rot = "idle"

ClientRefreshRotatesOld ==
  /\ rot = "idle"
  /\ refresh["R1"].st = "live"
  /\ refresh' = [refresh EXCEPT !["R1"].st = "revoked"]
  /\ rot' = "rotated"
  /\ UNCHANGED <<access, session, out, outLive, outRecent>>

ClientRefreshStoresNew ==
  /\ rot = "rotated"
  /\ rot' = "done"
  /\ IF session = "live"
       THEN /\ refresh' = [refresh EXCEPT !["R2"] = [st |-> "live", sid |-> "S"]]
            /\ access' = [access EXCEPT !["R2"] = "live"]
       ELSE UNCHANGED <<refresh, access>>
  /\ UNCHANGED <<session, out, outLive, outRecent>>

MemberSignsOutReadsGrants ==
  /\ out = "idle" /\ session = "live"
  /\ outLive' = {r \in Tokens : refresh[r].sid = "S" /\ refresh[r].st = "live"}
  /\ outRecent' = {r \in Tokens : refresh[r].sid = "S" /\ refresh[r].st # "none"}
  /\ out' = "read"
  /\ UNCHANGED <<refresh, access, session, rot>>

MemberSignsOutRevokes ==
  /\ out = "read"
  /\ refresh' = [r \in Tokens |-> IF r \in outLive THEN [refresh[r] EXCEPT !.st = "revoked"] ELSE refresh[r]]
  /\ access' = [r \in Tokens |-> IF r \in outLive \cup outRecent /\ access[r] = "live" THEN "revoked" ELSE access[r]]
  /\ out' = "revoked"
  /\ UNCHANGED <<session, outLive, outRecent, rot>>

SessionRowDeleted ==
  /\ out = "revoked"
  /\ session' = "gone"
  /\ refresh' = [r \in Tokens |-> IF refresh[r].sid = "S" THEN [refresh[r] EXCEPT !.sid = "none"] ELSE refresh[r]]
  /\ out' = "done"
  /\ UNCHANGED <<access, outLive, outRecent, rot>>

Done ==
  /\ out = "done" /\ rot \in {"idle", "done"}
  /\ UNCHANGED vars

Next ==
  \/ ClientRefreshRotatesOld
  \/ ClientRefreshStoresNew
  \/ MemberSignsOutReadsGrants
  \/ MemberSignsOutRevokes
  \/ SessionRowDeleted
  \/ Done

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ out \in {"idle", "read", "revoked", "done"}
  /\ rot \in {"idle", "rotated", "done"}
  /\ session \in {"live", "gone"}

SignOutEndsEveryConnection ==
  out = "done" =>
    /\ \A r \in Tokens : refresh[r].st # "live"
    /\ \A r \in Tokens : access[r] # "live"

ConnectionsLiveWhileSignedIn ==
  (out = "idle" /\ rot = "idle") => refresh["R1"].st = "live"
=============================================================================
