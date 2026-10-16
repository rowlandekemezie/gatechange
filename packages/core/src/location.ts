import { Match } from "effect";

import type { ArrangementValue, RegionValue } from "./job.js";

export interface PlaceEvidence {
  readonly text: string;
  readonly workplace: ArrangementValue;
}

export interface Placement {
  readonly arrangement: ArrangementValue;
  readonly region: RegionValue;
}

const remoteWords =
  /\b(?:remote|anywhere|distributed|work from home|wfh|telecommut\w*|fully[\s-]remote)\b/iu;

const hybridWords = /\bhybrid\b/iu;

const onsiteWords = /\b(?:on[\s-]?site|in[\s-]office|in[\s-]person)\b/iu;

const globalWords = /\b(?:anywhere|worldwide|global(?:ly)?|world)\b/iu;

const northAmericaWords = /\b(?:north america|americas|amer|n\.?\s?a\.?)\b/iu;

const britishColumbiaWords =
  /\b(?:vancouver|british columbia|b\.c\.|bc|victoria,?\s+(?:bc|b\.c\.|british columbia)|burnaby|surrey,?\s+bc|richmond,?\s+bc|kelowna|squamish|north vancouver|coquitlam)\b/iu;

const canadaWords =
  /\b(?:canada|canadian|toronto|montr[eé]al|ottawa|calgary|edmonton|waterloo|kitchener|winnipeg|halifax|quebec|qu[eé]bec|ontario|alberta|manitoba|saskatchewan|nova scotia|new brunswick|regina|saskatoon|victoria|mississauga|markham|gatineau)\b|,\s*(?:bc|on|qc|ab|mb|sk|ns|nb)\b/iu;

const unitedStatesWords =
  /\b(?:united states|usa|us|u\.s\.a?\.?|america|new york|nyc|san francisco|sf|bay area|seattle|austin|boston|chicago|los angeles|denver|atlanta|miami|dallas|houston|portland|phoenix|philadelphia|washington,?\s+d\.?c\.?|san jose|san diego|palo alto|mountain view|menlo park|sunnyvale|brooklyn|pittsburgh|minneapolis|salt lake city|raleigh|nashville|detroit|columbus|charlotte|alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|wisconsin|wyoming)\b|,\s*(?:al|ak|az|ar|ca|co|ct|de|fl|ga|hi|id|il|in|ia|ks|ky|la|me|md|ma|mi|mn|ms|mo|mt|ne|nv|nh|nj|nm|ny|nc|nd|oh|ok|or|pa|ri|sc|sd|tn|tx|ut|vt|va|wa|wv|wi|wy|dc)\b/iu;

const foreignWords =
  /\b(?:europe|emea|uk|united kingdom|london|germany|berlin|france|paris|spain|portugal|netherlands|amsterdam|ireland|dublin|poland|india|bangalore|bengaluru|singapore|australia|sydney|japan|tokyo|brazil|latam|latin america|mexico|argentina|colombia|israel|apac|asia|africa|nigeria|lagos|philippines|new zealand|sweden|switzerland|italy|romania|ukraine)\b/iu;

const arrangementOf = (evidence: PlaceEvidence): ArrangementValue => {
  if (evidence.workplace !== "Unspecified") {
    return evidence.workplace;
  }

  if (remoteWords.test(evidence.text)) {
    return "Remote";
  }

  if (hybridWords.test(evidence.text)) {
    return "Hybrid";
  }

  if (onsiteWords.test(evidence.text)) {
    return "Onsite";
  }

  return "Unspecified";
};

interface Signals {
  readonly britishColumbia: boolean;
  readonly canada: boolean;
  readonly foreign: boolean;
  readonly global: boolean;
  readonly northAmerica: boolean;
  readonly unitedStates: boolean;
}

const signalsOf = (text: string): Signals => {
  const britishColumbia = britishColumbiaWords.test(text);

  return {
    britishColumbia,
    canada: britishColumbia || canadaWords.test(text),
    foreign: foreignWords.test(text),
    global: globalWords.test(text),
    northAmerica: northAmericaWords.test(text),
    unitedStates: unitedStatesWords.test(text),
  };
};

const remoteRegion = (signals: Signals): RegionValue => {
  if (signals.northAmerica || (signals.canada && signals.unitedStates)) {
    return "RemoteNorthAmerica";
  }

  if (signals.canada) {
    return "RemoteCanada";
  }

  if (signals.unitedStates) {
    return "RemoteUnitedStates";
  }

  if (signals.global || !signals.foreign) {
    return "RemoteGlobal";
  }

  return "Elsewhere";
};

const placedRegion = (signals: Signals): RegionValue => {
  if (signals.britishColumbia) {
    return "BritishColumbia";
  }

  if (signals.canada) {
    return "CanadaOnsite";
  }

  if (signals.unitedStates) {
    return "UnitedStatesOnsite";
  }

  return "Elsewhere";
};

export const classifyPlacement = (evidence: PlaceEvidence): Placement => {
  const arrangement = arrangementOf(evidence);
  const signals = signalsOf(evidence.text);

  return Match.value(arrangement).pipe(
    Match.withReturnType<Placement>(),
    Match.when("Remote", () => ({ arrangement, region: remoteRegion(signals) })),
    Match.orElse(() => ({ arrangement, region: placedRegion(signals) }))
  );
};

export const regionWeight = Match.type<RegionValue>().pipe(
  Match.when("RemoteCanada", () => 12),
  Match.when("RemoteNorthAmerica", () => 11),
  Match.when("BritishColumbia", () => 11),
  Match.when("RemoteUnitedStates", () => 9),
  Match.when("RemoteGlobal", () => 9),
  Match.when("CanadaOnsite", () => 5),
  Match.when("UnitedStatesOnsite", () => 3),
  Match.when("Elsewhere", () => 0),
  Match.exhaustive
);
