interface Vars {
  readonly phase: string;
  readonly rows: Readonly<Record<string, string>>;
}

export const title = "A company board's roles across fetches";

const boardOf = (v: Vars) => {
  const open = Object.values(v.rows).filter((row) => row === "open").length;
  const closed = Object.values(v.rows).some((row) => row === "departed");

  if (open > 1) {
    return `${open} roles open`;
  }

  if (open === 1) {
    return "1 role open";
  }

  return closed ? "no role open, some closed" : "no role open";
};

export const state = (v: Vars) =>
  v.phase === "upserting"
    ? `Saving a fetch, ${boardOf(v)}`
    : `Idle, ${boardOf(v)}`;

export const group = (v: Vars) => (v.phase === "upserting" ? "saving" : "idle");

export const colors = { idle: "blue", saving: "orange" };

const labels = new Map<string, string | null>([
  ["BoardFails", "the board's feed fails"],
  ["DayPassesAndPrunes", "a day passes and closed roles are removed"],
  ["Done", null],
  ["StoreDepartsUnlisted", "roles the feed dropped are marked closed"],
  ["StoreFailsMidWrite", "the database fails mid-save"],
  ["StoreUpsertsOneChunk", "a batch of roles is saved"],
]);

export const step = (action: string) => {
  if (action.startsWith("BoardAnswers")) {
    return "the board's feed answers";
  }

  return labels.get(action) ?? null;
};
