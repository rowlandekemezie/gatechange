import { Array, Effect, Order, pipe, Predicate, Schema } from "effect";

import { AccountId } from "./account.js";
import type { AccountIdValue } from "./account.js";
import { AlertStore } from "./alert-store.js";
import { DigestMailer } from "./digest-mailer.js";
import { paidFeaturesAllowed } from "./entitlement.js";
import { fingerprintOf } from "./job-store.js";
import { EpochMillis, Region, RoleLevel, SourceName } from "./job.js";
import type { JobValue, SourceNameValue } from "./job.js";
import { DAY_MILLIS } from "./posting.js";
import { SourceTerms } from "./source-terms.js";
import type { SourceTermsValue } from "./source-terms.js";

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

export const Cadence = Schema.Literals(["Weekly", "Instant"]);

export type CadenceValue = typeof Cadence.Type;

export const INSTANT_WINDOW_MILLIS = 20 * 60 * 1000;

export const INSTANT_SENDS_PER_MEMBER_PER_DAY = 6;

export const INSTANT_SHARE_OF_DAILY_SENDS = 0.2;

export const dailySendsFor = (
  cadence: CadenceValue,
  dailySendLimit: number
) => {
  const instant = Math.floor(dailySendLimit * INSTANT_SHARE_OF_DAILY_SENDS);

  return cadence === "Instant" ? instant : dailySendLimit - instant;
};

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
  readonly cadence: CadenceValue;
  readonly jobs: readonly JobValue[];
  readonly periodStart: number;
  readonly to: string;
  readonly total: number;
}

const FIRST_MONDAY_MILLIS = 4 * DAY_MILLIS;

export const periodStartOf = (now: number) =>
  Math.floor((now - FIRST_MONDAY_MILLIS) / WEEK_MILLIS) * WEEK_MILLIS +
  FIRST_MONDAY_MILLIS;

export const windowStartOf = (now: number) =>
  Math.floor(now / INSTANT_WINDOW_MILLIS) * INSTANT_WINDOW_MILLIS;

const periodOf = (cadence: CadenceValue, now: number) =>
  cadence === "Weekly" ? periodStartOf(now) : windowStartOf(now);

export const alertsAllowed = (
  source: SourceNameValue,
  terms: Readonly<Record<SourceNameValue, SourceTermsValue>> = SourceTerms
) => Predicate.isTagged(terms[source].emailAlerts, "Allowed");

export const digestSourceLabels = (
  terms: Readonly<Record<SourceNameValue, SourceTermsValue>> = SourceTerms
) =>
  SourceName.literals
    .filter((source) => alertsAllowed(source, terms))
    .map((source) => terms[source].label);

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
  jobs: readonly JobValue[],
  terms: Readonly<Record<SourceNameValue, SourceTermsValue>> = SourceTerms,
  cadence: CadenceValue = "Weekly"
): Digest => {
  const matched = pipe(
    jobs
      .filter(
        (job) =>
          job.firstSeenAt >= recipient.since &&
          alertsAllowed(job.source, terms) &&
          (cadence === "Weekly" || paidFeaturesAllowed(job.source, terms)) &&
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
    cadence,
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
  selected: Digest,
  jobs: readonly JobValue[],
  now: number,
  dailyLimit: number
) {
  const store = yield* AlertStore;
  const mailer = yield* DigestMailer;

  const current = yield* store.dueRecipients(
    selected.cadence,
    selected.periodStart,
    now,
    selected.account
  );

  const recipient = current.find(
    (candidate) => candidate.account === selected.account
  );

  if (recipient === undefined) {
    const skipped: SendOutcome = "Skipped";

    return skipped;
  }

  const digest = digestFor(
    recipient,
    selected.periodStart,
    jobs,
    SourceTerms,
    selected.cadence
  );

  if (digest.total === 0) {
    const skipped: SendOutcome = "Skipped";

    return skipped;
  }

  const claimed = yield* store.claimDigest(
    digest.cadence,
    digest.account,
    digest.periodStart,
    now,
    dailyLimit
  );

  if (!claimed) {
    const skipped: SendOutcome = "Skipped";

    return skipped;
  }

  return yield* mailer.send(digest).pipe(
    Effect.matchEffect({
      onFailure: (failure) =>
        (failure.quotaExhausted
          ? store.releaseDigest(
              digest.cadence,
              digest.account,
              digest.periodStart
            )
          : Effect.void
        ).pipe(
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
          .markSent(
            digest.cadence,
            digest.account,
            digest.periodStart,
            now,
            digest.total
          )
          .pipe(Effect.as<SendOutcome>("Sent")),
    })
  );
});

const count = (outcomes: readonly SendOutcome[], outcome: SendOutcome) =>
  outcomes.filter((candidate) => candidate === outcome).length;

const runAlerts = Effect.fn("runAlerts")(function* runAlerts(
  cadence: CadenceValue,
  plan: DigestPlan,
  now: number
) {
  const store = yield* AlertStore;
  const periodStart = periodOf(cadence, now);
  const sentToday = yield* store.sendsSince(cadence, now - DAY_MILLIS);

  const budget = Math.max(
    0,
    Math.min(
      plan.sendsPerRun,
      dailySendsFor(cadence, plan.dailySendLimit) - sentToday
    )
  );

  const recipients = yield* store.dueRecipients(cadence, periodStart, now);

  const jobs = Array.isReadonlyArrayNonEmpty(recipients)
    ? yield* store.jobsSeenSince(
        Math.min(...recipients.map((recipient) => recipient.since))
      )
    : [];

  const digests = recipients.map((recipient) =>
    digestFor(recipient, periodStart, jobs, SourceTerms, cadence)
  );

  const withMatches = digests.filter((digest) => digest.total > 0);
  const outcomes: SendOutcome[] = [];

  for (const digest of Array.take(withMatches, budget)) {
    const outcome = yield* deliver(
      digest,
      jobs,
      now,
      dailySendsFor(cadence, plan.dailySendLimit)
    );

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

export const runDigests = (plan: DigestPlan, now: number) =>
  runAlerts("Weekly", plan, now);

export const runInstantAlerts = (plan: DigestPlan, now: number) =>
  runAlerts("Instant", plan, now);
