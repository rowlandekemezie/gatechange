import { Option } from "effect";

import type {
  EnrichmentValue,
  ListingDetailsValue,
  RegionValue,
  RemotePolicyValue,
  SourceNameValue,
} from "./job.js";
import type { PostingValue } from "./posting.js";
import { seniorityOfTitle } from "./role.js";
import { SourceTerms } from "./source-terms.js";

export type BoardFactsValue = Pick<
  ListingDetailsValue,
  "remotePolicy" | "salary" | "seniority"
>;

export interface BoardFactsRow {
  readonly board: SourceNameValue;
  readonly facts: BoardFactsValue;
  readonly id: string;
}

const remotePolicyOf = (
  posting: PostingValue,
  region: RegionValue
): RemotePolicyValue | null => {
  if (posting.workplace === "Unspecified") {
    return null;
  }

  if (posting.workplace === "Remote") {
    return region === "RemoteGlobal" ? "Remote" : "RemoteInRegion";
  }

  return posting.workplace;
};

export const boardFactsOf = (
  listing: {
    readonly id: string;
    readonly region: RegionValue;
    readonly source: SourceNameValue;
    readonly title: string;
  },
  posting: PostingValue
): BoardFactsRow | null => {
  if (SourceTerms[listing.source].kind !== "CompanyBoard") {
    return null;
  }

  const facts: BoardFactsValue = {
    remotePolicy: remotePolicyOf(posting, listing.region),
    salary: posting.salaryBand ?? null,
    seniority: Option.getOrNull(seniorityOfTitle(listing.title)),
  };

  return facts.remotePolicy === null &&
    facts.salary === null &&
    facts.seniority === null
    ? null
    : { board: listing.source, facts, id: listing.id };
};

export const underBoardFacts = (
  existing: EnrichmentValue | null,
  details: ListingDetailsValue
): ListingDetailsValue =>
  existing === null || existing.board === null
    ? details
    : {
        ...details,
        remotePolicy: existing.remotePolicy ?? details.remotePolicy,
        salary: existing.salary ?? details.salary,
        seniority: existing.seniority ?? details.seniority,
      };
