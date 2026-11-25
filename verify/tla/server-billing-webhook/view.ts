interface Vars {
  readonly delivered: Readonly<Record<string, number>>;
  readonly stored: string;
}

export const title =
  "Pro renewal shown on the account page as Stripe events arrive";

const everyEventIn = (v: Vars) =>
  Object.values(v.delivered).every((count) => count >= 1);

export const state = (v: Vars) => {
  if (v.stored === "none") {
    return "No Pro yet";
  }

  const shown =
    v.stored === "cancel" ? "Pro, shown as ending" : "Pro, shown as renewing";

  return everyEventIn(v)
    ? `${shown}, every event in`
    : `${shown}, events still arriving`;
};

export const group = (v: Vars) => {
  if (v.stored === "none") {
    return "free";
  }

  return everyEventIn(v) && v.stored === "cancel" ? "bad" : "pro";
};

export const colors = { bad: "pink", free: "tan", pro: "blue" };

const events = new Map([
  ["cancel", 'Stripe sends "member cancelled"'],
  ["created", 'Stripe sends "subscription started"'],
  ["resume", 'Stripe sends "member resumed, same second"'],
]);

export const step = (action: string, from: Vars, to: Vars) => {
  if (action === "Done") {
    return null;
  }

  const sent = Object.keys(to.delivered).find(
    (key) => to.delivered[key] !== from.delivered[key]
  );

  const again = (to.delivered[sent ?? ""] ?? 0) > 1 ? " again" : "";

  return `${events.get(sent ?? "") ?? sent}${again}`;
};
