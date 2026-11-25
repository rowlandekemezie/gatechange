interface Pending {
  readonly kind: string;
  readonly rev: number;
}

interface Vars {
  readonly account: readonly string[];
  readonly loaded: boolean;
  readonly marks: readonly string[];
  readonly offer: string;
  readonly pending: readonly Pending[];
  readonly session: string;
  readonly stored: readonly string[];
  readonly tracker: string;
}

export const title = "Shortlist across sign-in, the move offer and sign-out";

const has = (v: Vars, kind: string) => v.pending.some((p) => p.kind === kind);

const localState = (v: Vars) => {
  if (!v.stored.includes("old") && !v.account.includes("old")) {
    return "Signed out, browser job lost";
  }

  if (has(v, "read")) {
    return "Signed out, reading browser list";
  }

  const same =
    v.marks.length === v.stored.length &&
    v.marks.every((mark) => v.stored.includes(mark));

  return same
    ? "Signed out, browser list shown"
    : "Signed out, page shows fewer jobs than the browser has";
};

const remoteState = (v: Vars) => {
  if (!v.loaded) {
    return v.pending.some((p) => p.kind !== "read")
      ? "Signed in, tracker loading"
      : "Signed in, stuck on Loading";
  }

  if (v.offer === "Moving") {
    return has(v, "import") ? "Moving browser jobs" : "Moving... stuck";
  }

  return v.offer === "Asking"
    ? "Offer: move browser jobs?"
    : "Signed in, tracker shown";
};

export const state = (v: Vars) => {
  if (v.session === "checking") {
    return "Page open, checking sign-in";
  }

  return v.tracker === "Local" ? localState(v) : remoteState(v);
};

export const group = (v: Vars) => {
  if (v.session === "checking") {
    return "start";
  }

  return v.tracker === "Local" ? "out" : "in";
};

export const colors = { in: "blue", out: "purple", start: "tan" };

const labels = new Map<string, string | null>([
  ["BrowserListRead", "the page reads the browser list"],
  ["ChangeAnswers", "the save is confirmed"],
  ["Done", null],
  ["ImportAnswers", "the move finishes"],
  ["ImportFails", "the move fails"],
  ["ReaderMovesBrowserJobs", "you tap Move them"],
  ["ReaderSavesInBrowser", "you save a job in the browser"],
  ["ReaderSignsOut", "you sign out"],
  ["ReaderTracksJob", "you save a job"],
  ["SessionSaysSignedIn", "the sign-in check says signed in"],
  ["SessionSaysSignedOut", "the sign-in check says signed out"],
  ["SyncAnswers", "the tracker list arrives"],
]);

export const step = (action: string) =>
  labels.has(action) ? (labels.get(action) ?? null) : action;
