/-!
Relevance ranking, copied from `normalizePosting` in `packages/core/src/posting.ts`
(`roleWeight + regionWeight + SALARY_BONUS + REMOTE_BONUS`) and the `Relevance` order in
`listJobsStatement` (`relevance - ((now - posted_at) / DAY) * 2.5 DESC, posted_at DESC, id ASC`).
Scores are scaled by `2 * DAY` so the arithmetic is exact over `Int`.
-/
namespace GateVerify.Relevance

inductive Role | vicePresident | headOfEngineering | director | engineeringManager
deriving Repr, DecidableEq

inductive Region
  | remoteCanada | remoteNorthAmerica | remoteUnitedStates | remoteGlobal
  | britishColumbia | canadaOnsite | unitedStatesOnsite | elsewhere
deriving Repr, DecidableEq

def roleWeight : Role → Int
  | .vicePresident => 40 | .headOfEngineering => 38 | .director => 36 | .engineeringManager => 30

def regionWeight : Region → Int
  | .remoteCanada => 12 | .remoteNorthAmerica => 11 | .britishColumbia => 11
  | .remoteUnitedStates => 9 | .remoteGlobal => 9 | .canadaOnsite => 5
  | .unitedStatesOnsite => 3 | .elsewhere => 0

def relevance (role : Role) (region : Region) (hasSalary remote : Bool) : Int :=
  roleWeight role + regionWeight region + (if hasSalary then 3 else 0) + (if remote then 2 else 0)

def dayMillis : Int := 86400000

def score (rel postedAt now : Int) : Int := 2 * dayMillis * rel - 5 * (now - postedAt)

structure Ranked where
  id : Nat
  relevance : Int
  postedAt : Int
deriving Repr, DecidableEq

def ranksBefore (now : Int) (a b : Ranked) : Bool :=
  decide (score a.relevance a.postedAt now > score b.relevance b.postedAt now) ||
  (decide (score a.relevance a.postedAt now = score b.relevance b.postedAt now) &&
    (decide (a.postedAt > b.postedAt) || (decide (a.postedAt = b.postedAt) && decide (a.id < b.id))))

theorem score_strictly_falls_with_age (rel p now now' : Int) (h : now < now') :
    score rel p now' < score rel p now := by
  unfold score; omega

theorem fresher_ranks_first (now : Int) (a b : Ranked) (hrel : a.relevance = b.relevance)
    (hfresh : a.postedAt > b.postedAt) : ranksBefore now a b = true := by
  simp only [ranksBefore, score, hrel, Bool.or_eq_true, decide_eq_true_eq]
  omega

theorem older_never_first (now : Int) (a b : Ranked) (hrel : a.relevance = b.relevance)
    (hfresh : a.postedAt > b.postedAt) : ranksBefore now b a = false := by
  simp only [ranksBefore, score, hrel, Bool.or_eq_false_iff, Bool.and_eq_false_iff,
    decide_eq_false_iff_not]
  omega

/-- The order between two jobs does not depend on when the board is read. -/
theorem order_ignores_now (now now' : Int) (a b : Ranked) : ranksBefore now a b = ranksBefore now' a b := by
  have h1 : decide (score a.relevance a.postedAt now > score b.relevance b.postedAt now) =
      decide (score a.relevance a.postedAt now' > score b.relevance b.postedAt now') :=
    decide_eq_decide.mpr (by unfold score; omega)
  have h2 : decide (score a.relevance a.postedAt now = score b.relevance b.postedAt now) =
      decide (score a.relevance a.postedAt now' = score b.relevance b.postedAt now') :=
    decide_eq_decide.mpr (by unfold score; omega)
  simp only [ranksBefore, h1, h2]

theorem day_is_worth_two_and_a_half (rel p now : Int) :
    score (rel + 5) (p - 2 * dayMillis) now = score rel p now := by
  simp only [score, dayMillis]; omega

theorem relevance_bounds (role : Role) (region : Region) (s r : Bool) :
    30 ≤ relevance role region s r ∧ relevance role region s r ≤ 57 := by
  cases role <;> cases region <;> cases s <;> cases r <;> decide

end GateVerify.Relevance
