interface Request {
  readonly kind: string;
  readonly phase: string;
  readonly rev: number;
}

interface Vars {
  readonly moves: number;
  readonly problem: boolean;
  readonly reqs: readonly Request[];
  readonly screen: string;
  readonly server: string;
}

export const title = "Two quick stage moves on a tracked job";

export const state = (v: Vars) => {
  const card = `card says ${v.screen}`;

  if (v.reqs.length > 0) {
    return v.moves < 2 ? "Saving one move" : "Saving two moves";
  }

  if (v.screen !== v.server) {
    return `Settled, ${card} but saved as ${v.server}`;
  }

  return v.problem ? `Settled with error banner, ${card}` : `Settled, ${card}`;
};

export const group = (v: Vars) => {
  if (v.reqs.length > 0) {
    return "saving";
  }

  return v.screen === v.server ? "settled" : "wrong";
};

export const colors = { saving: "blue", settled: "teal", wrong: "orange" };

const labels = new Map<string, string | null>([
  ["Done", null],
  ["FailureReachesPage", "a failure reaches the page"],
  ["ReaderMovesStage", "you pick a new stage"],
  ["ReplyReachesPage", "a reply reaches the page"],
  ["ServerFailsOne", "a save fails on the server"],
  ["ServerSavesOne", "the server saves a request"],
]);

export const step = (action: string) =>
  labels.has(action) ? (labels.get(action) ?? null) : action;
