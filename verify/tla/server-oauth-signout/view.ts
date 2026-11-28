interface Token {
  readonly sid: string;
  readonly st: string;
}

interface Vars {
  readonly access: Readonly<Record<string, string>>;
  readonly out: string;
  readonly refresh: Readonly<Record<string, Token>>;
  readonly rot: string;
}

export const title =
  "Signing out while an AI assistant refreshes its connection";

const connected = (v: Vars) =>
  Object.values(v.refresh).some((token) => token.st === "live") ||
  Object.values(v.access).some((token) => token === "live");

const connection = (v: Vars) =>
  connected(v) ? "assistant connected" : "assistant cut off";

const phases = new Map([
  ["done", "Signed out"],
  ["idle", "Signed in"],
  ["read", "Signing out"],
  ["revoked", "Signing out"],
]);

export const state = (v: Vars) => {
  const phase = phases.get(v.out) ?? v.out;

  if (v.rot === "rotated" && v.out !== "done") {
    return `${phase}, assistant swapping its key`;
  }

  return `${phase}, ${connection(v)}`;
};

const groups = new Map([
  ["done", "out"],
  ["idle", "in"],
  ["read", "leaving"],
  ["revoked", "leaving"],
]);

export const group = (v: Vars) => {
  if (v.out === "done" && connected(v)) {
    return "bad";
  }

  return groups.get(v.out) ?? "leaving";
};

export const colors = {
  bad: "pink",
  in: "blue",
  leaving: "orange",
  out: "tan",
};

const labels = new Map<string, string | null>([
  ["ClientRefreshRotatesOld", "the assistant trades in its old key"],
  ["ClientRefreshStoresNew", "the assistant gets its new key"],
  ["Done", null],
  ["MemberSignsOutReadsGrants", "you press Sign out (connections looked up)"],
  ["MemberSignsOutRevokes", "the found connections are cut"],
  ["SessionRowDeleted", "your session ends"],
]);

export const step = (action: string) =>
  labels.has(action) ? (labels.get(action) ?? null) : action;
