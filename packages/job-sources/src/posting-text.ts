import {
  annualSalaryBandOf,
  namesVariablePay,
  PostingGone,
  PostingTexts,
  PostingUnavailable,
} from "@rat-stack/core";
import type {
  JobValue,
  PostingTextValue,
  SalaryBandValue,
  SalaryPeriodValue,
} from "@rat-stack/core";
import {
  Array,
  Effect,
  Layer,
  Match,
  Option,
  pipe,
  Predicate,
  Schema,
} from "effect";
import { HttpClient } from "effect/http";

import { CompanyAts } from "./boards.js";
import { getJson } from "./http.js";
import { linesOfHtml, nonEmpty, textOfHtml, workplaceOf } from "./parse.js";
import {
  SmartRecruitersLocation,
  smartRecruitersWorkplaceOf,
} from "./smartrecruiters.js";

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
  salaryRange: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        currency: Schema.String,
        interval: Schema.String,
        max: Schema.Finite,
        min: Schema.Finite,
      })
    )
  ),
  workplaceType: OptionalString,
});

const AshbyDetail = Schema.Struct({
  address: Schema.optional(Schema.Unknown),
  compensation: Schema.optional(Schema.Unknown),
  descriptionPlain: OptionalString,
  id: Schema.String,
  location: OptionalString,
  workplaceType: OptionalString,
});

const SmartRecruitersSection = Schema.optional(
  Schema.NullOr(Schema.Struct({ text: OptionalString, title: OptionalString }))
);

const SmartRecruitersCompensation = Schema.Struct({
  currency: Schema.String,
  max: Schema.Finite,
  min: Schema.Finite,
  period: OptionalString,
});

const SmartRecruitersDetail = Schema.Struct({
  compensation: Schema.optional(Schema.Unknown),
  jobAd: Schema.Struct({
    sections: Schema.Struct({
      additionalInformation: SmartRecruitersSection,
      companyDescription: SmartRecruitersSection,
      jobDescription: SmartRecruitersSection,
      qualifications: SmartRecruitersSection,
    }),
  }),
  location: Schema.optional(Schema.Unknown),
});

const WorkableDetail = Schema.Struct({
  benefits: OptionalString,
  description: OptionalString,
  requirements: OptionalString,
  workplace: OptionalString,
});

const locationLine = (location: string | null | undefined) =>
  location === null || location === undefined ? null : `Location: ${location}`;

const leverSalaryLine = (range: typeof LeverDetail.Type.salaryRange) =>
  range === null || range === undefined
    ? null
    : `Salary range: ${range.min.toLocaleString("en-US")} - ${range.max.toLocaleString("en-US")} ${range.currency} per ${range.interval.split("-")[1] ?? "year"}`;

const AshbyBoard = Schema.Struct({ jobs: Schema.Array(Schema.Unknown) });

