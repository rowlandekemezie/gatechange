interface Vars {
  readonly mailed: Readonly<Record<string, number>>;
  readonly mailedAfterUnsub: boolean;
  readonly pc: Readonly<Record<string, string>>;
  readonly unsub: boolean;
}

export const title =
  "Weekly digest for a member who unsubscribes during a send run";

const memberPhases = (v: Vars) =>
  Object.entries(v.pc)
    .filter(([key]) => key.includes("m1"))
    .map(([, phase]) => phase);

const phaseOf = (v: Vars) => {
  const phases = memberPhases(v);

  if (phases.includes("claimed")) {
    return ", digest about to go out";
  }

  if (phases.includes("checked")) {
    return ", picked for this run";
  }

  return "";
};

export const state = (v: Vars) => {
  const mail = (v.mailed.m1 ?? 0) > 0 ? "digest delivered" : "no digest yet";
  const who = v.unsub ? "unsubscribed" : "subscribed";

  return `Member ${who}, ${mail}${phaseOf(v)}`;
};

export const group = (v: Vars) => {
  if (v.mailedAfterUnsub) {
    return "bad";
  }

  return v.unsub ? "off" : "on";
};

export const colors = { bad: "pink", off: "tan", on: "blue" };

const labels = new Map<string, string | null>([
  ["RunClaimsSend", "the run reserves this week's send"],
  ["RunMailsDigest", "the digest email goes out"],
  ["RunMarksSent", null],
  ["RunQuotaRefusal", "the mail quota is spent"],
  ["RunRechecksMember", "the run checks the member is still subscribed"],
]);

export const step = (action: string, from: Vars, to: Vars) => {
  if (action === "MemberUnsubscribes") {
    return "the member clicks Unsubscribe";
  }

  const touched =
    Object.keys(to.pc).find((key) => to.pc[key] !== from.pc[key]) ?? "";

  if (action === "Done" || !touched.includes("m1")) {
    return null;
  }

  return labels.has(action) ? (labels.get(action) ?? null) : action;
};
