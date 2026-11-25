/-!
A stable insertion sort by an integer key. It stands for `Array.toSorted` with an
`Order.mapInput(Order.Number, key)` comparator, which is stable. Core Lean's `List.mergeSort`
does not reduce in the kernel, so `decide` could not check the concrete counterexamples with it.
-/
namespace GateVerify

def insertBy {α : Type} (k : α → Int) (x : α) : List α → List α
  | [] => [x]
  | y :: ys => if k x ≤ k y then x :: y :: ys else y :: insertBy k x ys

def sortBy {α : Type} (k : α → Int) : List α → List α
  | [] => []
  | x :: xs => insertBy k x (sortBy k xs)

theorem mem_insertBy {α : Type} (k : α → Int) (x a : α) (l : List α) :
    a ∈ insertBy k x l ↔ a = x ∨ a ∈ l := by
  induction l with
  | nil => simp [insertBy]
  | cons y ys ih =>
    unfold insertBy
    split
    · simp
    · simp only [List.mem_cons, ih]
      constructor
      · rintro (h | h | h) <;> simp [h]
      · rintro (h | h | h) <;> simp [h]

theorem mem_sortBy {α : Type} (k : α → Int) (a : α) (l : List α) : a ∈ sortBy k l ↔ a ∈ l := by
  induction l with
  | nil => simp [sortBy]
  | cons x xs ih => simp [sortBy, mem_insertBy, ih]

theorem perm_insertBy {α : Type} (k : α → Int) (x : α) (l : List α) :
    (insertBy k x l).Perm (x :: l) := by
  induction l with
  | nil => exact List.Perm.refl _
  | cons y ys ih =>
    unfold insertBy
    split
    · exact List.Perm.refl _
    · exact (List.Perm.cons y ih).trans (List.Perm.swap x y ys)

theorem perm_sortBy {α : Type} (k : α → Int) (l : List α) : (sortBy k l).Perm l := by
  induction l with
  | nil => exact List.Perm.refl _
  | cons x xs ih => exact (perm_insertBy k x _).trans (List.Perm.cons x ih)

theorem sorted_insertBy {α : Type} (k : α → Int) (x : α) (l : List α)
    (h : l.Pairwise (fun a b => k a ≤ k b)) : (insertBy k x l).Pairwise (fun a b => k a ≤ k b) := by
  induction l with
  | nil => simp [insertBy]
  | cons y ys ih =>
    have ⟨hy, hys⟩ := List.pairwise_cons.mp h
    unfold insertBy
    split
    · next hxy =>
      refine List.Pairwise.cons ?_ h
      intro z hz
      rcases List.mem_cons.mp hz with rfl | hz
      · exact hxy
      · exact Int.le_trans hxy (hy z hz)
    · next hxy =>
      refine List.Pairwise.cons ?_ (ih hys)
      intro z hz
      rcases (mem_insertBy k x z ys).mp hz with rfl | hz
      · omega
      · exact hy z hz

theorem sorted_sortBy {α : Type} (k : α → Int) (l : List α) :
    (sortBy k l).Pairwise (fun a b => k a ≤ k b) := by
  induction l with
  | nil => simp [sortBy]
  | cons x xs ih => exact sorted_insertBy k x _ ih

end GateVerify
