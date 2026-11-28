---------------------------- MODULE SavedSearches ----------------------------
(***************************************************************************)
(* Saved searches: save from the board, list and delete on the account     *)
(* page, with requests read or written on the server in any order.        *)
(* Code: apps/web/src/client/saved-searches/update.ts entered,            *)
(* filtersChanged, ClickedDeleteSearch, ClickedSaveSearch,                 *)
(* CompletedDeleteSearch, CompletedFetchSearches, CompletedSaveSearch;     *)
(* board/update.ts withFilters. List reads carry the page's revision;      *)
(* Saving and the save reply carry the filters being saved.                *)
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
  savingF,   \* the filters SaveState.Saving holds
  saveReq,   \* in-flight saves: [f, phase, ok]
  fetches,   \* in-flight list reads: [phase, snap, rev]
  revision,  \* saved-searches model.revision
  deletes,   \* in-flight deletes: [id, phase]
  gone,      \* ids whose delete the page confirmed
  steps

vars == <<server, listState, list, filters, save, savingF, saveReq, fetches, revision, deletes, gone, steps>>

Init ==
  /\ server = {"x"} /\ listState = "Loaded" /\ list = {"x"} /\ filters = "A" /\ save = "Idle"
  /\ savingF = "none" /\ saveReq = {} /\ fetches = {} /\ revision = 0
  /\ deletes = {} /\ gone = {} /\ steps = 0

Tick == steps < 3 /\ steps' = steps + 1

\* entered: refetch, keeping a Loaded list on screen.
ReaderOpensAccount ==
  /\ Tick /\ fetches = {}
  /\ fetches' = {[phase |-> "sent", snap |-> {}, rev |-> revision]}
  /\ listState' = IF listState = "NotAsked" THEN "Loading" ELSE listState
  /\ UNCHANGED <<server, list, filters, save, savingF, saveReq, revision, deletes, gone>>

ServerReadsList ==
  \E r \in fetches :
    /\ r.phase = "sent"
    /\ fetches' = {[r EXCEPT !.phase = "read", !.snap = server]}
    /\ UNCHANGED <<server, listState, list, filters, save, savingF, saveReq, revision, deletes, gone, steps>>

\* A reply read under an older revision is dropped and the list read again.
ListArrives ==
  \E r \in fetches :
    /\ r.phase = "read"
    /\ IF r.rev = revision
         THEN /\ fetches' = {} /\ list' = r.snap /\ listState' = "Loaded"
         ELSE /\ fetches' = {[phase |-> "sent", snap |-> {}, rev |-> revision]}
              /\ UNCHANGED <<list, listState>>
    /\ UNCHANGED <<server, filters, save, savingF, saveReq, revision, deletes, gone, steps>>

ReaderDeletes(id) ==
  /\ Tick /\ listState = "Loaded" /\ id \in list
  /\ ~\E d \in deletes : d.id = id
  /\ deletes' = deletes \cup {[id |-> id, phase |-> "sent"]}
  /\ UNCHANGED <<server, listState, list, filters, save, savingF, saveReq, fetches, revision, gone>>

ServerDeletes ==
  \E d \in deletes :
    /\ d.phase = "sent"
    /\ server' = server \ {d.id}
    /\ deletes' = (deletes \ {d}) \cup {[d EXCEPT !.phase = "done"]}
    /\ UNCHANGED <<listState, list, filters, save, savingF, saveReq, fetches, revision, gone, steps>>

DeleteConfirmed ==
  \E d \in deletes :
    /\ d.phase = "done" /\ deletes' = deletes \ {d}
    /\ list' = IF listState = "Loaded" THEN list \ {d.id} ELSE list
    /\ gone' = gone \cup {d.id} /\ revision' = revision + 1
    /\ UNCHANGED <<server, listState, filters, save, savingF, saveReq, fetches, steps>>

ReaderSavesSearch ==
  /\ Tick /\ save # "Saving" /\ filters \notin server
  /\ save' = "Saving" /\ savingF' = filters
  /\ saveReq' = saveReq \cup {[f |-> filters, phase |-> "sent", ok |-> FALSE]}
  /\ UNCHANGED <<server, listState, list, filters, fetches, revision, deletes, gone>>

ServerSaves ==
  \E q \in saveReq :
    /\ q.phase = "sent"
    /\ IF Cardinality(server) < Cap
         THEN server' = server \cup {q.f} /\ saveReq' = (saveReq \ {q}) \cup {[q EXCEPT !.phase = "done", !.ok = TRUE]}
         ELSE UNCHANGED server /\ saveReq' = (saveReq \ {q}) \cup {[q EXCEPT !.phase = "done"]}
    /\ UNCHANGED <<listState, list, filters, save, savingF, fetches, revision, deletes, gone, steps>>

SaveAnswered ==
  \E q \in saveReq :
    /\ q.phase = "done"
    /\ save' = IF save = "Saving" /\ savingF = q.f
                THEN IF q.ok THEN "Saved" ELSE "Failed"
                ELSE save
    /\ listState' = IF q.ok THEN "NotAsked" ELSE listState
    /\ revision' = IF q.ok THEN revision + 1 ELSE revision
    /\ saveReq' = saveReq \ {q}
    /\ UNCHANGED <<server, list, filters, savingF, fetches, deletes, gone, steps>>

\* filtersChanged keeps Saving only for the filters being saved.
ReaderChangesFilters ==
  /\ Tick /\ filters' = IF filters = "A" THEN "B" ELSE "A"
  /\ save' = IF save = "Saving" /\ savingF = filters' THEN "Saving" ELSE "Idle"
  /\ UNCHANGED <<server, listState, list, savingF, saveReq, fetches, revision, deletes, gone>>

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
