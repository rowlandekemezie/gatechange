import { PostingTexts, PostingUnavailable } from "@rat-stack/core";
import type { FeedUnavailable, JobValue } from "@rat-stack/core";
import { Array, Effect, Layer, Option, pipe, Schema } from "effect";
import { HttpClient } from "effect/http";

import { CompanyAts } from "./boards.js";
import { fetchJson } from "./http.js";
import { nonEmpty, textOfHtml } from "./parse.js";

const OptionalString = Schema.optional(Schema.NullOr(Schema.String));

const GreenhouseDetail = Schema.Struct({ content: Schema.String });

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

const AshbyBoard = Schema.Struct({ jobs: Schema.Array(Schema.Unknown) });

const greenhouseText = (id: string, slug: string, externalId: string) =>
  fetchJson(
    id,
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs/${encodeURIComponent(externalId)}`,
    GreenhouseDetail
  ).pipe(Effect.map(({ content }) => textOfHtml(textOfHtml(content))));

const leverText = (id: string, slug: string, externalId: string) =>
  fetchJson(
    id,
    `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}/${encodeURIComponent(externalId)}`,
    LeverDetail
  ).pipe(
    Effect.map((posting) =>
      nonEmpty([
        posting.descriptionPlain,
        ...pipe(
          posting.lists ?? [],
          Array.flatMap((list) => [list.text, textOfHtml(list.content ?? "")])
        ),
        posting.additionalPlain,
        posting.salaryDescriptionPlain,
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

const ashbyText = (id: string, slug: string, externalId: string) =>
  fetchJson(
    id,
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
            new PostingUnavailable({
              id,
              message: "the posting is no longer on the Ashby board",
            })
          ),
        onSome: (job) =>
          Effect.succeed(
            nonEmpty([
              job.descriptionPlain,
              ashbyCompensation(job.compensation),
            ]).join("\n\n")
          ),
      })
    )
  );

const smartRecruitersText = (id: string, slug: string, externalId: string) =>
  fetchJson(
    id,
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
            textOfHtml(section?.text ?? ""),
          ])
        )
      ).join("\n\n")
    )
  );

const workableText = (id: string, slug: string, externalId: string) =>
  fetchJson(
    id,
    `https://apply.workable.com/api/v2/accounts/${encodeURIComponent(slug)}/jobs/${encodeURIComponent(externalId)}`,
    WorkableDetail
  ).pipe(
    Effect.map((job) =>
      nonEmpty(
        Array.map([job.description, job.requirements, job.benefits], (html) =>
          textOfHtml(html ?? "")
        )
      ).join("\n\n")
    )
  );

const textOfAts: Record<
  typeof CompanyAts.Type,
  (
    id: string,
    slug: string,
    externalId: string
  ) => Effect.Effect<
    string,
    FeedUnavailable | PostingUnavailable,
    HttpClient.HttpClient
  >
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

const jobKeyPattern = /^(?<ats>[^:]+):(?<slug>[^:]+):(?<externalId>.+)$/u;

const postingText = Effect.fnUntraced(function* postingText(job: JobValue) {
  const unavailable = (message: string) =>
    new PostingUnavailable({ id: job.id, message: message.slice(0, 500) });

  const key = Schema.decodeUnknownOption(JobKey)(
    jobKeyPattern.exec(job.id)?.groups
  );

  if (Option.isNone(key)) {
    return yield* unavailable("the id does not name a company board posting");
  }

  const { ats, externalId, slug } = key.value;

  return yield* textOfAts[ats](job.id, slug, externalId).pipe(
    Effect.catchTag("FeedUnavailable", (failure) =>
      Effect.fail(unavailable(failure.message))
    )
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
