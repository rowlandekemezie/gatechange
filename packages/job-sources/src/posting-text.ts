import { PostingGone, PostingTexts, PostingUnavailable } from "@rat-stack/core";
import type { JobValue } from "@rat-stack/core";
import { Array, Effect, Layer, Option, pipe, Predicate, Schema } from "effect";
import { HttpClient } from "effect/http";

import { CompanyAts } from "./boards.js";
import { getJson } from "./http.js";
import { linesOfHtml, nonEmpty, textOfHtml } from "./parse.js";

const OptionalString = Schema.optional(Schema.NullOr(Schema.String));

const GreenhouseDetail = Schema.Struct({
  content: Schema.String,
  location: Schema.optional(
    Schema.NullOr(Schema.Struct({ name: OptionalString }))
  ),
});

const LeverDetail = Schema.Struct({
  additionalPlain: OptionalString,
  descriptionPlain: OptionalString,
  lists: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({ content: OptionalString, text: OptionalString })
      )
    )
  ),
  salaryDescriptionPlain: OptionalString,
  workplaceType: OptionalString,
});

const AshbyDetail = Schema.Struct({
  compensation: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        compensationTierSummary: OptionalString,
        summaryComponents: Schema.optional(
          Schema.NullOr(
            Schema.Array(
              Schema.Struct({
                compensationType: OptionalString,
                currencyCode: OptionalString,
                interval: OptionalString,
              })
            )
          )
        ),
      })
    )
  ),
  descriptionPlain: OptionalString,
  id: Schema.String,
  location: OptionalString,
  workplaceType: OptionalString,
});

const SmartRecruitersSection = Schema.optional(
  Schema.NullOr(Schema.Struct({ text: OptionalString, title: OptionalString }))
);

const SmartRecruitersDetail = Schema.Struct({
  jobAd: Schema.Struct({
    sections: Schema.Struct({
      additionalInformation: SmartRecruitersSection,
      companyDescription: SmartRecruitersSection,
      jobDescription: SmartRecruitersSection,
      qualifications: SmartRecruitersSection,
    }),
  }),
});

const WorkableDetail = Schema.Struct({
  benefits: OptionalString,
  description: OptionalString,
  requirements: OptionalString,
});

const workplaceLine = (workplaceType: string | null | undefined) =>
  workplaceType === null || workplaceType === undefined
    ? null
    : `Workplace type: ${workplaceType}`;

const locationLine = (location: string | null | undefined) =>
  location === null || location === undefined ? null : `Location: ${location}`;

const AshbyBoard = Schema.Struct({ jobs: Schema.Array(Schema.Unknown) });

const greenhouseText = ({ externalId, slug }: PostingKey) =>
  getJson(
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs/${encodeURIComponent(externalId)}`,
    GreenhouseDetail
  ).pipe(
    Effect.map(({ content, location }) =>
      nonEmpty([
        linesOfHtml(textOfHtml(content)),
        locationLine(location?.name),
      ]).join("\n\n")
    )
  );

const leverText = ({ externalId, slug }: PostingKey) =>
  getJson(
    `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}/${encodeURIComponent(externalId)}`,
    LeverDetail
  ).pipe(
    Effect.map((posting) =>
      nonEmpty([
        posting.descriptionPlain,
        ...pipe(
          posting.lists ?? [],
          Array.flatMap((list) => [list.text, linesOfHtml(list.content ?? "")])
        ),
        posting.additionalPlain,
        posting.salaryDescriptionPlain,
        workplaceLine(posting.workplaceType),
      ]).join("\n\n")
    )
  );

const ashbyCompensation = (
  compensation: typeof AshbyDetail.Type.compensation
): string | null => {
  const summary = compensation?.compensationTierSummary;

  if (summary === null || summary === undefined) {
    return null;
  }

  return pipe(
    compensation?.summaryComponents ?? [],
    Array.findFirst((part) => part.compensationType === "Salary"),
    Option.match({
      onNone: () => `Compensation: ${summary}`,
      onSome: (salary) =>
        nonEmpty([
          `Compensation: ${summary}`,
          salary.currencyCode,
          salary.interval === null || salary.interval === undefined
            ? null
            : `per ${salary.interval}`,
        ]).join(" "),
    })
  );
};

const ashbyText = ({ externalId, id, slug }: PostingKey) =>
  getJson(
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`,
    AshbyBoard
  ).pipe(
    Effect.map(({ jobs }) =>
      Array.findFirst(jobs, (item) =>
        Option.filter(
          Schema.decodeUnknownOption(AshbyDetail)(item),
          (job) => job.id === externalId
        )
      )
    ),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            new PostingGone({
              id,
              message: "the posting is no longer on the Ashby board",
            })
          ),
        onSome: (job) =>
          Effect.succeed(
            nonEmpty([
              job.descriptionPlain,
              ashbyCompensation(job.compensation),
              locationLine(job.location),
              workplaceLine(job.workplaceType),
            ]).join("\n\n")
          ),
      })
    )
  );

