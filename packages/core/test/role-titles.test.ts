import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";

import { classifyRole } from "../src/index.js";
import {
  hardwareTitles,
  knownFalsePositives,
  knownMisses,
  otherFunctionTitles,
  realTitles,
} from "./role-title-cases.js";

describe("role classification on the labelled titles", () => {
  it.each(realTitles)("%s stays %s", (title, role) => {
    expect(classifyRole(title)).toStrictEqual(Option.some(role));
  });

  it.each(hardwareTitles)("%s stays %s", (title, role) => {
    expect(classifyRole(title)).toStrictEqual(Option.some(role));
  });

  it.each(otherFunctionTitles)("%s is %s, not leadership", (title) => {
    expect(classifyRole(title)).toStrictEqual(Option.none());
  });

  it.each(knownFalsePositives)("%s still reads as %s", (title, role) => {
    expect(classifyRole(title)).toStrictEqual(Option.some(role));
  });

  it.each(knownMisses)("%s is still missed", (title) => {
    expect(classifyRole(title)).toStrictEqual(Option.none());
  });
});
