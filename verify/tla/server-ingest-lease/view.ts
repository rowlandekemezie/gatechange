interface Vars {
  readonly heldUntil: number;
  readonly now: number;
  readonly pc: Readonly<Record<string, string>>;
}

export const title = "Two cron runs and the ingest lease";

const activeRuns = (v: Vars) =>
  Object.values(v.pc).filter(
    (phase) => phase === "ingesting" || phase === "recorded"
  ).length;

const ended = new Set(["finished", "killed", "rejected"]);

export const state = (v: Vars) => {
  const active = activeRuns(v);

  if (active > 1) {
    return "Two runs updating the board at once";
  }

  const held = v.heldUntil > v.now ? "lease held" : "lease free";

  if (active === 1) {
    return `One run updating the board, ${held}`;
  }

  const done = Object.values(v.pc).every((phase) => ended.has(phase));

  return done ? `No run active, ${held}, cron done` : `No run active, ${held}`;
};

const groups = new Map([
  [0, "idle"],
  [1, "busy"],
]);

export const group = (v: Vars) => groups.get(activeRuns(v)) ?? "bad";

export const colors = { bad: "pink", busy: "blue", idle: "tan" };

const labels = [
  ["RunWritesReceipt", "the run records its receipt"],
  ["RunReleasesLease", "the run finishes and frees the lease"],
  ["TwentyMinutesPass", "time passes"],
];

export const step = (action: string, from: Vars, to: Vars) => {
  if (action.startsWith("CronClaimsLease")) {
    const run = Object.keys(to.pc).find((key) => to.pc[key] !== from.pc[key]);

    return to.pc[run ?? ""] === "rejected"
      ? "the cron fires and finds the lease held"
      : "the cron fires and takes the lease";
  }

  return labels.find(([prefix]) => action.startsWith(prefix))?.[1] ?? null;
};
