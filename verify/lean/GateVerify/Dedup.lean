/-!
Duplicate collapse for `listJobs`, copied from `packages/job-store/src/queries.ts`
(`ROW_NUMBER() OVER (PARTITION BY fingerprint ORDER BY sourcePriority, posted_at, id)`,
kept where `duplicate_rank = 1`) and `fingerprintOf` in `packages/core/src/job-store.ts`.
-/
namespace GateVerify.Dedup

def keepChar (c : Char) : Bool := c.isLower || c.isDigit || c == '|'

def fingerprint (company title : String) : String :=
  String.ofList (((company ++ "|" ++ title).toList.map Char.toLower).filter keepChar)

def sourcePriority : String → Nat
  | "Greenhouse" | "Lever" | "Ashby" | "Workable" | "SmartRecruiters" => 0
  | "HackerNews" => 1
  | _ => 2

structure Row where
  id : Nat
  source : String
  company : String
  title : String
  postedAt : Nat
deriving Repr, DecidableEq

def Row.fp (r : Row) : String := fingerprint r.company r.title

def before (a b : Row) : Bool :=
  decide (sourcePriority a.source < sourcePriority b.source) ||
  (decide (sourcePriority a.source = sourcePriority b.source) &&
    (decide (a.postedAt < b.postedAt) || (decide (a.postedAt = b.postedAt) && decide (a.id < b.id))))

def keeps (l : List Row) (j : Row) : Bool :=
  !(l.any fun k => decide (k.fp = j.fp) && before k j)

def dedup (l : List Row) : List Row := l.filter (keeps l)

theorem before_irrefl (a : Row) : before a a = false := by
  simp [before]

theorem before_trans {a b c : Row} (h1 : before a b = true) (h2 : before b c = true) :
    before a c = true := by
  simp only [before, Bool.or_eq_true, Bool.and_eq_true, decide_eq_true_eq] at *
  omega

theorem before_total {a b : Row} (h : a.id ≠ b.id) : before a b = true ∨ before b a = true := by
  simp only [before, Bool.or_eq_true, Bool.and_eq_true, decide_eq_true_eq]
  omega

theorem keeps_perm {l₁ l₂ : List Row} (hp : l₁.Perm l₂) (j : Row) : keeps l₁ j = keeps l₂ j := by
  unfold keeps
  congr 1
  apply Bool.eq_iff_iff.mpr
  simp only [List.any_eq_true]
  exact ⟨fun ⟨x, hx, h⟩ => ⟨x, hp.mem_iff.mp hx, h⟩, fun ⟨x, hx, h⟩ => ⟨x, hp.mem_iff.mpr hx, h⟩⟩

/-- Order independence: any reordering of the rows gives the same rows back, reordered. -/
theorem dedup_order_independent {l₁ l₂ : List Row} (hp : l₁.Perm l₂) :
    (dedup l₁).Perm (dedup l₂) := by
  unfold dedup
  have : l₁.filter (keeps l₁) = l₁.filter (keeps l₂) :=
    List.filter_congr (fun j _ => keeps_perm hp j)
  rw [this]
  exact hp.filter _

theorem mem_dedup {l : List Row} {j : Row} :
    j ∈ dedup l ↔ j ∈ l ∧ ∀ k ∈ l, k.fp = j.fp → before k j = false := by
  unfold dedup keeps
  simp only [List.mem_filter, Bool.not_eq_true', List.any_eq_false, Bool.and_eq_true,
    decide_eq_true_eq, not_and, Bool.not_eq_true]

/-- Idempotent: collapsing twice is collapsing once. -/
theorem dedup_idempotent (l : List Row) : dedup (dedup l) = dedup l := by
  show (dedup l).filter (keeps (dedup l)) = dedup l
  apply List.filter_eq_self.mpr
  intro j hj
  have ⟨_, hmin⟩ := mem_dedup.mp hj
  unfold keeps
  simp only [Bool.not_eq_eq_eq_not, Bool.not_true, List.any_eq_false, Bool.and_eq_true,
    decide_eq_true_eq, not_and, Bool.not_eq_true]
  intro k hk hfp
  exact hmin k (mem_dedup.mp hk).1 hfp

