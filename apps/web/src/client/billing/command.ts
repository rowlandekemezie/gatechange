import { Plan } from "@rat-stack/core/contracts";
import type { BillingFailureValue } from "@rat-stack/core/contracts";
import { Duration, Effect, Match, Option, Schema } from "effect";
import type { RpcClientError } from "effect/rpc";
import { Command } from "foldkit";
import { load } from "foldkit/navigation";

import { JobQueries } from "../board/queries.js";
import { Message } from "./message.js";

const UNAVAILABLE = "Billing is unavailable right now. Try again in a minute.";

type Failure = BillingFailureValue | RpcClientError.RpcClientError;

const problemOf = (failure: Failure) =>
  Match.valueTags(failure, {
    AlreadyPro: () => "You already have Pro. Manage it from your account page.",
    BillingUnavailable: ({ message }) => message,
    JobStoreUnavailable: () => UNAVAILABLE,
    NoBillingAccount: () =>
      "There is no subscription to manage yet. Choose a plan on the pricing page.",
    ProRequired: () =>
      "Instant alerts come with Pro. Choose a plan to turn them on.",
    RpcClientError: () => UNAVAILABLE,
    Unauthorized: () => "Sign in first, then choose a plan.",
  });

const redirectTo = <E extends Failure>(
  link: Effect.Effect<{ readonly url: string }, E, JobQueries>
) =>
  link.pipe(
    Effect.flatMap(({ url }) => load(url)),
    Effect.match({
      onFailure: (failure) =>
        Message.FailedBillingAction({ message: problemOf(failure) }),
      onSuccess: () => Message.CompletedRedirect(),
    })
  );

const fetched = (delay: Duration.Duration) =>
  Effect.sleep(delay).pipe(
    Effect.andThen(JobQueries.use((queries) => queries.membership)),
    Effect.match({
      onFailure: () =>
        Message.CompletedFetchMembership({ membership: Option.none() }),
      onSuccess: (membership) =>
        Message.CompletedFetchMembership({
          membership: Option.some(membership),
        }),
    })
  );

export const FetchMembership = Command.define("FetchMembership", {
  execute: fetched(Duration.zero),
  messages: [Message.CompletedFetchMembership],
});

export const PollMembership = Command.define("PollMembership", {
  execute: fetched(Duration.seconds(2)),
  messages: [Message.CompletedFetchMembership],
});

export const FetchPlans = Command.define("FetchPlans", {
  execute: JobQueries.use((queries) => queries.proPlans).pipe(
    Effect.match({
      onFailure: () => Message.CompletedFetchPlans({ plans: [] }),
      onSuccess: (plans) => Message.CompletedFetchPlans({ plans }),
    })
  ),
  messages: [Message.CompletedFetchPlans],
});

export const StartCheckout = Command.define("StartCheckout", {
  args: { plan: Plan },
  execute: ({ plan }) =>
    redirectTo(JobQueries.use((queries) => queries.startCheckout(plan))),
  messages: [Message.FailedBillingAction, Message.CompletedRedirect],
});

export const OpenBillingPortal = Command.define("OpenBillingPortal", {
  execute: redirectTo(JobQueries.use((queries) => queries.openBillingPortal)),
  messages: [Message.FailedBillingAction, Message.CompletedRedirect],
});

export const SetInstantAlerts = Command.define("SetInstantAlerts", {
  args: { enabled: Schema.Boolean },
  execute: ({ enabled }) =>
    JobQueries.use((queries) => queries.setInstantAlerts(enabled)).pipe(
      Effect.match({
        onFailure: (failure) =>
          Message.FailedBillingAction({ message: problemOf(failure) }),
        onSuccess: (membership) =>
          Message.CompletedSetInstantAlerts({ membership }),
      })
    ),
  messages: [Message.FailedBillingAction, Message.CompletedSetInstantAlerts],
});