const smartRecruitersText = ({ externalId, slug }: PostingKey) =>
  getJson(
    `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings/${encodeURIComponent(externalId)}`,
    SmartRecruitersDetail
  ).pipe(
    Effect.map(({ jobAd: { sections } }) =>
      nonEmpty(
        pipe(
          [
            sections.companyDescription,
            sections.jobDescription,
            sections.qualifications,
            sections.additionalInformation,
          ],
          Array.flatMap((section) => [
            section?.title,
            linesOfHtml(section?.text ?? ""),
          ])
        )
      ).join("\n\n")
    )
  );

const workableText = ({ externalId, slug }: PostingKey) =>
  getJson(
    `https://apply.workable.com/api/v2/accounts/${encodeURIComponent(slug)}/jobs/${encodeURIComponent(externalId)}`,
    WorkableDetail
  ).pipe(
    Effect.map((job) =>
      nonEmpty(
        Array.map([job.description, job.requirements, job.benefits], (html) =>
          linesOfHtml(html ?? "")
        )
      ).join("\n\n")
    )
  );

type ReadFailure = Effect.Error<ReturnType<typeof getJson>>;

const textOfAts: Record<
  typeof CompanyAts.Type,
  (
    key: PostingKey
  ) => Effect.Effect<string, PostingGone | ReadFailure, HttpClient.HttpClient>
> = {
  ashby: ashbyText,
  greenhouse: greenhouseText,
  lever: leverText,
  smartrecruiters: smartRecruitersText,
  workable: workableText,
};

const JobKey = Schema.Struct({
  ats: CompanyAts,
  externalId: Schema.NonEmptyString,
  slug: Schema.NonEmptyString,
});

type PostingKey = typeof JobKey.Type & { readonly id: string };

const jobKeyPattern = /^(?<ats>[^:]+):(?<slug>[^:]+):(?<externalId>.+)$/u;

const goneStatuses: ReadonlySet<number> = new Set([404, 410]);

const postingText = Effect.fnUntraced(function* postingText(job: JobValue) {
  const key = Schema.decodeUnknownOption(JobKey)(
    jobKeyPattern.exec(job.id)?.groups
  );

  if (Option.isNone(key)) {
    return yield* new PostingGone({
      id: job.id,
      message: "the id does not name a company board posting",
    });
  }

  return yield* textOfAts[key.value.ats]({ ...key.value, id: job.id }).pipe(
    Effect.mapError((failure) => {
      if (Predicate.isTagged(failure, "PostingGone")) {
        return failure;
      }

      const status = Predicate.isTagged(failure, "HttpClientError")
        ? failure.response?.status
        : null;

      return status !== null && status !== undefined && goneStatuses.has(status)
        ? new PostingGone({
            id: job.id,
            message: `the board answered ${status} for the posting`,
          })
        : new PostingUnavailable({
            id: job.id,
            message: failure.message.slice(0, 500),
          });
    })
  );
});

export const postingTextsLayer = Layer.effect(
  PostingTexts,
  Effect.gen(function* makePostingTexts() {
    const client = yield* HttpClient.HttpClient;

    return PostingTexts.of({
      fetch: (job) =>
        postingText(job).pipe(
          Effect.provideService(HttpClient.HttpClient, client)
        ),
    });
  })
);
