import Lean.Data.Json
import GateVerify

open Lean (Json toJson)
open GateVerify

/-! Writes `fixtures/gate-verify.json`: inputs and the Lean copy's outputs, for the drift test
`packages/job-store/test/state-machines.lean-fixtures.test.ts`. -/

structure Lcg where
  seed : Nat

def Lcg.next (g : Lcg) (bound : Nat) : Nat × Lcg :=
  let s := (g.seed * 6364136223846793005 + 1442695040888963407) % 18446744073709551616
  ((s / 65536) % bound, ⟨s⟩)

def NOW : Int := 1760000000000
def HOUR : Int := 3600000

def str (s : String) : Json := Json.str s

def feedCase (g : Lcg) : Json × Lcg := Id.run do
  let mut g := g
  let (n, g1) := g.next 8; g := g1
  let (limit, g2) := g.next 6; g := g2
  let mut catalog : List Feed.Feed := []
  let mut rows : List (String × Feed.FeedState) := []
  for i in [0:n + 1] do
    let (iv, g3) := g.next 3; g := g3
    let interval := [120, 180, 720].getD iv 180
    let key := s!"feed-{i}"
    catalog := catalog ++ [⟨key, interval⟩]
    let (present, g4) := g.next 4; g := g4
    if present != 0 then
      let (fails, g5) := g.next 7; g := g5
      let (hasAttempt, g6) := g.next 5; g := g6
      let (ago, g7) := g.next 60; g := g7
      let last : Option Int := if hasAttempt == 0 then none else some (NOW - HOUR * ago / 2)
      rows := rows ++ [(key, ⟨fails, last⟩)]
  let st : Feed.States := fun k => rows.lookup k
  let selected := Feed.selectDue catalog st NOW limit
  let catalogJson := catalog.map fun f =>
    Json.mkObj [("key", str f.key), ("minIntervalMinutes", toJson f.minInterval)]
  let statesJson := rows.map fun (k, s) =>
    Json.mkObj [("key", str k), ("consecutiveFailures", toJson s.failures),
      ("lastAttemptAt", match s.lastAttempt with | none => Json.null | some v => toJson v)]
  let backoffs := catalog.map fun f => toJson (Feed.backoffMinutes f (st f.key))
  (Json.mkObj [("catalog", Json.arr catalogJson.toArray), ("states", Json.arr statesJson.toArray),
    ("now", toJson NOW), ("limit", toJson limit),
    ("selected", Json.arr (selected.map (fun f => str f.key)).toArray),
    ("backoffMinutes", Json.arr backoffs.toArray)], g)

def companies : List String :=
  ["Acme", "Acme Inc.", "acme", "Acme | Labs", "Acme", "株式会社メルカリ", "ソニー株式会社", "Globex"]

def titles : List String :=
  ["Engineering Manager", "Engineering Manager, C++", "Engineering Manager, C", "Labs | Engineering Manager",
   "Director of Engineering", "VP, Engineering", "Head of Platform Engineering"]

def sources : List String :=
  ["Greenhouse", "Lever", "Ashby", "HackerNews", "Remotive", "RemoteOK", "Himalayas"]

def pad (n : Nat) : String :=
  let s := toString n
  String.ofList (List.replicate (4 - s.length) '0') ++ s

def insertRanked (lt : α → α → Bool) (x : α) : List α → List α
  | [] => [x]
  | y :: ys => if lt x y then x :: y :: ys else y :: insertRanked lt x ys

def sortRanked (lt : α → α → Bool) : List α → List α
  | [] => []
  | x :: xs => insertRanked lt x (sortRanked lt xs)

def listingCase (base : Nat) (g : Lcg) : Json × Lcg := Id.run do
  let mut g := g
  let (n, g1) := g.next 8; g := g1
  let mut rows : List (Dedup.Row × Int) := []
  for i in [0:n + 1] do
    let (c, g2) := g.next companies.length; g := g2
    let (t, g3) := g.next titles.length; g := g3
    let (s, g4) := g.next sources.length; g := g4
    let (age, g5) := g.next 20; g := g5
    let (rel, g6) := g.next 28; g := g6
    let row : Dedup.Row := ⟨base + i, sources.getD s "Greenhouse", companies.getD c "Acme",
      titles.getD t "Engineering Manager", (NOW - age * 86400000).toNat⟩
    rows := rows ++ [(row, (30 + rel : Int))]
  let kept := Dedup.dedup (rows.map (·.1))
  let ranked := kept.filterMap fun r =>
    (rows.find? (·.1.id == r.id)).map fun (_, rel) => (⟨r.id, rel, r.postedAt⟩ : Relevance.Ranked)
  let ordered := sortRanked (Relevance.ranksBefore NOW) ranked
  let rowsJson := rows.map fun (r, rel) =>
    Json.mkObj [("id", str s!"j-{pad r.id}"), ("source", str r.source), ("company", str r.company),
      ("title", str r.title), ("postedAt", toJson r.postedAt), ("relevance", toJson rel)]
  (Json.mkObj [("rows", Json.arr rowsJson.toArray),
    ("relevanceOrder", Json.arr (ordered.map fun r => str s!"j-{pad r.id}").toArray)], g)

