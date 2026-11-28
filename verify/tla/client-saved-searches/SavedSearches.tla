---------------------------- MODULE SavedSearches ----------------------------
(***************************************************************************)
(* Saved searches: save from the board, list and delete on the account     *)
(* page, with requests read or written on the server in any order.        *)
(* Code: apps/web/src/client/saved-searches/update.ts entered (29),        *)
(* filtersChanged (36), ClickedDeleteSearch (46), ClickedSaveSearch (50),  *)
(* CompletedDeleteSearch (57), CompletedFetchSearches (68),                *)
(* CompletedSaveSearch (77); board/update.ts withFilters (264).            *)
(* "x" is a search saved earlier; "A" and "B" are board filter sets.       *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

Cap == 2

VARIABLES
  server,    \* saved searches in D1
  listState, \* "NotAsked", "Loading", "Loaded"
  list,      \* the account page list when Loaded
  filters,   \* board filters on screen
  save,      \* "Idle", "Saving", "Saved", "Failed"
  saveReq,   \* in-flight save: {} or {[f, phase, ok]}
  fetches,   \* in-flight list reads: [phase, snap]
  deletes,   \* in-flight deletes: [id, phase]
  gone,      \* ids whose delete the page confirmed
  steps

vars == <<server, listState, list, filters, save, saveReq, fetches, deletes, gone, steps>>

Init ==
  /\ server = {"x"} /\ listState = "Loaded" /\ list = {"x"} /\ filters = "A" /\ save = "Idle"
  /\ saveReq = {} /\ fetches = {} /\ deletes = {} /\ gone = {} /\ steps = 0

Tick == steps < 3 /\ steps' = steps + 1

\* entered: refetch, keeping a Loaded list on screen.
ReaderOpensAccount ==
  /\ Tick /\ fetches = {}
  /\ fetches' = {[phase |-> "sent", snap |-> {}]}
  /\ listState' = IF listState = "NotAsked" THEN "Loading" ELSE listState
  /\ UNCHANGED <<server, list, filters, save, saveReq, deletes, gone>>

ServerReadsList ==
  \E r \in fetches :
    /\ r.phase = "sent"
    /\ fetches' = {[phase |-> "read", snap |-> server]}
    /\ UNCHANGED <<server, listState, list, filters, save, saveReq, deletes, gone, steps>>

ListArrives ==
  \E r \in fetches :
    /\ r.phase = "read" /\ fetches' = {}
    /\ list' = r.snap /\ listState' = "Loaded"
    /\ UNCHANGED <<server, filters, save, saveReq, deletes, gone, steps>>

ReaderDeletes(id) ==
  /\ Tick /\ listState = "Loaded" /\ id \in list
  /\ ~\E d \in deletes : d.id = id
  /\ deletes' = deletes \cup {[id |-> id, phase |-> "sent"]}
  /\ UNCHANGED <<server, listState, list, filters, save, saveReq, fetches, gone>>

ServerDeletes ==
  \E d \in deletes :
    /\ d.phase = "sent"
    /\ server' = server \ {d.id}
    /\ deletes' = (deletes \ {d}) \cup {[d EXCEPT !.phase = "done"]}
    /\ UNCHANGED <<listState, list, filters, save, saveReq, fetches, gone, steps>>

DeleteConfirmed ==
  \E d \in deletes :
    /\ d.phase = "done" /\ deletes' = deletes \ {d}
    /\ list' = IF listState = "Loaded" THEN list \ {d.id} ELSE list
    /\ gone' = gone \cup {d.id}
    /\ UNCHANGED <<server, listState, filters, save, saveReq, fetches, steps>>

ReaderSavesSearch ==
  /\ Tick /\ save # "Saving" /\ saveReq = {} /\ filters \notin server
  /\ save' = "Saving" /\ saveReq' = {[f |-> filters, phase |-> "sent", ok |-> FALSE]}
  /\ UNCHANGED <<server, listState, list, filters, fetches, deletes, gone>>

ServerSaves ==
  \E q \in saveReq :
    /\ q.phase = "sent"
    /\ IF Cardinality(server) < Cap
         THEN server' = server \cup {q.f} /\ saveReq' = {[q EXCEPT !.phase = "done", !.ok = TRUE]}
         ELSE UNCHANGED server /\ saveReq' = {[q EXCEPT !.phase = "done"]}
    /\ UNCHANGED <<listState, list, filters, save, fetches, deletes, gone, steps>>

SaveAnswered ==
  \E q \in saveReq :
    /\ q.phase = "done"
    /\ save' = IF q.ok THEN "Saved" ELSE "Failed"
    /\ listState' = IF q.ok THEN "NotAsked" ELSE listState
    /\ saveReq' = {}
    /\ UNCHANGED <<server, list, filters, fetches, deletes, gone, steps>>

\* filtersChanged keeps Saving and resets the rest to Idle.
ReaderChangesFilters ==
  /\ Tick /\ filters' = IF filters = "A" THEN "B" ELSE "A"
  /\ save' = IF save = "Saving" THEN "Saving" ELSE "Idle"
  /\ UNCHANGED <<server, listState, list, saveReq, fetches, deletes, gone>>

Done == saveReq = {} /\ fetches = {} /\ deletes = {} /\ UNCHANGED vars

Next ==
  \/ ReaderOpensAccount \/ ServerReadsList \/ ListArrives
  \/ ReaderDeletes("x") \/ ServerDeletes \/ DeleteConfirmed
  \/ ReaderSavesSearch \/ ServerSaves \/ SaveAnswered \/ ReaderChangesFilters
  \/ Done

Spec == Init /\ [][Next]_vars

TypeOK == save \in {"Idle", "Saving", "Saved", "Failed"}

Shown == IF listState = "Loaded" THEN list ELSE {}

\* A search I deleted, once the page confirmed it, does not come back.
DeletedStaysGone == Shown \cap gone = {}

\* "Saved. We email new matches" only sits under filters that are saved.
SavedNoteIsTrue == save = "Saved" => filters \in server

\* The server never holds more saved searches than the cap.
CapHolds == Cardinality(server) <= Cap
=============================================================================
