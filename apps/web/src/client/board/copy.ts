import type {
  HandsOnValue,
  ListingStatusValue,
  RegionValue,
  RemotePolicyValue,
  RoleLevelValue,
  SalaryBandValue,
  SeniorityValue,
  SourceNameValue,
} from "@rat-stack/core/contracts";
import { Match } from "effect";

import type { AgeWindowValue, RegionGroupValue } from "./filters.js";

export const roleChip = Match.type<RoleLevelValue>().pipe(
  Match.when("EngineeringManager", () => "engineering manager"),
  Match.when("Director", () => "director"),
  Match.when("HeadOfEngineering", () => "head of engineering"),
  Match.when("VicePresident", () => "VP"),
  Match.exhaustive
);

export const roleLabel = Match.type<RoleLevelValue>().pipe(
  Match.when("EngineeringManager", () => "Engineering manager"),
  Match.when("Director", () => "Director"),
  Match.when("HeadOfEngineering", () => "Head of engineering"),
  Match.when("VicePresident", () => "VP"),
  Match.exhaustive
);

export const seniorityChip = Match.type<SeniorityValue>().pipe(
  Match.when("Manager", () => "manager"),
  Match.when("SeniorManager", () => "senior manager"),
  Match.when("Director", () => "director"),
  Match.when("SeniorDirector", () => "senior director"),
  Match.when("VicePresident", () => "VP"),
  Match.when("Executive", () => "executive"),
  Match.exhaustive
);

export const seniorityLabel = Match.type<SeniorityValue>().pipe(
  Match.when("Manager", () => "Manager"),
  Match.when("SeniorManager", () => "Senior manager"),
  Match.when("Director", () => "Director"),
  Match.when("SeniorDirector", () => "Senior director"),
  Match.when("VicePresident", () => "Vice president"),
  Match.when("Executive", () => "Executive"),
  Match.exhaustive
);

export const remotePolicyLabel = Match.type<RemotePolicyValue>().pipe(
  Match.when("Remote", () => "Fully remote"),
  Match.when("RemoteInRegion", () => "Remote within a region"),
  Match.when("Hybrid", () => "Hybrid"),
  Match.when("Onsite", () => "On-site"),
  Match.exhaustive
);

export const thousands = (amount: number) =>
  `${Math.round(amount / 100) / 10}k`;

export const bandLabel = (band: SalaryBandValue) =>
  band.min === band.max
    ? `${band.currency} ${thousands(band.max)}`
    : `${band.currency} ${thousands(band.min)} to ${thousands(band.max)}`;

export const teamSizeLabel = (size: number) =>
  size === 1 ? "1 person" : `${size} people`;

export const handsOnLabel = Match.type<HandsOnValue>().pipe(
  Match.when("None", () => "Not expected"),
  Match.when("Some", () => "Part of the job"),
  Match.when("Significant", () => "A large part of the job"),
  Match.exhaustive
);

export const regionGroupChip = Match.type<RegionGroupValue>().pipe(
  Match.when("RemoteCanada", () => "remote in Canada"),
  Match.when("RemoteUnitedStates", () => "remote in the US"),
  Match.when("BritishColumbia", () => "in Vancouver and BC"),
  Match.when("CanadaOnsite", () => "elsewhere in Canada"),
  Match.when("UnitedStatesOnsite", () => "on-site in the US"),
  Match.when("Elsewhere", () => "anywhere else"),
  Match.exhaustive
);

export const roleHubTitle = ({
  place,
  role,
}: {
  readonly place: RegionGroupValue;
  readonly role: RoleLevelValue;
}) => `${roleLabel(role)} roles ${regionGroupChip(place)}`;

export const regionLabel = Match.type<RegionValue>().pipe(
  Match.when("RemoteCanada", () => "Remote, Canada"),
  Match.when("RemoteNorthAmerica", () => "Remote, US or Canada"),
  Match.when("RemoteUnitedStates", () => "Remote, US"),
  Match.when("RemoteGlobal", () => "Remote, region not stated"),
  Match.when("BritishColumbia", () => "British Columbia"),
  Match.when("CanadaOnsite", () => "Canada"),
  Match.when("UnitedStatesOnsite", () => "United States"),
  Match.when("Elsewhere", () => "Outside North America"),
  Match.exhaustive
);

export const ageChip = Match.type<AgeWindowValue>().pipe(
  Match.when(1, () => "day"),
  Match.when(3, () => "3 days"),
  Match.when(7, () => "week"),
  Match.when(14, () => "2 weeks"),
  Match.when(30, () => "month"),
  Match.when(3650, () => "10 years"),
  Match.exhaustive
);

export const sourceLabel = Match.type<SourceNameValue>().pipe(
  Match.when("Greenhouse", () => "the company's Greenhouse board"),
  Match.when("Lever", () => "the company's Lever board"),
  Match.when("Ashby", () => "the company's Ashby board"),
  Match.when("Workable", () => "the company's Workable board"),
  Match.when("SmartRecruiters", () => "the company's SmartRecruiters board"),
  Match.when("RemoteOK", () => "Remote OK"),
  Match.when("Remotive", () => "Remotive"),
  Match.when("Himalayas", () => "Himalayas"),
  Match.when("Jobicy", () => "Jobicy"),
  Match.when("HackerNews", () => "Hacker News: Who is hiring?"),
  Match.exhaustive
);

const DAY = 86_400_000;

const MINUTE = 60_000;

export const daysAgo = (now: number, at: number) =>
  Math.max(0, Math.floor((now - at) / DAY));

export const postedAgo = (now: number, at: number) => {
  const days = daysAgo(now, at);

  if (days === 0) {
    return "Today";
  }

  if (days === 1) {
    return "Yesterday";
  }

  return `${days} days ago`;
};

export const postedShort = (now: number, at: number) => {
  const days = daysAgo(now, at);

  return days === 0 ? "Today" : `${days}d ago`;
};

export const statusLabel = Match.type<ListingStatusValue>().pipe(
  Match.when("new", () => "New"),
  Match.when("boarding", () => "Boarding"),
  Match.when("on_time", () => "On time"),
  Match.when("departed", () => "Departed"),
  Match.exhaustive
);

export const refreshedAgo = (now: number, at: number) => {
  const minutes = Math.max(0, Math.round((now - at) / MINUTE));

  if (minutes < 2) {
    return "just now";
  }

  if (minutes < 90) {
    return `${minutes} minutes ago`;
  }

  return `${Math.round(minutes / 60)} hours ago`;
};

export const dayHeading = (now: number, at: number) => {
  const days = daysAgo(now, at);

  if (days === 0) {
    return "Posted today";
  }

  if (days === 1) {
    return "Posted yesterday";
  }

  if (days < 7) {
    return "Earlier this week";
  }

  if (days < 14) {
    return "Last week";
  }

  return days <= 30 ? "Earlier this month" : "Over a month ago";
};

export const roleCount = (count: number) =>
  count === 1 ? "1 role matches" : `${count} roles match`;
