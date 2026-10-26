import { Match } from "effect";

import type { ArrangementValue, RegionValue } from "./job.js";

export interface PlaceEvidence {
  readonly country?: string | undefined;
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
  /\b(?:canada|canadian|toronto|montr[eé]al|ottawa|calgary|edmonton|waterloo|kitchener|winnipeg|halifax|quebec|qu[eé]bec|ontario|alberta|manitoba|saskatchewan|nova scotia|new brunswick|regina|saskatoon|victoria|mississauga|markham|gatineau|newfoundland|labrador|prince edward island|charlottetown|fredericton|moncton|yukon|whitehorse|northwest territories|yellowknife|nunavut|iqaluit)\b|,\s*(?:bc|on|qc|ab|mb|sk|ns|nb|nl|pe|yt|nt|nu)\b/iu;

const unitedStatesWords =
  /\b(?:united states|usa|us|u\.s\.a?\.?|america|new york|nyc|san francisco|sf|bay area|seattle|austin|boston|chicago|los angeles|denver|atlanta|miami|dallas|houston|portland|phoenix|philadelphia|washington,?\s+d\.?c\.?|san jose|san diego|palo alto|mountain view|menlo park|sunnyvale|brooklyn|pittsburgh|minneapolis|salt lake city|raleigh|nashville|detroit|columbus|charlotte|alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|wisconsin|wyoming)\b|,\s*(?:al|ak|az|ar|ca|co|ct|de|fl|ga|hi|id|il|in|ia|ks|ky|la|me|md|ma|mi|mn|ms|mo|mt|ne|nv|nh|nj|nm|ny|nc|nd|oh|ok|or|pa|ri|sc|sd|tn|tx|ut|vt|va|wa|wv|wi|wy|dc)\b/iu;

const foreignPlaces = [
  "europe",
  "european union",
  "eu",
  "emea",
  "apac",
  "asia",
  "asia pacific",
  "oceania",
  "africa",
  "middle east",
  "mena",
  "latam",
  "latin america",
  "south america",
  "central america",
  "caribbean",
  "nordics",
  "scandinavia",
  "baltics",
  "balkans",
  "cet",
  "cest",
  "eet",
  "eest",
  "bst",
  "ist",
  "aest",
  "aedt",
  "jst",
  "sgt",
  "afghanistan",
  "albania",
  "algeria",
  "andorra",
  "angola",
  "antigua",
  "argentina",
  "armenia",
  "australia",
  "austria",
  "azerbaijan",
  "bahamas",
  "bahrain",
  "bangladesh",
  "barbados",
  "belarus",
  "belgium",
  "belize",
  "benin",
  "bhutan",
  "bolivia",
  "bosnia",
  "herzegovina",
  "botswana",
  "brazil",
  "brunei",
  "bulgaria",
  "burkina faso",
  "burundi",
  "cabo verde",
  "cape verde",
  "cambodia",
  "cameroon",
  "central african republic",
  "chad",
  "chile",
  "china",
  "colombia",
  "comoros",
  "congo",
  "costa rica",
  "c[oô]te d'ivoire",
  "ivory coast",
  "croatia",
  "cuba",
  "cyprus",
  "czechia",
  "czech republic",
  "denmark",
  "djibouti",
  "dominica",
  "dominican republic",
  "ecuador",
  "egypt",
  "el salvador",
  "equatorial guinea",
  "eritrea",
  "estonia",
  "eswatini",
  "ethiopia",
  "fiji",
  "finland",
  "france",
  "gabon",
  "gambia",
  "germany",
  "ghana",
  "greece",
  "grenada",
  "guatemala",
  "guinea",
  "guinea-bissau",
  "guyana",
  "haiti",
  "honduras",
  "hong kong",
  "hungary",
  "iceland",
  "india",
  "indonesia",
  "iran",
  "iraq",
  "ireland",
  "israel",
  "italy",
  "jamaica",
  "japan",
  "jordan",
  "kazakhstan",
  "kenya",
  "kiribati",
  "korea",
  "kosovo",
  "kuwait",
  "kyrgyzstan",
  "laos",
  "latvia",
  "lebanon",
  "lesotho",
  "liberia",
  "libya",
  "liechtenstein",
  "lithuania",
  "luxembourg",
  "macau",
  "madagascar",
  "malawi",
  "malaysia",
  "maldives",
  "mali",
  "malta",
  "marshall islands",
  "mauritania",
  "mauritius",
  "mexico",
  "micronesia",
  "moldova",
  "monaco",
  "mongolia",
  "montenegro",
  "morocco",
  "mozambique",
  "myanmar",
  "namibia",
  "nauru",
  "nepal",
  "netherlands",
  "holland",
  "new zealand",
  "nicaragua",
  "niger",
  "nigeria",
  "north macedonia",
  "macedonia",
  "norway",
  "oman",
  "pakistan",
  "palau",
  "palestine",
  "panama",
  "papua new guinea",
  "paraguay",
  "peru",
  "philippines",
  "poland",
  "portugal",
  "qatar",
  "romania",
  "russia",
  "rwanda",
  "saint lucia",
  "samoa",
  "san marino",
  "saudi arabia",
  "senegal",
  "serbia",
  "seychelles",
  "sierra leone",
  "singapore",
  "slovakia",
  "slovenia",
  "solomon islands",
  "somalia",
  "south africa",
  "south sudan",
  "spain",
  "sri lanka",
  "sudan",
  "suriname",
  "sweden",
  "switzerland",
  "syria",
  "taiwan",
  "tajikistan",
  "tanzania",
  "thailand",
  "timor-leste",
  "togo",
  "tonga",
  "trinidad",
  "tunisia",
  "turkey",
  "t[uü]rkiye",
  "turkmenistan",
  "tuvalu",
  "uganda",
  "ukraine",
  "united arab emirates",
  "uae",
  "united kingdom",
  "uk",
  "u\\.k\\.",
  "great britain",
  "england",
  "scotland",
  "wales",
  "northern ireland",
  "uruguay",
  "uzbekistan",
  "vanuatu",
  "venezuela",
  "vietnam",
  "viet nam",
  "yemen",
  "zambia",
  "zimbabwe",
  "nz",
  "london",
  "edinburgh",
  "glasgow",
  "belfast",
  "dublin",
  "paris",
  "berlin",
  "munich",
  "hamburg",
  "frankfurt",
  "cologne",
  "amsterdam",
  "rotterdam",
  "brussels",
  "zurich",
  "z[uü]rich",
  "geneva",
  "madrid",
  "barcelona",
  "lisbon",
  "porto",
  "milan",
  "rome",
  "stockholm",
  "copenhagen",
  "oslo",
  "helsinki",
  "reykjavik",
  "tallinn",
  "riga",
  "vilnius",
  "kaunas",
  "warsaw",
  "krak[oó]w",
  "wroc[lł]aw",
  "prague",
  "budapest",
  "bucharest",
  "sofia",
  "belgrade",
  "zagreb",
  "kyiv",
  "kiev",
  "istanbul",
  "tel aviv",
  "dubai",
  "abu dhabi",
  "cairo",
  "lagos",
  "nairobi",
  "accra",
  "cape town",
  "johannesburg",
  "bangalore",
  "bengaluru",
  "hyderabad",
  "pune",
  "chennai",
  "mumbai",
  "delhi",
  "gurgaon",
  "gurugram",
  "noida",
  "karachi",
  "lahore",
  "dhaka",
  "colombo",
  "tokyo",
  "osaka",
  "seoul",
  "beijing",
  "shanghai",
  "shenzhen",
  "taipei",
  "manila",
  "jakarta",
  "kuala lumpur",
  "bangkok",
  "hanoi",
  "ho chi minh",
  "sydney",
  "melbourne",
  "brisbane",
  "auckland",
  "wellington",
  "s[aã]o paulo",
  "rio de janeiro",
  "buenos aires",
  "bogot[aá]",
  "medell[ií]n",
  "montevideo",
  "valletta",
];

const foreignWords = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${foreignPlaces.join("|")})(?![\\p{L}\\p{N}])`,
  "iu"
);

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

const countrySignals = (evidence: PlaceEvidence): Signals => {
  const signals = signalsOf(evidence.text);

  if (
    evidence.country === undefined ||
    signals.global ||
    signals.northAmerica ||
    (signals.canada && signals.unitedStates) ||
    (signals.foreign && (signals.canada || signals.unitedStates))
  ) {
    return signals;
  }

  return {
    ...signals,
    britishColumbia: evidence.country === "CA" && signals.britishColumbia,
    canada: evidence.country === "CA",
    foreign: evidence.country !== "CA" && evidence.country !== "US",
    unitedStates: evidence.country === "US",
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
  const signals = countrySignals(evidence);

  return Match.value(arrangement).pipe(
    Match.withReturnType<Placement>(),
    Match.when("Remote", () => ({
      arrangement,
      region: remoteRegion(signals),
    })),
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
