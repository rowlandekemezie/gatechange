/-!
Job ids and their `/jobs/<segment>` form. The id is `${feed.key}:${externalId}`
(`normalizePosting` in `packages/core/src/posting.ts`); the segment is unpadded base64url of the
id's UTF-8 bytes, and `idOfSegment` in `apps/web/src/client/route.ts` accepts a segment only when
re-encoding the decoded id gives the segment back.
-/
namespace GateVerify.JobId

def enc (n : Nat) : Char :=
  if n < 26 then Char.ofNat (65 + n)
  else if n < 52 then Char.ofNat (97 + (n - 26))
  else if n < 62 then Char.ofNat (48 + (n - 52))
  else if n = 62 then '-' else '_'

def dec (c : Char) : Option Nat :=
  let v := c.toNat
  if 65 ≤ v ∧ v ≤ 90 then some (v - 65)
  else if 97 ≤ v ∧ v ≤ 122 then some (v - 97 + 26)
  else if 48 ≤ v ∧ v ≤ 57 then some (v - 48 + 52)
  else if c = '-' then some 62
  else if c = '_' then some 63
  else none

theorem dec_enc_fin : ∀ n : Fin 64, dec (enc n.val) = some n.val := by decide

theorem dec_enc {n : Nat} (h : n < 64) : dec (enc n) = some n := dec_enc_fin ⟨n, h⟩

def sextets : List Nat → List Nat
  | a :: b :: c :: rest =>
    (a / 4) :: ((a % 4) * 16 + b / 16) :: ((b % 16) * 4 + c / 64) :: (c % 64) :: sextets rest
  | [a, b] => [a / 4, (a % 4) * 16 + b / 16, (b % 16) * 4]
  | [a] => [a / 4, (a % 4) * 16]
  | [] => []

def encode (bytes : List Nat) : List Char := (sextets bytes).map enc

def decodeAll : List Char → Option (List Nat)
  | [] => some []
  | c :: cs => match dec c, decodeAll cs with
    | some n, some ns => some (n :: ns)
    | _, _ => none

def unsextets : List Nat → Option (List Nat)
  | w :: x :: y :: z :: rest =>
    (unsextets rest).map fun r => (w * 4 + x / 16) :: ((x % 16) * 16 + y / 4) :: ((y % 4) * 64 + z) :: r
  | [w, x, y] => some [w * 4 + x / 16, (x % 16) * 16 + y / 4]
  | [w, x] => some [w * 4 + x / 16]
  | [_] => none
  | [] => some []

def decode (segment : List Char) : Option (List Nat) := (decodeAll segment).bind unsextets

def accept (segment : List Char) : Option (List Nat) :=
  match decode segment with
  | some bytes => if encode bytes = segment then some bytes else none
  | none => none

theorem sextets_lt : ∀ (bs : List Nat), (∀ b ∈ bs, b < 256) → ∀ s ∈ sextets bs, s < 64
  | a :: b :: c :: rest, h, s, hs => by
    simp only [sextets, List.mem_cons] at hs
    have ha := h a (by simp); have hb := h b (by simp); have hc := h c (by simp)
    rcases hs with rfl | rfl | rfl | rfl | hs
    · omega
    · omega
    · omega
    · omega
    · exact sextets_lt rest (fun x hx => h x (by simp [hx])) s hs
  | [a, b], h, s, hs => by
    simp only [sextets, List.mem_cons, List.not_mem_nil, or_false] at hs
    have ha := h a (by simp); have hb := h b (by simp)
    rcases hs with rfl | rfl | rfl <;> omega
  | [a], h, s, hs => by
    simp only [sextets, List.mem_cons, List.not_mem_nil, or_false] at hs
    have ha := h a (by simp)
    rcases hs with rfl | rfl <;> omega
  | [], _, s, hs => by simp [sextets] at hs

theorem decodeAll_map_enc : ∀ (xs : List Nat), (∀ x ∈ xs, x < 64) → decodeAll (xs.map enc) = some xs
  | [], _ => rfl
  | x :: xs, h => by
    simp only [List.map_cons, decodeAll, dec_enc (h x (by simp)),
      decodeAll_map_enc xs (fun y hy => h y (by simp [hy]))]

theorem unsextets_sextets : ∀ (bs : List Nat), (∀ b ∈ bs, b < 256) → unsextets (sextets bs) = some bs
  | a :: b :: c :: rest, h => by
    have ha := h a (by simp); have hb := h b (by simp); have hc := h c (by simp)
    have ih := unsextets_sextets rest (fun x hx => h x (by simp [hx]))
    show (unsextets (sextets rest)).map _ = _
    rw [ih]
    simp only [Option.map_some, Option.some.injEq, List.cons.injEq, and_true]
    omega
  | [a, b], h => by
    have ha := h a (by simp); have hb := h b (by simp)
    simp only [sextets, unsextets, Option.some.injEq, List.cons.injEq, and_true]
    omega
  | [a], h => by
    have ha := h a (by simp)
    simp only [sextets, unsextets, Option.some.injEq, List.cons.injEq, and_true]
    omega
  | [], _ => rfl

/-- `decode ∘ encode = id` on bytes. -/
theorem decode_encode (bs : List Nat) (h : ∀ b ∈ bs, b < 256) : decode (encode bs) = some bs := by
  unfold decode encode
  rw [decodeAll_map_enc _ (sextets_lt bs h)]
  exact unsextets_sextets bs h

