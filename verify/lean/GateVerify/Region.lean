import GateVerify.Relevance

/-!
Region groups, copied from `regionsOfGroup` and `regionsOfSelection` in `packages/core/src/job.ts`.
-/
namespace GateVerify.Region

open GateVerify.Relevance (Region)
open GateVerify.Relevance.Region

def all : List Region :=
  [remoteCanada, remoteNorthAmerica, remoteUnitedStates, remoteGlobal,
   britishColumbia, canadaOnsite, unitedStatesOnsite, elsewhere]

def regionsOfSelected : Region → List Region
  | remoteCanada => [remoteCanada, remoteNorthAmerica, remoteGlobal]
  | remoteUnitedStates => [remoteUnitedStates, remoteNorthAmerica, remoteGlobal]
  | r => [r]

def dedupeFirst (l : List Region) : List Region :=
  l.foldl (fun acc x => if acc.contains x then acc else acc ++ [x]) []

def regionsOfSelection (selection : List Region) : List Region :=
  dedupeFirst (selection.flatMap regionsOfSelected)

theorem selected_in_own_group : ∀ r ∈ all, r ∈ regionsOfSelected r := by decide

theorem remote_groups_take_worldwide :
    remoteGlobal ∈ regionsOfSelected remoteCanada ∧ remoteGlobal ∈ regionsOfSelected remoteUnitedStates ∧
    remoteNorthAmerica ∈ regionsOfSelected remoteCanada ∧
    remoteNorthAmerica ∈ regionsOfSelected remoteUnitedStates := by decide

theorem onsite_groups_stay_onsite :
    ∀ r ∈ [britishColumbia, canadaOnsite, unitedStatesOnsite, elsewhere], regionsOfSelected r = [r] := by
  decide

theorem expansion_closed : ∀ r ∈ all, ∀ x ∈ regionsOfSelected r,
    ∀ y ∈ regionsOfSelected x, y ∈ regionsOfSelected r := by decide

theorem every_region_listed (r : Region) : r ∈ all := by cases r <;> decide

theorem mem_dedupeFirst_aux (acc l : List Region) (x : Region) :
    x ∈ l.foldl (fun acc x => if acc.contains x then acc else acc ++ [x]) acc ↔ x ∈ acc ∨ x ∈ l := by
  induction l generalizing acc with
  | nil => simp
  | cons y ys ih =>
    simp only [List.foldl_cons]
    rw [ih]
    split
    · next h =>
      have : y ∈ acc := by simpa using h
      constructor
      · rintro (h | h)
        · exact Or.inl h
        · exact Or.inr (List.mem_cons_of_mem _ h)
      · rintro (h | h)
        · exact Or.inl h
        · rcases List.mem_cons.mp h with rfl | h
          · exact Or.inl this
          · exact Or.inr h
    · simp [List.mem_append, or_assoc]

theorem mem_regionsOfSelection (s : List Region) (x : Region) :
    x ∈ regionsOfSelection s ↔ ∃ r ∈ s, x ∈ regionsOfSelected r := by
  unfold regionsOfSelection dedupeFirst
  rw [mem_dedupeFirst_aux]
  simp

/-- Expanding a selection twice gives the same regions as expanding it once. -/
theorem selection_idempotent (s : List Region) (x : Region) :
    x ∈ regionsOfSelection (regionsOfSelection s) ↔ x ∈ regionsOfSelection s := by
  simp only [mem_regionsOfSelection]
  constructor
  · rintro ⟨r, ⟨q, hq, hr⟩, hx⟩
    exact ⟨q, hq, expansion_closed q (every_region_listed q) r hr x hx⟩
  · rintro ⟨q, hq, hx⟩
    exact ⟨q, ⟨q, hq, selected_in_own_group q (every_region_listed q)⟩, hx⟩

theorem selection_keeps_choice (s : List Region) (r : Region) (h : r ∈ s) : r ∈ regionsOfSelection s :=
  (mem_regionsOfSelection s r).mpr ⟨r, h, selected_in_own_group r (every_region_listed r)⟩

end GateVerify.Region
