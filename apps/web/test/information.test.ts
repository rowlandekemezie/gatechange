import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { fromString } from "foldkit/url";

import indexHtml from "../index.html?raw";
import { Preload } from "../src/client/board/model.js";
import {
  canonicalPathOf,
  InformationPage,
  informationRouter,
  Route,
  routeOfUrl,
} from "../src/client/route.js";
import { informationMeta } from "../src/features/information/view.js";
import { renderPage } from "../src/server/render.js";

const ORIGIN = "https://jobs.example";

describe("public information", () => {
  it.each(InformationPage.literals)(
    "%s has a typed canonical route",
    (page) => {
      const path = informationRouter(page);

      const route = routeOfUrl(
        Option.getOrThrow(fromString(`${ORIGIN}${path}`))
      );

      expect(route).toEqual(Route.Information({ page }));
      expect(canonicalPathOf(route)).toEqual(Option.some(path));
    }
  );

  for (const page of InformationPage.literals) {
    it.effect(
      `${page} is readable public HTML with contact and navigation`,
      () =>
        Effect.gen(function* renderInformation() {
          const path = informationRouter(page);

          const rendered = yield* renderPage(
            indexHtml,
            new URL(path, ORIGIN),
            Route.Information({ page }),
            Preload.Nothing()
          );

          expect(rendered.status).toBe(200);
          expect(rendered.html).toContain(informationMeta(page).title);
          expect(rendered.html.match(/<h1[\s>]/gu)).toHaveLength(1);
          expect(rendered.html).toContain(
            `rel="canonical" href="${ORIGIN}${path}"`
          );
          expect(rendered.html).toContain("mailto:hello@rowlandekemezie.com");
          expect(rendered.html).toContain('href="/privacy"');
          expect(rendered.html).toContain('href="/contact"');

          if (page === "Contact") {
            expect(rendered.html).toContain("manual support request");
            expect(rendered.html).toContain("separate operations");
            expect(rendered.html).not.toContain("account has been deleted");
          }
        })
    );
  }
});
