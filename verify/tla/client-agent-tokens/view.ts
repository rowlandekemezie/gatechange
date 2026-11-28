interface Issue {
  readonly id: number;
  readonly phase: string;
}

interface Vars {
  readonly issue: string;
  readonly issues: readonly Issue[];
  readonly revealed: readonly number[];
  readonly route: string;
  readonly server: readonly number[];
}

export const title = "Agent tokens: create, reveal the secret once, revoke";

const lostSecret = (v: Vars) =>
  v.server.some(
    (id) =>
      !v.revealed.includes(id) &&
      !v.issues.some((r) => r.phase === "ok" && r.id === id)
  );

const issueLabels = new Map<string, string>([
  ["Issued", "Secret shown once"],
  ["Issuing", "Creating token"],
  ["Refused", "Create refused (limit)"],
]);

export const state = (v: Vars) => {
  if (v.route === "board") {
    return lostSecret(v)
      ? "Left the page, a secret was never shown"
      : "Left the account page";
  }

  if (lostSecret(v)) {
    return "Token exists, its secret was never shown";
  }

  return issueLabels.get(v.issue) ?? "Account page";
};

export const group = (v: Vars) => (v.route === "board" ? "away" : "account");

export const colors = { account: "blue", away: "tan" };

const labels = new Map<string, string | null>([
  ["Done", null],
  ["IssueAnswers", "the new token reaches the page"],
  ["ReaderComesBack", "you come back"],
  ["ReaderCreates", "you tap Create token"],
  ["ReaderLeaves", "you leave the account page"],
  ["ReaderRevokes", "you tap Revoke"],
  ["RevokeAnswers", null],
  ["ServerIssues", "the server makes the token"],
]);

export const step = (action: string) =>
  labels.has(action) ? (labels.get(action) ?? null) : action;
