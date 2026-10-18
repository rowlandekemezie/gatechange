import { Array, Effect, Order, pipe, Predicate, Schema } from "effect";

import { AccountId } from "./account.js";
import type { AccountIdValue } from "./account.js";
import { AlertStore } from "./alert-store.js";
import { DigestMailer } from "./digest-mailer.js";
import { fingerprintOf } from "./job-store.js";
import { EpochMillis, Region, RoleLevel } from "./job.js";
import type { JobValue, SourceNameValue } from "./job.js";
import { DAY_MILLIS } from "./posting.js";
import { SourceTerms } from "./source-terms.js";

export const WEEK_MILLIS = 7 * DAY_MILLIS;

export const MAX_SAVED_SEARCHES = 10;

export const MAX_DIGEST_JOBS = 25;

export const RECIPIENT_SENDS_PER_WEEK = 2;

export const SavedSearchId = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isMaxLength(64)),
  Schema.brand("SavedSearchId")
);

export type SavedSearchIdValue = typeof SavedSearchId.Type;

export const DigestFrequency = Schema.Literals(["Weekly"]);

export type DigestFrequencyValue = typeof DigestFrequency.Type;

export const SearchFilters = Schema.Struct({
  regions: Schema.NonEmptyArray(Region),
  roles: Schema.NonEmptyArray(RoleLevel),
  search: Schema.String.check(Schema.isMaxLength(80)),
});

export type SearchFiltersValue = typeof SearchFilters.Type;

export const SavedSearch = Schema.Struct({
  createdAt: EpochMillis,
  filters: SearchFilters,
  frequency: DigestFrequency,
  id: SavedSearchId,
  owner: AccountId,
});

export type SavedSearchValue = typeof SavedSearch.Type;

export interface DigestRecipient {
  readonly account: AccountIdValue;
  readonly email: string;
  readonly searches: readonly SavedSearchValue[];
  readonly since: number;
}

export interface Digest {
  readonly account: AccountIdValue;
  readonly jobs: readonly JobValue[];
  readonly periodStart: number;
  readonly to: string;
  readonly total: number;
}

const FIRST_MONDAY_MILLIS = 4 * DAY_MILLIS;

export const periodStartOf = (now: number) =>
  Math.floor((now - FIRST_MONDAY_MILLIS) / WEEK_MILLIS) * WEEK_MILLIS +
  FIRST_MONDAY_MILLIS;

export const alertsAllowed = (source: SourceNameValue) => {
  const terms = SourceTerms[source];

  return (
    Predicate.isTagged(terms.emailAlerts, "Allowed") ||
    (terms.kind === "CompanyBoard" &&
      Predicate.isTagged(terms.emailAlerts, "Unstated"))
  );
};

export const matchesFilters = (
  filters: SearchFiltersValue,
  job: JobValue
): boolean => {
  const needle = filters.search.trim().toLowerCase();

  return (
    Array.contains(filters.roles, job.role) &&
    Array.contains(filters.regions, job.region) &&
    (needle === "" ||
      [job.title, job.company, job.location].some((field) =>
        field.toLowerCase().includes(needle)
      ))
  );
};

const byPostedAt = Order.mapInput(
  Order.Number,
  (job: JobValue) => job.postedAt
);

const preferredCopy = Order.combine(
  Order.mapInput(Order.Number, (job: JobValue) =>
    SourceTerms[job.source].kind === "CompanyBoard" ? 0 : 1
  ),
  byPostedAt
);

export const digestFor = (
  recipient: DigestRecipient,
  periodStart: number,
  jobs: readonly JobValue[]
): Digest => {
  const matched = pipe(
    jobs
      .filter(
        (job) =>
          job.firstSeenAt >= recipient.since &&
          alertsAllowed(job.source) &&
          recipient.searches.some((search) =>
            matchesFilters(search.filters, job)
          )
      )
      .toSorted(preferredCopy),
    Array.dedupeWith(
      (left, right) => fingerprintOf(left) === fingerprintOf(right)
    )
  ).toSorted(Order.flip(byPostedAt));

  return {
    account: recipient.account,
    jobs: Array.take(matched, MAX_DIGEST_JOBS),
    periodStart,
    to: recipient.email,
    total: matched.length,
  };
};

export interface DigestPlan {
  readonly dailySendLimit: number;
  readonly sendsPerRun: number;
}

export interface DigestReceipt {
  readonly due: number;
  readonly empty: number;
  readonly failed: number;
  readonly periodStart: number;
  readonly quotaExhausted: boolean;
  readonly sent: number;
  readonly skipped: number;
}

type SendOutcome = "Sent" | "Skipped" | "Failed" | "QuotaExhausted";

const deliver = Effect.fn("deliverDigest")(function* deliverDigest(
  digest: Digest,
  now: number
) {
  const store = yield* AlertStore;
  const mailer = yield* DigestMailer;

  const claimed = yield* store.claimDigest(
    digest.account,
    digest.periodStart,
    now
  );

  if (!claimed) {
    const skipped: SendOutcome = "Skipped";

    return skipped;
  }

  return yield* mailer.send(digest).pipe(
    Effect.matchEffect({
      onFailure: (failure) =>
        store.releaseDigest(digest.account, digest.periodStart).pipe(
          Effect.tap(() =>
            Effect.logWarning("digest send failed", {
              account: digest.account,
              message: failure.message,
            })
          ),
          Effect.as<SendOutcome>(
            failure.quotaExhausted ? "QuotaExhausted" : "Failed"
          )
        ),
      onSuccess: () =>
        store
          .markSent(digest.account, digest.periodStart, now, digest.total)
          .pipe(Effect.as<SendOutcome>("Sent")),
    })
  );
});

const count = (outcomes: readonly SendOutcome[], outcome: SendOutcome) =>
  outcomes.filter((candidate) => candidate === outcome).length;

export const runDigests = Effect.fn("runDigests")(function* runDigests(
  plan: DigestPlan,
  now: number
) {
  const store = yield* AlertStore;
  const periodStart = periodStartOf(now);
  const sentToday = yield* store.sendsSince(now - DAY_MILLIS);

  const budget = Math.max(
    0,
    Math.min(plan.sendsPerRun, plan.dailySendLimit - sentToday)
  );

  const recipients = yield* store.dueRecipients(periodStart);

  const jobs = Array.isReadonlyArrayNonEmpty(recipients)
    ? yield* store.jobsSeenSince(
        Math.min(...recipients.map((recipient) => recipient.since))
      )
    : [];

  const digests = recipients.map((recipient) =>
    digestFor(recipient, periodStart, jobs)
  );

  const withMatches = digests.filter((digest) => digest.total > 0);
  const outcomes: SendOutcome[] = [];

  for (const digest of Array.take(withMatches, budget)) {
    const outcome = yield* deliver(digest, now);

    outcomes.push(outcome);

    if (outcome === "QuotaExhausted") {
      break;
    }
  }

  const receipt: DigestReceipt = {
    due: recipients.length,
    empty: digests.length - withMatches.length,
    failed: count(outcomes, "Failed") + count(outcomes, "QuotaExhausted"),
    periodStart,
    quotaExhausted: outcomes.includes("QuotaExhausted"),
    sent: count(outcomes, "Sent"),
    skipped: count(outcomes, "Skipped") + withMatches.length - outcomes.length,
  };

  return receipt;
});