theorem exists_min (l : List Row) (j : Row) (hj : j ∈ l) :
    ∃ m ∈ l, m.fp = j.fp ∧ ∀ k ∈ l, k.fp = j.fp → before k m = false := by
  induction l generalizing j with
  | nil => cases hj
  | cons a t ih =>
    by_cases ht : ∃ x ∈ t, x.fp = j.fp
    · obtain ⟨x, hx, hxfp⟩ := ht
      obtain ⟨m, hm, hmfp', hmin'⟩ := ih x hx
      have hmfp : m.fp = j.fp := hmfp'.trans hxfp
      have hmin : ∀ k ∈ t, k.fp = j.fp → before k m = false :=
        fun k hk hk' => hmin' k hk (hk'.trans hxfp.symm)
      by_cases hb : a.fp = j.fp ∧ before a m = true
      · refine ⟨a, List.mem_cons_self, hb.1, ?_⟩
        intro k hk hkfp
        rcases List.mem_cons.mp hk with rfl | hk
        · exact before_irrefl _
        · cases hka : before k a with
          | false => rfl
          | true =>
            have := before_trans hka hb.2
            rw [hmin k hk hkfp] at this
            cases this
      · refine ⟨m, List.mem_cons_of_mem _ hm, hmfp, ?_⟩
        intro k hk hkfp
        rcases List.mem_cons.mp hk with rfl | hk
        · cases hkm : before k m with
          | false => rfl
          | true => exact absurd ⟨hkfp, hkm⟩ hb
        · exact hmin k hk hkfp
    · refine ⟨a, List.mem_cons_self, ?_, ?_⟩
      · rcases List.mem_cons.mp hj with rfl | hjt
        · rfl
        · exact absurd ⟨j, hjt, rfl⟩ ht
      · intro k hk hkfp
        rcases List.mem_cons.mp hk with rfl | hk
        · exact before_irrefl _
        · exact absurd ⟨k, hk, hkfp⟩ ht

/-- Never drops a distinct role: every fingerprint in the input has a row in the output. -/
theorem dedup_keeps_every_fingerprint (l : List Row) (j : Row) (hj : j ∈ l) :
    ∃ m ∈ dedup l, m.fp = j.fp := by
  obtain ⟨m, hm, hmfp, hmin⟩ := exists_min l j hj
  exact ⟨m, mem_dedup.mpr ⟨hm, fun k hk hkfp => hmin k hk (hkfp.trans hmfp)⟩, hmfp⟩

/-- One row per fingerprint, given distinct ids (the `jobs.id` primary key). -/
theorem dedup_one_per_fingerprint {l : List Row} (hid : (l.map (·.id)).Nodup) {a b : Row}
    (ha : a ∈ dedup l) (hb : b ∈ dedup l) (hfp : a.fp = b.fp) : a = b := by
  have ⟨ha', hamin⟩ := mem_dedup.mp ha
  have ⟨hb', hbmin⟩ := mem_dedup.mp hb
  by_cases hab : a.id = b.id
  · induction l with
    | nil => cases ha'
    | cons x t ih =>
      simp only [List.map_cons, List.nodup_cons] at hid
      rcases List.mem_cons.mp ha' with rfl | hat
      · rcases List.mem_cons.mp hb' with rfl | hbt
        · rfl
        · exact absurd (hab ▸ List.mem_map_of_mem (f := (·.id)) hbt) hid.1
      · rcases List.mem_cons.mp hb' with rfl | hbt
        · exact absurd (hab.symm ▸ List.mem_map_of_mem (f := (·.id)) hat) hid.1
        · exact ih hid.2
            (mem_dedup.mpr ⟨hat, fun k hk => hamin k (List.mem_cons_of_mem _ hk)⟩)
            (mem_dedup.mpr ⟨hbt, fun k hk => hbmin k (List.mem_cons_of_mem _ hk)⟩) hat
            (fun k hk => hamin k (List.mem_cons_of_mem _ hk)) hbt
            (fun k hk => hbmin k (List.mem_cons_of_mem _ hk))
  · rcases before_total hab with h | h
    · rw [hbmin a ha' hfp] at h; cases h
    · rw [hamin b hb' hfp.symm] at h; cases h

/-- Prefers the company board: if any copy came from a company board, the kept copy did too. -/
theorem dedup_prefers_board {l : List Row} {m k : Row} (hm : m ∈ dedup l) (hk : k ∈ l)
    (hfp : k.fp = m.fp) (hboard : sourcePriority k.source = 0) : sourcePriority m.source = 0 := by
  have ⟨_, hmin⟩ := mem_dedup.mp hm
  have := hmin k hk hfp
  simp only [before, Bool.or_eq_false_iff, decide_eq_false_iff_not, Bool.and_eq_false_iff] at this
  omega

/-! ## Counterexamples: `fingerprintOf` merges distinct roles

The partition key is the only notion of "same role". Two cases make distinct roles share it.
-/

/-- The `|` separator also survives inside names, so company and title can trade text. -/
theorem separator_collision :
    fingerprint "Acme | Labs" "Engineering Manager" = fingerprint "Acme" "Labs | Engineering Manager" := by
  decide

/-- Every non-ASCII letter is stripped, so two companies written in another script look identical. -/
theorem non_latin_collision :
    fingerprint "株式会社メルカリ" "Engineering Manager" = fingerprint "ソニー株式会社" "Engineering Manager" := by
  decide

/-- Symbols in a title are stripped, so a C++ role and a C role are one role. -/
theorem symbol_collision :
    fingerprint "Acme" "Engineering Manager, C++" = fingerprint "Acme" "Engineering Manager, C" := by
  decide

def collisionRows : List Row :=
  [⟨1, "Greenhouse", "株式会社メルカリ", "Engineering Manager", 10⟩,
   ⟨2, "Ashby", "ソニー株式会社", "Engineering Manager", 20⟩]

theorem distinct_role_dropped : (dedup collisionRows).length = 1 := by decide

/-! ## Proposed fix: key on the cleaned pair, keeping every letter -/

def keepCharFixed (c : Char) : Bool := c.isLower || c.isDigit || c == '+' || c == '#' || c.val > 127

def clean (s : String) : List Char := (s.toList.map Char.toLower).filter keepCharFixed

def fingerprintFixed (company title : String) : List Char × List Char := (clean company, clean title)

theorem fixed_separates_collisions :
    fingerprintFixed "Acme | Labs" "Engineering Manager" ≠ fingerprintFixed "Acme" "Labs | Engineering Manager" ∧
    fingerprintFixed "株式会社メルカリ" "Engineering Manager" ≠ fingerprintFixed "ソニー株式会社" "Engineering Manager" ∧
    fingerprintFixed "Acme" "Engineering Manager, C++" ≠ fingerprintFixed "Acme" "Engineering Manager, C" := by
  decide

theorem fixed_injective_on_cleaned {c₁ t₁ c₂ t₂ : String}
    (h : clean c₁ ≠ clean c₂ ∨ clean t₁ ≠ clean t₂) :
    fingerprintFixed c₁ t₁ ≠ fingerprintFixed c₂ t₂ := by
  intro heq
  simp only [fingerprintFixed, Prod.mk.injEq] at heq
  rcases h with h | h
  · exact h heq.1
  · exact h heq.2

end GateVerify.Dedup