def fingerprintCases : List (String × String) :=
  (companies.flatMap fun c => titles.map fun t => (c, t)) ++
  [("Société Générale", "Directeur, Engineering"), ("Zürich  Re", "Head of   Engineering!")]

def ids : List String :=
  ["greenhouse:acme:4012345", "lever:globex:9f1c2d3e-aaaa", "hackernews:who-is-hiring-november-2026:41234567",
   "remotive:engineering-manager:1", "ashby:株式会社:eu/42", "a", "ab", "abc", "abcd", "greenhouse:zürich:ü?&=#"]

open Relevance in
def roleNames : List (String × Role) :=
  [("VicePresident", .vicePresident), ("HeadOfEngineering", .headOfEngineering),
   ("Director", .director), ("EngineeringManager", .engineeringManager)]

open Relevance in
def regionNames : List (String × Region) :=
  [("RemoteCanada", .remoteCanada), ("RemoteNorthAmerica", .remoteNorthAmerica),
   ("RemoteUnitedStates", .remoteUnitedStates), ("RemoteGlobal", .remoteGlobal),
   ("BritishColumbia", .britishColumbia), ("CanadaOnsite", .canadaOnsite),
   ("UnitedStatesOnsite", .unitedStatesOnsite), ("Elsewhere", .elsewhere)]

def nameOf (r : Relevance.Region) : String :=
  ((regionNames.find? (·.2 == r)).map (·.1)).getD "?"

def selections : List (List Relevance.Region) :=
  [[.remoteCanada], [.remoteUnitedStates], [.remoteCanada, .remoteUnitedStates],
   [.britishColumbia, .remoteCanada], [.remoteGlobal, .remoteCanada], [.elsewhere], [],
   [.remoteNorthAmerica, .remoteUnitedStates, .canadaOnsite]]

def main : IO Unit := do
  let mut g : Lcg := ⟨20261125⟩
  let mut feeds : Array Json := #[]
  for _ in [0:300] do
    let (j, g') := feedCase g
    feeds := feeds.push j; g := g'
  let mut listings : Array Json := #[]
  for i in [0:60] do
    let (j, g') := listingCase (i * 10) g
    listings := listings.push j; g := g'
  let fingerprints := fingerprintCases.map fun (c, t) =>
    Json.mkObj [("company", str c), ("title", str t), ("fingerprint", str (Dedup.fingerprint c t))]
  let segments := ids.map fun id =>
    Json.mkObj [("id", str id), ("segment", str (String.ofList (JobId.segmentOf id)))]
  let roleWeights := roleNames.map fun (n, r) =>
    Json.mkObj [("role", str n), ("weight", toJson (Relevance.roleWeight r))]
  let regionWeights := regionNames.map fun (n, r) =>
    Json.mkObj [("region", str n), ("weight", toJson (Relevance.regionWeight r))]
  let selectionsJson := selections.map fun s =>
    Json.mkObj [("selection", Json.arr (s.map (str ∘ nameOf)).toArray),
      ("regions", Json.arr ((Region.regionsOfSelection s).map (str ∘ nameOf)).toArray)]
  let out := Json.mkObj [
    ("feeds", Json.arr feeds), ("listings", Json.arr listings),
    ("fingerprints", Json.arr fingerprints.toArray), ("segments", Json.arr segments.toArray),
    ("roleWeights", Json.arr roleWeights.toArray), ("regionWeights", Json.arr regionWeights.toArray),
    ("selections", Json.arr selectionsJson.toArray)]
  IO.FS.createDirAll "fixtures"
  IO.FS.writeFile "fixtures/gate-verify.json" (out.pretty ++ "\n")
  IO.println s!"wrote fixtures/gate-verify.json: {feeds.size} feed cases, {listings.size} listing cases"
