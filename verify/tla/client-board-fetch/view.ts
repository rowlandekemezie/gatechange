interface Vars {
  readonly filters: string;
  readonly jobs: string;
  readonly more: string;
  readonly rows: readonly string[];
}

export const title = "Board list across filter changes and Show more";

const rowsNote = (v: Vars) =>
  v.rows.length === 0 || (v.rows.length === 1 && v.rows[0] === v.filters)
    ? ""
    : ", rows for other filters";

const jobsLabels = new Map<string, string>([
  ["Failed", "Could not load, Retry"],
  ["Loading", "Spinner"],
  ["Refreshing", "Old list dimmed, new one loading"],
]);

export const state = (v: Vars) => {
  const waiting = jobsLabels.get(v.jobs);

  if (waiting !== undefined) {
    return waiting;
  }

  if (v.more === "Loading") {
    return `List shown, loading more${rowsNote(v)}`;
  }

  return v.more === "Failed"
    ? `List shown, more failed${rowsNote(v)}`
    : `List shown${rowsNote(v)}`;
};

export const group = (v: Vars) => (v.jobs === "Loaded" ? "shown" : "loading");

export const colors = { loading: "blue", shown: "teal" };

const labels = new Map<string, string | null>([
  ["Done", null],
  ["MoreArrives", "a Show more reply arrives"],
  ["PageArrives", "a list reply arrives"],
  ["ReaderChangesFilter", "you change a filter"],
  ["ReaderComesBack", "you go back to the board"],
  ["ReaderOpensJob", "you open a job"],
  ["ReaderRetries", "you tap Retry"],
  ["ReaderTapsShowMore", "you tap Show more"],
]);

export const step = (action: string) =>
  labels.has(action) ? (labels.get(action) ?? null) : action;
