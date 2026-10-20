import { Context, Predicate } from "effect";

import { SourceName } from "./job.js";
import type { SourceNameValue } from "./job.js";
import { SourceTerms } from "./source-terms.js";
import type { SourceTermsValue } from "./source-terms.js";

export const agentAccessAllowed = (
  source: SourceNameValue,
  terms: Readonly<Record<SourceNameValue, SourceTermsValue>> = SourceTerms
) => !Predicate.isTagged(terms[source].agentAccess, "Forbidden");

export const agentSources = (
  terms: Readonly<Record<SourceNameValue, SourceTermsValue>> = SourceTerms
): readonly SourceNameValue[] =>
  SourceName.literals.filter((source) => agentAccessAllowed(source, terms));

export const ServedSources = Context.Reference<readonly SourceNameValue[]>(
  "@rat-stack/core/ServedSources",
  { defaultValue: () => SourceName.literals }
);
