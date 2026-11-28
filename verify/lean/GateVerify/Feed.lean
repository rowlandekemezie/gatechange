import GateVerify.Sort

/-!
Feed scheduling, copied from `packages/core/src/feed.ts` (`backoffMinutes`,
`isFeedDue`, `selectDueFeeds`) and the state writes in
`packages/job-store/src/queries.ts` (`feedSucceededStatement`,
`feedFailedStatement`, `feedStatesStatement`).
-/
namespace GateVerify.Feed

open GateVerify

def maxBackoffDoublings : Nat := 4
def minuteMillis : Int := 60000

structure Feed where
  key : String
  minInterval : Nat
deriving Repr, DecidableEq

structure FeedState where
  failures : Nat
  lastAttempt : Option Int
deriving Repr, DecidableEq

abbrev States := String → Option FeedState

def failuresOf (s : Option FeedState) : Nat :=
  match s with
  | none => 0
  | some st => st.failures

def lastAttemptOf (s : Option FeedState) : Option Int :=
  match s with
  | none => none
  | some st => st.lastAttempt

def backoffMinutes (f : Feed) (s : Option FeedState) : Nat :=
  f.minInterval * 2 ^ Nat.min (failuresOf s) maxBackoffDoublings

def isDue (f : Feed) (s : Option FeedState) (now : Int) : Bool :=
  match lastAttemptOf s with
  | none => true
  | some last => decide (now - last ≥ (backoffMinutes f s : Int) * minuteMillis)

def attemptKey (s : Option FeedState) : Int :=
  match lastAttemptOf s with
  | none => -1
  | some last => last

def selectDue (catalog : List Feed) (st : States) (now : Int) (limit : Nat) : List Feed :=
  (sortBy (fun f => attemptKey (st f.key)) (catalog.filter (fun f => isDue f (st f.key) now))).take limit

def record (old : Option FeedState) (ok : Bool) (now : Int) : FeedState :=
  { failures := if ok then 0 else failuresOf old + 1
    lastAttempt := some (max ((lastAttemptOf old).getD 0) now) }

def step (st : States) (selected : List Feed) (ok : String → Bool) (now : Int) : States :=
  fun k => if selected.any (fun g => g.key == k) then some (record (st k) (ok k) now) else st k

/-! ## Backoff -/

theorem backoff_monotone (f : Feed) (a b : Nat) (h : a ≤ b) :
    backoffMinutes f (some ⟨a, none⟩) ≤ backoffMinutes f (some ⟨b, none⟩) := by
  unfold backoffMinutes failuresOf
  apply Nat.mul_le_mul_left
  apply Nat.pow_le_pow_right (by decide)
  simp only [Nat.min_def]
  split <;> split <;> omega

theorem backoff_capped (f : Feed) (s : Option FeedState) :
    backoffMinutes f s ≤ f.minInterval * 16 := by
  unfold backoffMinutes
  apply Nat.mul_le_mul_left
  have : Nat.min (failuresOf s) maxBackoffDoublings ≤ 4 := Nat.min_le_right _ _
  have h := Nat.pow_le_pow_right (show 2 > 0 by decide) this
  simpa using h

theorem backoff_at_least_interval (f : Feed) (s : Option FeedState) :
    f.minInterval ≤ backoffMinutes f s := by
  unfold backoffMinutes
  have : 1 ≤ 2 ^ Nat.min (failuresOf s) maxBackoffDoublings := Nat.one_le_two_pow
  calc f.minInterval = f.minInterval * 1 := by omega
    _ ≤ _ := Nat.mul_le_mul_left _ this

/-! ## Source intervals are respected -/

theorem selectDue_mem {catalog : List Feed} {st : States} {now : Int} {limit : Nat} {g : Feed}
    (h : g ∈ selectDue catalog st now limit) : g ∈ catalog ∧ isDue g (st g.key) now = true := by
  unfold selectDue at h
  have := List.mem_of_mem_take h
  rw [mem_sortBy, List.mem_filter] at this
  exact this

