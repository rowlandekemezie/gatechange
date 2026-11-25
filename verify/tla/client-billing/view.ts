interface Vars {
  readonly action: string;
  readonly membership: string;
  readonly session: string;
}

export const title = "Pro badge and checkout across sign-out";

const who = new Map<string, string>([
  ["checking", "Checking sign-in"],
  ["in", "Signed in"],
  ["out", "Signed out"],
]);

const badges = new Map<string, string>([
  ["Free", "Upgrade button"],
  ["Loading", "plan loading"],
  ["Pro", "Pro badge"],
]);

export const state = (v: Vars) => {
  const busy = v.action === "Redirecting" ? ", opening Stripe" : "";

  return `${who.get(v.session) ?? v.session}, ${badges.get(v.membership) ?? "Pricing link"}${busy}`;
};

export const group = (v: Vars) =>
  v.session === "checking" ? "start" : v.session;

export const colors = { in: "blue", out: "purple", start: "tan" };

const labels = new Map<string, string | null>([
  ["CheckoutFails", "checkout fails to start"],
  ["Done", null],
  ["MembershipArrives", "your plan arrives"],
  ["ReaderChoosesPlan", "you click a plan"],
  ["ReaderOpensAccount", "you open your account page"],
  ["ReaderSignsOut", "you sign out"],
  ["SessionSaysSignedIn", "the sign-in check says signed in"],
]);

export const step = (action: string) =>
  labels.has(action) ? (labels.get(action) ?? null) : action;
