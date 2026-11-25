/-!
The version gate of the digest unsubscribe token, copied from `partsOf` in
`packages/digest-mailer/src/unsubscribe-token.ts`. The HMAC itself is not modelled: a token that
passes the gate is still checked against a signature over `${version}.${account}`.
The version comes from `UNSUBSCRIBE_TOKEN_VERSION`, read with `Config.Int`, so it never holds a dot.
-/
namespace GateVerify.Token

def splitDots : List Char → List (List Char)
  | [] => [[]]
  | c :: cs =>
    match splitDots cs with
    | [] => [[]]
    | w :: ws => if c = '.' then [] :: w :: ws else (c :: w) :: ws

def mint (version account signature : List Char) : List Char :=
  version ++ '.' :: account ++ '.' :: signature

def gate (token expected : List Char) : Bool :=
  let fields := splitDots token
  let legacy := fields.length == 2 && expected == ['1']
  let parts := if legacy then ['1'] :: fields else fields
  match parts with
  | [version, _, _] => version == expected
  | _ => false

theorem splitDots_word : ∀ (w : List Char), '.' ∉ w → splitDots w = [w]
  | [], _ => rfl
  | c :: cs, h => by
    have hc : c ≠ '.' := fun e => h (e ▸ List.mem_cons_self)
    have := splitDots_word cs (fun m => h (List.mem_cons_of_mem _ m))
    simp [splitDots, this, hc]

theorem splitDots_cons_word : ∀ (w rest : List Char), '.' ∉ w →
    splitDots (w ++ '.' :: rest) = w :: splitDots rest
  | [], rest, _ => by
    simp only [List.nil_append, splitDots]
    cases h : splitDots rest with
    | nil => cases rest <;> simp [splitDots] at h <;> split at h <;> simp_all
    | cons x xs => simp
  | c :: cs, rest, h => by
    have hc : c ≠ '.' := fun e => h (e ▸ List.mem_cons_self)
    have := splitDots_cons_word cs rest (fun m => h (List.mem_cons_of_mem _ m))
    simp [splitDots, this, hc]

theorem splitDots_mint {v a s : List Char} (hv : '.' ∉ v) (ha : '.' ∉ a) (hs : '.' ∉ s) :
    splitDots (mint v a s) = [v, a, s] := by
  have hm : mint v a s = v ++ '.' :: (a ++ '.' :: s) := by simp [mint]
  rw [hm, splitDots_cons_word v _ hv, splitDots_cons_word a _ ha, splitDots_word s hs]

theorem current_token_accepted {v a s : List Char} (hv : '.' ∉ v) (ha : '.' ∉ a) (hs : '.' ∉ s) :
    gate (mint v a s) v = true := by
  simp [gate, splitDots_mint hv ha hs]

/-- After the version bumps, a token minted for the old version fails the gate. -/
theorem bumped_version_rejects {v e a s : List Char} (hv : '.' ∉ v) (ha : '.' ∉ a) (hs : '.' ∉ s)
    (hne : v ≠ e) : gate (mint v a s) e = false := by
  simp [gate, splitDots_mint hv ha hs, hne]

/-- A two-field legacy link passes the gate only while the version is still 1. -/
theorem legacy_only_at_one {a s e : List Char} (ha : '.' ∉ a) (hs : '.' ∉ s) (he : e ≠ ['1']) :
    gate (a ++ '.' :: s) e = false := by
  have : splitDots (a ++ '.' :: s) = [a, s] := by
    rw [splitDots_cons_word a s ha, splitDots_word s hs]
  simp [gate, this, he]

theorem legacy_accepted_at_one {a s : List Char} (ha : '.' ∉ a) (hs : '.' ∉ s) :
    gate (a ++ '.' :: s) ['1'] = true := by
  have : splitDots (a ++ '.' :: s) = [a, s] := by
    rw [splitDots_cons_word a s ha, splitDots_word s hs]
  simp [gate, this]

end GateVerify.Token
