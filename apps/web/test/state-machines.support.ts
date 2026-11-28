import {
  Account,
  AgentToken,
  FREE,
  ProEntitlement,
  SavedSearch,
} from "@rat-stack/core/contracts";
import type {
  JobValue,
  ListedJobValue,
  MembershipValue,
  TrackedJobValue,
} from "@rat-stack/core/contracts";
import { Array, Option, pipe, Schema } from "effect";
import { fromString } from "foldkit/url";

import { Message as AccountMessage } from "../src/client/account/message.js";
import type { MessageValue as AccountMessageValue } from "../src/client/account/message.js";
import { Message as BillingMessage } from "../src/client/billing/message.js";
import type { MessageValue as BillingMessageValue } from "../src/client/billing/message.js";
import { Message } from "../src/client/board/message.js";
import type { MessageValue } from "../src/client/board/message.js";
import { Preload, Shortlist } from "../src/client/board/model.js";
import type { MarkedJobValue, ModelValue } from "../src/client/board/model.js";
import { init, update } from "../src/client/board/update.js";

export const ORIGIN = "https://jobs.example";

export interface Step {
  readonly commands: readonly {
    readonly name: string;
    readonly args?: unknown;
  }[];
  readonly model: ModelValue;
}

export interface Path {
  readonly all: Step["commands"];
  readonly last: Step;
}

export const urlAt = (path: string) =>
  Option.getOrThrow(fromString(`${ORIGIN}${path}`));

export const started = (path: string): Step => {
  const { commands = [], model } = init(
    { origin: ORIGIN, preload: Preload.Nothing() },
    urlAt(path)
  );

  return { commands, model };
};

export const sent = (step: Step, message: MessageValue): Step => {
  const { commands = [], model } = update(step.model, message);

  return { commands, model };
};

export const walked = (step: Step, messages: readonly MessageValue[]): Path => {
  let last = step;
  const all: Step["commands"][number][] = [];

  for (const message of messages) {
    last = sent(last, message);
    all.push(...last.commands);
  }

  return { all, last };
};

export const sentAll = (step: Step, messages: readonly MessageValue[]): Step =>
  walked(step, messages).last;

export const named = (commands: Step["commands"], name: string) =>
  pipe(
    commands,
    Array.filter((command) => command.name === name)
  );

const ShortlistWrite = Schema.Struct({ marks: Shortlist });

export const lastWrittenShortlist = (commands: Step["commands"]) =>
  Schema.decodeUnknownSync(ShortlistWrite)(
    Option.getOrThrow(Array.last(named(commands, "WriteShortlist"))).args
  ).marks;

export const account = (message: AccountMessageValue) =>
  Message.GotAccountMessage({ message });

export const billing = (message: BillingMessageValue) =>
  Message.GotBillingMessage({ message });

export const ada = Schema.decodeSync(Account)({
  email: "ada@example.com",
  id: "user_ada",
  name: "Ada",
});

export const signedIn = account(
  AccountMessage.CompletedFetchSession({ account: Option.some(ada) })
);

export const signedOutAtLoad = account(
  AccountMessage.CompletedFetchSession({ account: Option.none() })
);

export const signOut: readonly MessageValue[] = [
  account(AccountMessage.ClickedSignOut()),
  account(AccountMessage.CompletedSignOut()),
  account(AccountMessage.CompletedFetchSession({ account: Option.none() })),
];

export const leftTo = (path: string) =>
  Message.ChangedUrl({ url: urlAt(path) });

export const jobOf = (id: string, title: string): JobValue => ({
  arrangement: "Remote",
  company: "Moniepoint",
  feed: "himalayas:engineering-manager",
  firstSeenAt: 1_760_000_000_000,
  id,
  lastSeenAt: 1_760_000_000_000,
  location: "Remote, Canada",
  postedAt: 1_760_000_000_000,
  region: "RemoteCanada",
  relevance: 12,
  role: "EngineeringManager",
  salary: null,
  source: "Himalayas",
  title,
  url: `https://himalayas.app/jobs/${id}`,
});

export const oldJob = jobOf("himalayas:old", "Engineering Manager");

export const newJob = jobOf("himalayas:new", "Director of Engineering");

export const markOf = (
  job: JobValue,
  kind: MarkedJobValue["kind"] = "Saved"
): MarkedJobValue => ({
  company: job.company,
  id: job.id,
  kind,
  location: job.location,
  title: job.title,
  url: job.url,
});

export const trackedOf = (
  job: JobValue,
  stage: TrackedJobValue["stage"]
): TrackedJobValue => ({
  jobId: job.id,
  listed: true,
  movedAt: 1_760_000_000_000,
  notes: "",
  savedAt: 1_760_000_000_000,
  snapshot: {
    company: job.company,
    location: job.location,
    title: job.title,
    url: job.url,
  },
  stage,
});

export const listedOf = (id: string): ListedJobValue => ({
  ...jobOf(id, `Role ${id}`),
  daysOpen: 0,
  enrichment: null,
  reposts: 0,
  status: "on_time",
});

export const free: MembershipValue = {
  entitlement: FREE,
  instantAlerts: false,
};

export const pro: MembershipValue = {
  entitlement: ProEntitlement.make({
    periodEnd: Date.UTC(2026, 10, 18),
    plan: "Monthly",
    renews: true,
  }),
  instantAlerts: false,
};

export const membershipArrives = (membership: MembershipValue) =>
  billing(
    BillingMessage.CompletedFetchMembership({
      membership: Option.some(membership),
    })
  );

export const tokenOf = Schema.decodeSync(AgentToken);

export const savedSearchOf = Schema.decodeSync(SavedSearch);