theorem accept_encode (bs : List Nat) (h : ∀ b ∈ bs, b < 256) : accept (encode bs) = some bs := by
  unfold accept
  rw [decode_encode bs h]
  simp

theorem encode_injective {a b : List Nat} (ha : ∀ x ∈ a, x < 256) (hb : ∀ x ∈ b, x < 256)
    (h : encode a = encode b) : a = b := by
  have := decode_encode a ha
  rw [h, decode_encode b hb] at this
  exact (Option.some.inj this).symm

/-- Only one segment opens each job page: accepted segments with the same id are equal. -/
theorem accept_canonical {s₁ s₂ : List Char} {bs : List Nat}
    (h₁ : accept s₁ = some bs) (h₂ : accept s₂ = some bs) : s₁ = s₂ := by
  unfold accept at h₁ h₂
  split at h₁ <;> split at h₂ <;> simp_all
  rw [← h₁.1, ← h₂.1, h₁.2, h₂.2]

theorem accept_rejects_padding : accept "RQ==".toList = none := by decide
theorem accept_rejects_loose_bits : accept "RR".toList = none := by decide
theorem accept_takes_canonical : accept "RQ".toList = some [69] := by decide

def bytesOf (id : String) : List Nat := id.toByteArray.data.toList.map UInt8.toNat

theorem bytesOf_lt (id : String) : ∀ b ∈ bytesOf id, b < 256 := by
  intro b hb
  simp only [bytesOf, List.mem_map] at hb
  obtain ⟨u, _, rfl⟩ := hb
  exact u.toNat_lt

theorem map_toNat_inj : ∀ (a b : List UInt8), a.map UInt8.toNat = b.map UInt8.toNat → a = b
  | [], [], _ => rfl
  | [], _ :: _, h => by simp at h
  | _ :: _, [], h => by simp at h
  | x :: xs, y :: ys, h => by
    simp only [List.map_cons, List.cons.injEq] at h
    rw [UInt8.toNat_inj.mp h.1, map_toNat_inj xs ys h.2]

theorem bytesOf_injective {a b : String} (h : bytesOf a = bytesOf b) : a = b := by
  apply String.toByteArray_inj.mp
  have hl : a.toByteArray.data.toList = b.toByteArray.data.toList := by
    exact map_toNat_inj _ _ h
  cases ha : a.toByteArray
  cases hb : b.toByteArray
  rw [ha, hb] at hl
  simp_all [Array.toList_inj]

def segmentOf (id : String) : List Char := encode (bytesOf id)

/-- Two different job ids never share a `/jobs/<segment>` path. -/
theorem segment_injective {a b : String} (h : segmentOf a = segmentOf b) : a = b :=
  bytesOf_injective (encode_injective (bytesOf_lt a) (bytesOf_lt b) h)

theorem segment_round_trip (id : String) : accept (segmentOf id) = some (bytesOf id) :=
  accept_encode _ (bytesOf_lt id)

/-! ## The id itself: `feed.key ++ ":" ++ externalId`

Feed keys are `<source>:<slug>` with no `:` in either part (`feedKey` in
`packages/job-sources/src/feed-spec.ts`). External ids are free text from the feed.
-/

def jobId (source slug ext : List Char) : List Char := source ++ ':' :: slug ++ ':' :: ext

theorem split_colon {a a' r r' : List Char} (ha : ':' ∉ a) (ha' : ':' ∉ a')
    (h : a ++ ':' :: r = a' ++ ':' :: r') : a = a' ∧ r = r' := by
  induction a generalizing a' with
  | nil =>
    cases a' with
    | nil => simpa using h
    | cons c t =>
      simp only [List.nil_append, List.cons_append, List.cons.injEq] at h
      exact absurd (h.1 ▸ List.mem_cons_self) ha'
  | cons c t ih =>
    cases a' with
    | nil =>
      simp only [List.nil_append, List.cons_append, List.cons.injEq] at h
      exact absurd (h.1 ▸ List.mem_cons_self) ha
    | cons c' t' =>
      simp only [List.cons_append, List.cons.injEq] at h
      have := ih (fun hm => ha (List.mem_cons_of_mem _ hm)) (fun hm => ha' (List.mem_cons_of_mem _ hm)) h.2
      exact ⟨by rw [h.1, this.1], this.2⟩

theorem jobId_injective {s₁ k₁ e₁ s₂ k₂ e₂ : List Char}
    (hs₁ : ':' ∉ s₁) (hk₁ : ':' ∉ k₁) (hs₂ : ':' ∉ s₂) (hk₂ : ':' ∉ k₂)
    (h : jobId s₁ k₁ e₁ = jobId s₂ k₂ e₂) : s₁ = s₂ ∧ k₁ = k₂ ∧ e₁ = e₂ := by
  unfold jobId at h
  have ⟨h1, h2⟩ := split_colon (r := k₁ ++ ':' :: e₁) (r' := k₂ ++ ':' :: e₂) hs₁ hs₂
    (by simpa [List.append_assoc] using h)
  have ⟨h3, h4⟩ := split_colon hk₁ hk₂ h2
  exact ⟨h1, h3, h4⟩

/-- Without the colon-free slug, two postings would share one id and one `jobs` row. -/
theorem colon_slug_collides :
    jobId "greenhouse".toList "acme".toList "eu:42".toList =
    jobId "greenhouse".toList "acme:eu".toList "42".toList := by decide

end GateVerify.JobId
