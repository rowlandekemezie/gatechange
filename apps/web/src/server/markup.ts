import {
  MAX_AGE_DAYS,
  Permission,
  SourceTerms,
} from "@rat-stack/core/contracts";
import type { JobValue, PermissionValue } from "@rat-stack/core/contracts";
import { DateTime, Match, Option } from "effect";

export type MarkupPolicy = (permission: PermissionValue) => boolean;

export const allowedOnly: MarkupPolicy = Permission.$is("Allowed");

export const allowedOrUnstated: MarkupPolicy = (permission) =>
  !Permission.$is("Forbidden")(permission);

export const markupPolicy: MarkupPolicy = allowedOnly;

export interface JobPostingLd {
  readonly "@context": "https://schema.org/";
  readonly "@type": "JobPosting";
  readonly datePosted: string;
  readonly description: string;
  readonly directApply: false;
  readonly hiringOrganization: {
    readonly "@type": "Organization";
    readonly name: string;
  };
  readonly jobLocation: {
    readonly "@type": "Place";
    readonly address: {
      readonly "@type": "PostalAddress";
      readonly addressLocality: string;
    };
  };
  readonly jobLocationType?: "TELECOMMUTE";
  readonly title: string;
  readonly url: string;
  readonly validThrough: string;
}

const locationTypeOf = Match.type<JobValue["arrangement"]>().pipe(
  Match.when("Remote", () => ({ jobLocationType: "TELECOMMUTE" as const })),
  Match.orElse(() => ({}))
);

export const jobPostingOf = (
  job: JobValue,
  canonicalUrl: string,
  policy: MarkupPolicy = markupPolicy
): Option.Option<JobPostingLd> =>
  policy(SourceTerms[job.source].jobPostingMarkup)
    ? Option.some({
        "@context": "https://schema.org/",
        "@type": "JobPosting",
        datePosted: DateTime.formatIso(DateTime.makeUnsafe(job.postedAt)),
        description: `${job.title} at ${job.company}. ${job.location}`,
        directApply: false,
        hiringOrganization: { "@type": "Organization", name: job.company },
        jobLocation: {
          "@type": "Place",
          address: { "@type": "PostalAddress", addressLocality: job.location },
        },
        title: job.title,
        url: canonicalUrl,
        validThrough: DateTime.formatIso(
          DateTime.add(DateTime.makeUnsafe(job.postedAt), {
            days: MAX_AGE_DAYS,
          })
        ),
        ...locationTypeOf(job.arrangement),
      })
    : Option.none();
