interface Vars {
  readonly applied: number;
  readonly subs: number;
  readonly tab: Readonly<Record<string, string>>;
}

export const title = "Buying Pro from two open tabs";

const paidLabels = new Map([
  [0, "nothing paid"],
  [1, "paid once"],
  [2, "paid twice"],
]);

const openLabels = new Map([
  [0, ""],
  [1, ", 1 Stripe checkout open"],
  [2, ", 2 Stripe checkouts open"],
]);

export const state = (v: Vars) => {
  const open = Object.values(v.tab).filter((tab) => tab === "checkout").length;
  const pro = v.applied > 0 ? "Pro" : "Free";

  return `${pro}, ${paidLabels.get(v.subs) ?? "paid"}${openLabels.get(open) ?? ""}`;
};

export const group = (v: Vars) => {
  if (v.subs > 1) {
    return "bad";
  }

  return v.applied > 0 ? "pro" : "free";
};

export const colors = { bad: "pink", free: "tan", pro: "blue" };

const labels = [
  ["MemberStartsCheckout", "the member presses Upgrade in a tab"],
  ["MemberPaysInStripe", "the member pays on a Stripe checkout page"],
  ["MemberAbandons", "the member closes a checkout page"],
  ["WebhookGrantsPro", "Stripe tells the site about the payment"],
];

export const step = (action: string) =>
  labels.find(([prefix]) => action.startsWith(prefix))?.[1] ?? null;
