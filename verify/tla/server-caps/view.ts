interface Vars {
  readonly held: number;
  readonly pc: Readonly<Record<string, string>>;
}

export const title =
  "Agent tokens issued from several tabs at once (cap shown as 2)";

const levels = new Map([
  [0, "under the cap"],
  [1, "under the cap"],
  [2, "at the cap"],
]);

export const state = (v: Vars) => {
  const waiting = Object.values(v.pc).filter(
    (phase) => phase === "sent" || phase === "checked"
  ).length;

  const tokens = levels.get(v.held) ?? "over the cap";

  return waiting > 0
    ? `Tokens ${tokens}, requests in flight`
    : `Tokens ${tokens}, all answered`;
};

const groups = new Map([
  [0, "room"],
  [1, "room"],
  [2, "full"],
]);

export const group = (v: Vars) => groups.get(v.held) ?? "bad";

export const colors = { bad: "pink", full: "orange", room: "blue" };

export const step = (action: string, from: Vars, to: Vars) => {
  if (action === "MemberRevokesOne") {
    return "the member revokes a token";
  }

  if (!action.startsWith("ServerInsertsIfUnderCap")) {
    return null;
  }

  return to.held > from.held
    ? "a new token is issued"
    : "a request is refused at the cap";
};