theorem selected_respects_min_interval {catalog : List Feed} {st : States} {now : Int}
    {limit : Nat} {g : Feed} (h : g ∈ selectDue catalog st now limit) :
    lastAttemptOf (st g.key) = none ∨
      ∃ last, lastAttemptOf (st g.key) = some last ∧
        now - last ≥ (g.minInterval : Int) * minuteMillis := by
  have hd := (selectDue_mem h).2
  unfold isDue at hd
  cases hl : lastAttemptOf (st g.key) with
  | none => exact Or.inl rfl
  | some last =>
    rw [hl] at hd
    refine Or.inr ⟨last, rfl, ?_⟩
    have hb := backoff_at_least_interval g (st g.key)
    have hm : (g.minInterval : Int) * minuteMillis ≤ (backoffMinutes g (st g.key) : Int) * minuteMillis :=
      Int.mul_le_mul_of_nonneg_right (by exact_mod_cast hb) (by decide)
    have := of_decide_eq_true hd
    omega

/-! ## Fairness: once due, a feed is fetched within ⌊(N-1)/K⌋ + 1 runs -/

theorem key_inj {l : List Feed} (hn : (l.map (·.key)).Nodup) {a b : Feed}
    (ha : a ∈ l) (hb : b ∈ l) (hk : a.key = b.key) : a = b := by
  induction l with
  | nil => cases ha
  | cons x t ih =>
    simp only [List.map_cons, List.nodup_cons] at hn
    rcases List.mem_cons.mp ha with rfl | ha'
    · rcases List.mem_cons.mp hb with rfl | hb'
      · rfl
      · exact absurd (hk ▸ List.mem_map_of_mem (f := (·.key)) hb') hn.1
    · rcases List.mem_cons.mp hb with rfl | hb'
      · exact absurd (hk ▸ List.mem_map_of_mem (f := (·.key)) ha') hn.1
      · exact ih hn.2 ha' hb'

theorem nodup_of_keys {l : List Feed} (hn : (l.map (·.key)).Nodup) : l.Nodup := by
  induction l with
  | nil => exact List.nodup_nil
  | cons x t ih =>
    simp only [List.map_cons, List.nodup_cons] at hn
    refine List.nodup_cons.mpr ⟨fun hx => hn.1 (List.mem_map_of_mem hx), ih hn.2⟩

theorem selectDue_nodup {catalog : List Feed} (hn : catalog.Nodup) (st : States) (now : Int)
    (limit : Nat) : (selectDue catalog st now limit).Nodup := by
  unfold selectDue
  apply List.Nodup.sublist (List.take_sublist _ _)
  apply List.Nodup.perm _ (perm_sortBy _ _).symm
  exact List.Nodup.sublist (List.filter_sublist) hn

theorem selectDue_skipped {catalog : List Feed} {st : States} {now : Int} {limit : Nat} {f : Feed}
    (hf : f ∈ catalog) (hd : isDue f (st f.key) now = true)
    (hs : f ∉ selectDue catalog st now limit) :
    (selectDue catalog st now limit).length = limit ∧
      ∀ g ∈ selectDue catalog st now limit, attemptKey (st g.key) ≤ attemptKey (st f.key) := by
  unfold selectDue at hs ⊢
  generalize hS : sortBy (fun f => attemptKey (st f.key))
      (catalog.filter (fun f => isDue f (st f.key) now)) = S at hs ⊢
  have hmem : f ∈ S := by
    rw [← hS, mem_sortBy, List.mem_filter]; exact ⟨hf, hd⟩
  have hsorted : S.Pairwise (fun a b => attemptKey (st a.key) ≤ attemptKey (st b.key)) := by
    rw [← hS]; exact sorted_sortBy _ _
  have hsplit := List.take_append_drop limit S
  have hdrop : f ∈ S.drop limit := by
    rw [← hsplit] at hmem
    rcases List.mem_append.mp hmem with h | h
    · exact absurd h hs
    · exact h
  have hlen : limit < S.length := by
    have : (S.drop limit).length > 0 := List.length_pos_of_mem hdrop
    rw [List.length_drop] at this; omega
  refine ⟨by rw [List.length_take]; omega, ?_⟩
  intro g hg
  rw [← hsplit] at hsorted
  exact (List.pairwise_append.mp hsorted).2.2 g hg f hdrop

theorem length_filter_not_mem (A S : List Feed) (hA : A.Nodup) (hS : S.Nodup) (hsub : ∀ x ∈ S, x ∈ A) :
    (A.filter (fun x => decide (x ∉ S))).length + S.length = A.length := by
  induction A generalizing S with
  | nil =>
    cases S with
    | nil => rfl
    | cons s _ => exact absurd (hsub s (List.mem_cons_self)) (by simp)
  | cons a t ih =>
    have ha := (List.nodup_cons.mp hA)
    by_cases has : a ∈ S
    · have hS' := hS.erase a
      have hsub' : ∀ x ∈ S.erase a, x ∈ t := by
        intro x hx
        have ⟨hne, hxS⟩ := (hS.mem_erase_iff).mp hx
        rcases List.mem_cons.mp (hsub x hxS) with h | h
        · exact absurd h hne
        · exact h
      have hfilt : t.filter (fun x => decide (x ∉ S)) = t.filter (fun x => decide (x ∉ S.erase a)) := by
        apply List.filter_congr
        intro x hx
        have hne : x ≠ a := fun h => ha.1 (h ▸ hx)
        have hiff : x ∈ S.erase a ↔ x ∈ S := by rw [hS.mem_erase_iff]; simp [hne]
        simp [hiff]
      have := ih (S.erase a) ha.2 hS' hsub'
      rw [List.length_erase_of_mem has] at this
      have hpos : S.length > 0 := List.length_pos_of_mem has
      rw [List.filter_cons_of_neg (by simp [has]), hfilt, List.length_cons]
      omega
    · have hsub' : ∀ x ∈ S, x ∈ t := by
        intro x hx
        rcases List.mem_cons.mp (hsub x hx) with h | h
        · exact absurd (h ▸ hx) has
        · exact h
      have := ih S ha.2 hS hsub'
      rw [List.filter_cons_of_pos (by simp [has]), List.length_cons, List.length_cons]
      omega

def aheadPred (f : Feed) (st : States) (g : Feed) : Bool :=
  g != f && decide (attemptKey (st g.key) ≤ attemptKey (st f.key))

def ahead (catalog : List Feed) (f : Feed) (st : States) : Nat :=
  (catalog.filter (aheadPred f st)).length

def Bounded (st : States) (now : Int) : Prop :=
  ∀ k, attemptKey (st k) < now

theorem step_other {selected : List Feed} {st : States} {ok : String → Bool} {now : Int} {k : String}
    (h : ∀ g ∈ selected, g.key ≠ k) : step st selected ok now k = st k := by
  unfold step
  have : selected.any (fun g => g.key == k) = false := by
    rw [Bool.eq_false_iff]
    intro hc
    obtain ⟨g, hg, hk⟩ := List.any_eq_true.mp hc
    exact h g hg (by simpa using hk)
  simp [this]

theorem step_selected {selected : List Feed} {st : States} {ok : String → Bool} {now : Int} {g : Feed}
    (hg : g ∈ selected) (_h0 : 0 ≤ now) : attemptKey (step st selected ok now g.key) = max ((lastAttemptOf (st g.key)).getD 0) now := by
  unfold step
  have : selected.any (fun x => x.key == g.key) = true := List.any_eq_true.mpr ⟨g, hg, by simp⟩
  simp [this, attemptKey, lastAttemptOf, record]

theorem ahead_decreases {catalog : List Feed} (hn : (catalog.map (·.key)).Nodup) {f : Feed}
    (hf : f ∈ catalog) {st : States} {now : Int} {limit : Nat} (ok : String → Bool)
    (h0 : 0 ≤ now) (hb : Bounded st now) (hd : isDue f (st f.key) now = true)
    (hs : f ∉ selectDue catalog st now limit) :
    ahead catalog f (step st (selectDue catalog st now limit) ok now) + limit ≤ ahead catalog f st := by
  have ⟨hlen, hle⟩ := selectDue_skipped hf hd hs
  generalize hS : selectDue catalog st now limit = S at hlen hle hs
  have hSmem : ∀ g ∈ S, g ∈ catalog := fun g hg => (selectDue_mem (hS ▸ hg)).1
  have hSnd : S.Nodup := hS ▸ selectDue_nodup (nodup_of_keys hn) st now limit
  have hkeyf : ∀ g ∈ S, g.key ≠ f.key := by
    intro g hg hk
    exact hs (key_inj hn (hSmem g hg) hf hk ▸ hg)
  have hfst : step st S ok now f.key = st f.key := step_other hkeyf
  unfold ahead
  have hAnd : (catalog.filter (aheadPred f st)).Nodup :=
    List.Nodup.sublist List.filter_sublist (nodup_of_keys hn)
  have hsubA : ∀ x ∈ S, x ∈ catalog.filter (aheadPred f st) := by
    intro x hx
    refine List.mem_filter.mpr ⟨hSmem x hx, ?_⟩
    have hne : x ≠ f := fun h => hs (h ▸ hx)
    simp [aheadPred, hne, hle x hx]
  have hcount := length_filter_not_mem _ S hAnd hSnd hsubA
  rw [← hlen]
  suffices hm : (catalog.filter (aheadPred f (step st S ok now))).length
      ≤ ((catalog.filter (aheadPred f st)).filter (fun x => decide (x ∉ S))).length by omega
  rw [List.filter_filter, ← List.countP_eq_length_filter, ← List.countP_eq_length_filter]
  apply List.countP_mono_left
  intro g hgc hp
  simp only [aheadPred, hfst, Bool.and_eq_true, bne_iff_ne, ne_eq, decide_eq_true_eq] at hp
  by_cases hgS : g ∈ S
  · exfalso
    have := step_selected (ok := ok) (st := st) hgS h0
    have hfb := hb f.key
    omega
  · have hother : ∀ x ∈ S, x.key ≠ g.key := by
      intro x hx hk
      exact hgS (key_inj hn (hSmem x hx) hgc hk ▸ hx)
    rw [step_other hother] at hp
    simp [aheadPred, hgS, hp.1, hp.2]

def trajectory (catalog : List Feed) (limit : Nat) (t : Nat → Int) (ok : Nat → String → Bool)
    (st0 : States) : Nat → States
  | 0 => st0
  | n + 1 =>
    let st := trajectory catalog limit t ok st0 n
    step st (selectDue catalog st (t n) limit) (ok n) (t n)

theorem attemptKey_record (old : Option FeedState) (ok : Bool) (now : Int) :
    attemptKey (some (record old ok now)) = max ((lastAttemptOf old).getD 0) now := rfl

theorem bounded_step {st : States} {S : List Feed} {ok : String → Bool} {now next : Int}
    (h0 : 0 ≤ now) (hb : Bounded st now) (hlt : now < next) : Bounded (step st S ok now) next := by
  intro k
  unfold step
  split
  · have := hb k
    unfold attemptKey at this
    show attemptKey (some (record (st k) _ now)) < next
    rw [attemptKey_record]
    cases hl : lastAttemptOf (st k) with
    | none => simp; omega
    | some v => rw [hl] at this; simp at this ⊢; omega
  · have := hb k; omega

theorem due_later {f : Feed} {s : Option FeedState} {a b : Int} (hab : a ≤ b)
    (h : isDue f s a = true) : isDue f s b = true := by
  unfold isDue at *
  cases hl : lastAttemptOf s with
  | none => rfl
  | some last =>
    rw [hl] at h
    simp only [decide_eq_true_eq] at h ⊢
    omega

theorem every_due_feed_is_fetched {catalog : List Feed} (hn : (catalog.map (·.key)).Nodup)
    {limit : Nat} (hK : 0 < limit) {t : Nat → Int} (hmono : ∀ n, t n < t (n + 1)) (h0 : 0 ≤ t 0)
    (ok : Nat → String → Bool) {st0 : States} (hb0 : Bounded st0 (t 0))
    {f : Feed} (hf : f ∈ catalog) (hd : isDue f (st0 f.key) (t 0) = true) :
    ∃ i, i ≤ (catalog.length - 1) / limit ∧
      f ∈ selectDue catalog (trajectory catalog limit t ok st0 i) (t i) limit := by
  have tpos : ∀ n, 0 ≤ t n := by
    intro n; induction n with
    | zero => exact h0
    | succ n ih => have := hmono n; omega
  have tge : ∀ n, t 0 ≤ t n := by
    intro n; induction n with
    | zero => omega
    | succ n ih => have := hmono n; omega
  have hbnd : ∀ n, Bounded (trajectory catalog limit t ok st0 n) (t n) := by
    intro n; induction n with
    | zero => exact hb0
    | succ n ih => exact bounded_step (tpos n) ih (hmono n)
  let q := (catalog.length - 1) / limit
  apply Classical.byContradiction
  intro hno
  have hall : ∀ i ≤ q, f ∉ selectDue catalog (trajectory catalog limit t ok st0 i) (t i) limit :=
    fun i hi hm => hno ⟨i, hi, hm⟩
  have key : ∀ n, n ≤ q + 1 →
      trajectory catalog limit t ok st0 n f.key = st0 f.key ∧
      ahead catalog f (trajectory catalog limit t ok st0 n) + n * limit ≤ ahead catalog f st0 := by
    intro n
    induction n with
    | zero => intro _; simp [trajectory]
    | succ n ih =>
      intro hn1
      have ⟨hfs, hah⟩ := ih (by omega)
      have hnot := hall n (by omega)
      have hdn : isDue f (trajectory catalog limit t ok st0 n f.key) (t n) = true := by
        rw [hfs]; exact due_later (tge n) hd
      have hdec := ahead_decreases hn hf (ok n) (tpos n) (hbnd n) hdn hnot
      have hkeyf : ∀ g ∈ selectDue catalog (trajectory catalog limit t ok st0 n) (t n) limit,
          g.key ≠ f.key := by
        intro g hg hk
        exact hnot (key_inj hn (selectDue_mem hg).1 hf hk ▸ hg)
      refine ⟨?_, ?_⟩
      · show step _ _ _ _ f.key = _
        rw [step_other hkeyf, hfs]
      · show ahead catalog f (step _ _ _ _) + (n + 1) * limit ≤ _
        rw [Nat.succ_mul]; omega
  have ⟨_, hfin⟩ := key (q + 1) (Nat.le_refl _)
  have hlt : ahead catalog f st0 < catalog.length := by
    unfold ahead
    apply List.length_filter_lt_length_iff_exists.mpr
    exact ⟨f, hf, by simp [aheadPred]⟩
  have hdiv := Nat.lt_mul_div_succ (catalog.length - 1) hK
  have hmul : (q + 1) * limit = limit * ((catalog.length - 1) / limit + 1) := Nat.mul_comm _ _
  have hpos : 0 < catalog.length := List.length_pos_of_mem hf
  omega

/-! ## Counterexample: the state read used to be capped at 5,000 rows by key

`feedStatesStatement` used to read `feeds ORDER BY key LIMIT 5000`, and `feeds` keeps rows of
feeds that left the catalog. Once the table held more rows than the cap, a catalog feed whose key
sorted past the cap read as never attempted, sorted first, and was fetched on every run. With more
such feeds than `limit`, the rest of the catalog was never fetched again. Here the cap is 1, the
limit is 1, and `rows` is listed in key order so `take` is the `ORDER BY key LIMIT`.

The read now returns every row, which is `exactView` below: the full `States` that
`every_due_feed_is_fetched` assumes, so the refresh bound holds for the code again.
-/

def truncatedView (rows : List (String × FeedState)) (cap : Nat) : States :=
  fun k => (rows.take cap).lookup k

def feedA : Feed := ⟨"a", 180⟩
def feedB : Feed := ⟨"b", 180⟩
def hour3 : Int := 180 * 60000

def rowsAt (aLast bLast : Int) : List (String × FeedState) :=
  [("a", ⟨0, some aLast⟩), ("b", ⟨0, some bLast⟩)]

def capRun (n : Nat) : List (String × FeedState) → List Feed × List (String × FeedState)
  | rows =>
    let now : Int := hour3 * (n + 1)
    let picked := selectDue [feedA, feedB] (truncatedView rows 1) now 1
    let rows' := rows.map fun (k, s) =>
      if picked.any (·.key == k) then (k, record (some s) true now) else (k, s)
    (picked, rows')

def capTrace : Nat → List (String × FeedState) → List (List Feed)
  | 0, _ => []
  | n + 1, rows =>
    let (picked, rows') := capRun (5 - (n + 1)) rows
    picked :: capTrace n rows'

theorem cap_starves_feed :
    capTrace 5 (rowsAt 0 0) = [[feedB], [feedB], [feedB], [feedB], [feedB]] ∧
    (∀ n ∈ [1, 2, 3, 4, 5], isDue feedA (some ⟨0, some 0⟩) (hour3 * n) = true) := by
  decide +kernel

def exactView (rows : List (String × FeedState)) : States := fun k => rows.lookup k

def exactRun (n : Nat) : List (String × FeedState) → List Feed × List (String × FeedState)
  | rows =>
    let now : Int := hour3 * (n + 1)
    let picked := selectDue [feedA, feedB] (exactView rows) now 1
    let rows' := rows.map fun (k, s) =>
      if picked.any (·.key == k) then (k, record (some s) true now) else (k, s)
    (picked, rows')

def exactTrace : Nat → List (String × FeedState) → List (List Feed)
  | 0, _ => []
  | n + 1, rows =>
    let (picked, rows') := exactRun (5 - (n + 1)) rows
    picked :: exactTrace n rows'

theorem catalog_keyed_read_alternates :
    exactTrace 5 (rowsAt 0 0) = [[feedA], [feedB], [feedA], [feedB], [feedA]] := by
  decide +kernel

end GateVerify.Feed