const greenhouseText = ({ externalId, slug }: PostingKey) =>
  getJson(
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs/${encodeURIComponent(externalId)}`,
    GreenhouseDetail
  ).pipe(
    Effect.map(({ content, location }): PostingTextValue => ({
      salary: null,
      text: nonEmpty([
        linesOfHtml(textOfHtml(content)),
        locationLine(location?.name),
      ]).join("\n\n"),
      workplace: "Unspecified",
    }))
  );

const leverText = ({ externalId, slug }: PostingKey) =>
  getJson(
    `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}/${encodeURIComponent(externalId)}`,
    LeverDetail
  ).pipe(
    Effect.map((posting): PostingTextValue => ({
      salary: null,
      text: nonEmpty([
        posting.descriptionPlain,
        ...pipe(
          posting.lists ?? [],
          Array.flatMap((list) => [list.text, linesOfHtml(list.content ?? "")])
        ),
        posting.additionalPlain,
        posting.salaryDescriptionPlain,
        leverSalaryLine(posting.salaryRange),
      ]).join("\n\n"),
      workplace: workplaceOf(posting.workplaceType),
    }))
  );

const AshbyCompensation = Schema.Struct({
  compensationTierSummary: Schema.optional(Schema.Unknown),
  compensationTiers: Schema.optional(Schema.Unknown),
  summaryComponents: Schema.optional(Schema.Unknown),
});

type AshbyCompensationValue = typeof AshbyCompensation.Type;

const AshbySummaryComponent = Schema.Struct({
  compensationType: OptionalString,
  currencyCode: OptionalString,
  interval: OptionalString,
});

const AshbyTier = Schema.Struct({
  additionalInformation: OptionalString,
  components: Schema.Array(Schema.Unknown),
  title: OptionalString,
});

type AshbyTierValue = typeof AshbyTier.Type;

const AshbySalaryComponent = Schema.Struct({
  compensationType: Schema.Literal("Salary"),
  currencyCode: Schema.String,
  interval: Schema.String,
  maxValue: Schema.Finite,
  minValue: Schema.Finite,
  summary: OptionalString,
});

const AshbyAddress = Schema.Struct({
  postalAddress: Schema.Struct({
    addressCountry: OptionalString,
    addressLocality: OptionalString,
    addressRegion: OptionalString,
  }),
});

const decodeList = Schema.decodeUnknownOption(Schema.Array(Schema.Unknown));

const decodeAshbyAddress = Schema.decodeUnknownOption(AshbyAddress);

const decodeAshbyTier = Schema.decodeUnknownOption(AshbyTier);

const decodeAshbySalaryComponent =
  Schema.decodeUnknownOption(AshbySalaryComponent);

const ashbyCompensation = ({
  compensationTierSummary,
  summaryComponents,
}: AshbyCompensationValue): string | null =>
  pipe(
    Schema.decodeUnknownOption(Schema.String)(compensationTierSummary),
    Option.map((summary) =>
      pipe(
        decodeList(summaryComponents),
        Option.getOrElse((): readonly unknown[] => []),
        Array.findFirst((part) =>
          Option.filter(
            Schema.decodeUnknownOption(AshbySummaryComponent)(part),
            (component) => component.compensationType === "Salary"
          )
        ),
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
      )
    ),
    Option.getOrNull
  );

const ashbyPeriodOf = (interval: string) =>
  Match.value(interval).pipe(
    Match.withReturnType<SalaryPeriodValue | null>(),
    Match.when("1 HOUR", () => "Hour"),
    Match.when("1 MONTH", () => "Month"),
    Match.when("1 YEAR", () => "Year"),
    Match.orElse(() => null)
  );

const countryNames: readonly (readonly string[])[] = [
  ["United States", "USA", "US"],
  ["United Kingdom", "UK"],
];

const wordsOf = (text: string) =>
  ` ${text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .join(" ")
    .trim()} `;

const namesOfPlace = (place: string) =>
  pipe(
    countryNames,
    Array.findFirst((names) =>
      names.some((name) => wordsOf(name) === wordsOf(place))
    ),
    Option.getOrElse(() => [place])
  );

const titleNamesPlace = (title: string, place: string) =>
  namesOfPlace(place).some(
    (name) =>
      wordsOf(name).trim() !== "" && wordsOf(title).includes(wordsOf(name))
  );

const placesOf = (
  location: string | null | undefined,
  address: Option.Option<typeof AshbyAddress.Type>
) =>
  nonEmpty([
    location,
    ...pipe(
      address,
      Option.match({
        onNone: () => [],
        onSome: ({ postalAddress }) => [
          postalAddress.addressLocality,
          postalAddress.addressRegion,
          postalAddress.addressCountry,
        ],
      })
    ),
  ]);

const ashbyTierFor = (tiers: readonly unknown[], places: readonly string[]) =>
  pipe(
    places,
    Array.findFirst((place) =>
      Array.findFirst(tiers, (item) =>
        Option.filter(
          decodeAshbyTier(item),
          ({ title }) =>
            title !== null &&
            title !== undefined &&
            titleNamesPlace(title, place)
        )
      )
    ),
    Option.orElse(() => Option.flatMap(Array.head(tiers), decodeAshbyTier))
  );

const labelsVariablePay = (
  tier: AshbyTierValue,
  summary: string | null | undefined
) =>
  nonEmpty([summary, tier.title, tier.additionalInformation]).some(
    namesVariablePay
  );

const ashbySalary = (
  { compensationTiers }: AshbyCompensationValue,
  places: readonly string[]
): SalaryBandValue | null =>
  pipe(
    ashbyTierFor(
      Option.getOrElse(decodeList(compensationTiers), () => []),
      places
    ),
    Option.flatMap((tier) =>
      pipe(
        Array.findFirst(tier.components, (component) =>
          decodeAshbySalaryComponent(component)
        ),
        Option.filter(({ summary }) => !labelsVariablePay(tier, summary))
      )
    ),
    Option.flatMap((salary) =>
      pipe(
        Option.fromNullishOr(ashbyPeriodOf(salary.interval)),
        Option.flatMap((period) =>
          Option.fromNullishOr(
            annualSalaryBandOf(
              {
                currency: salary.currencyCode,
                max: salary.maxValue,
                min: salary.minValue,
              },
              period
            )
          )
        )
      )
    ),
    Option.getOrNull
  );

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
        onSome: (job) => {
          const compensation = pipe(
            Schema.decodeUnknownOption(AshbyCompensation)(job.compensation),
            Option.getOrElse(() => ({}))
          );

          return Effect.succeed<PostingTextValue>({
            salary: ashbySalary(
              compensation,
              placesOf(job.location, decodeAshbyAddress(job.address))
            ),
            text: nonEmpty([
              job.descriptionPlain,
              ashbyCompensation(compensation),
              locationLine(job.location),
            ]).join("\n\n"),
            workplace: workplaceOf(job.workplaceType),
          });
        },
      })
    )
  );

const smartRecruitersPeriodOf = (period: string | null | undefined) =>
  Match.value(period).pipe(
    Match.withReturnType<SalaryPeriodValue | null>(),
    Match.when("HOURLY", () => "Hour"),
    Match.when("MONTHLY", () => "Month"),
    Match.when("YEARLY", () => "Year"),
    Match.orElse(() => null)
  );

const decodeSmartRecruitersCompensation = Schema.decodeUnknownOption(
  SmartRecruitersCompensation
);

const smartRecruitersSalary = (
  range: typeof SmartRecruitersCompensation.Type
) =>
  pipe(
    Option.fromNullishOr(smartRecruitersPeriodOf(range.period)),
    Option.flatMap((period) =>
      Option.fromNullishOr(annualSalaryBandOf(range, period))
    )
  );

const smartRecruitersText = ({ externalId, slug }: PostingKey) =>
  getJson(
    `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings/${encodeURIComponent(externalId)}`,
    SmartRecruitersDetail
  ).pipe(
    Effect.map(
      ({ compensation, jobAd: { sections }, location }): PostingTextValue => ({
        salary: pipe(
          decodeSmartRecruitersCompensation(compensation),
          Option.flatMap(smartRecruitersSalary),
          Option.getOrNull
        ),
        text: nonEmpty(
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
        ).join("\n\n"),
        workplace: smartRecruitersWorkplaceOf(
          Option.getOrNull(
            Schema.decodeUnknownOption(SmartRecruitersLocation)(location)
          )
        ),
      })
    )
  );

const workableText = ({ externalId, slug }: PostingKey) =>
  getJson(
    `https://apply.workable.com/api/v2/accounts/${encodeURIComponent(slug)}/jobs/${encodeURIComponent(externalId)}`,
    WorkableDetail
  ).pipe(
    Effect.map((job): PostingTextValue => ({
      salary: null,
      text: nonEmpty(
        Array.map([job.description, job.requirements, job.benefits], (html) =>
          linesOfHtml(html ?? "")
        )
      ).join("\n\n"),
      workplace: workplaceOf(job.workplace),
    }))
  );

type ReadFailure = Effect.Error<ReturnType<typeof getJson>>;

const textOfAts: Record<
  typeof CompanyAts.Type,
  (
    key: PostingKey
  ) => Effect.Effect<
    PostingTextValue,
    PostingGone | ReadFailure,
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
