import { describe, expect, it } from "@effect/vitest";
import { AccountId, MAX_DIGEST_JOBS } from "@rat-stack/core";
import type { Digest, JobValue } from "@rat-stack/core";
import { Array, Effect, Option, Redacted } from "effect";

import {
  makeDigestMailer,
  unsubscribePage,
  unsubscribeToken,
  verifyUnsubscribeToken,
} from "../src/index.js";
import type { DigestEmail, SendFailure } from "../src/index.js";

const SECRET = Redacted.make("a".repeat(32));

const OTHER_SECRET = Redacted.make("b".repeat(32));

const ORIGIN = "https://jobs.rowlandekemezie.com";

const ada = AccountId.make("user_ada");

const job = (id: string, overrides: Partial<JobValue> = {}): JobValue => ({
  arrangement: "Remote",
  company: "Acme",
  feed: "greenhouse:acme",
  firstSeenAt: 0,
  id,
  lastSeenAt: 0,
  location: "Remote - Canada",
  postedAt: 0,
  region: "RemoteCanada",
  relevance: 50,
  role: "EngineeringManager",
  salary: null,
  source: "Greenhouse",
  title: "Engineering Manager",
  url: "https://boards.greenhouse.io/acme/1",
  ...overrides,
});

const digest = (
  jobs: readonly JobValue[],
  total = jobs.length,
  cadence: Digest["cadence"] = "Weekly"
): Digest => ({
  account: ada,
  cadence,
  jobs,
  periodStart: 0,
  to: "ada@example.com",
  total,
});

const capture = (outcome: Effect.Effect<unknown, SendFailure>) => {
  const sent: DigestEmail[] = [];

  const mailer = makeDigestMailer({
    secret: SECRET,
    send: (email) =>
      Effect.sync(() => sent.push(email)).pipe(Effect.andThen(outcome)),
    sender: "digest@jobs.rowlandekemezie.com",
    siteOrigin: ORIGIN,
  });

  return { mailer, sent };
};

const tokenIn = (url: string) => new URL(url).searchParams.get("token") ?? "";

const failingSend = (code: string) =>
  capture(
    Effect.fail({
      cause: Object.assign(new Error("refused"), { code }),
      message: "refused",
    })
  ).mailer.send(digest([job("x")]));

describe("digest email", () => {
  it.effect(
    "links every role to its job page on the board and carries one-click unsubscribe headers",
    () =>
      Effect.gen(function* links() {
        const { mailer, sent } = capture(Effect.void);

        yield* mailer.send(
          digest([job("greenhouse:acme:1"), job("lever:acme:2")])
        );

        const [email] = sent;

        const unsubscribe = /^<(?<url>https:\/\/[^>]+)>$/u.exec(
          email?.headers["List-Unsubscribe"] ?? ""
        )?.groups?.url;

        expect(email?.headers["List-Unsubscribe-Post"]).toBe(
          "List-Unsubscribe=One-Click"
        );
        expect(unsubscribe?.startsWith(`${ORIGIN}/unsubscribe?token=`)).toBe(
          true
        );
        expect(
          Array.fromIterable(
            email?.html.matchAll(/href="(?<href>[^"]+\/jobs\/[^"]+)"/gu) ?? []
          ).map((match) => match.groups?.href)
        ).toEqual([
          `${ORIGIN}/jobs/Z3JlZW5ob3VzZTphY21lOjE`,
          `${ORIGIN}/jobs/bGV2ZXI6YWNtZToy`,
        ]);
        expect(email?.text).toContain(`${ORIGIN}/jobs/bGV2ZXI6YWNtZToy`);
        expect(email?.text).toContain(unsubscribe);
        expect(
          yield* verifyUnsubscribeToken(SECRET, tokenIn(unsubscribe ?? ORIGIN))
        ).toEqual(Option.some(ada));
      })
  );

  it.effect(
    "never links a listing's own apply URL, whatever the feed sent",
    () =>
      Effect.gen(function* applyUrls() {
        const { mailer, sent } = capture(Effect.void);

        yield* mailer.send(
          digest([
            job("a", { url: `${ORIGIN}/api/auth/magic-link/verify?token=x` }),
            job("b", { url: "/jobs/relative" }),
            job("c", { url: "https://boards.greenhouse.io/acme/3" }),
          ])
        );

        const links = Array.fromIterable(
          sent[0]?.html.matchAll(/href="(?<href>[^"]+)"/gu) ?? []
        ).map((match) => match.groups?.href ?? "");

        expect(links.filter((href) => !href.startsWith(`${ORIGIN}/`))).toEqual(
          []
        );
        expect(sent[0]?.html).not.toContain("magic-link/verify");
        expect(sent[0]?.html).not.toContain("boards.greenhouse.io");
        expect(sent[0]?.text).not.toContain("magic-link/verify");
        expect(sent[0]?.text).not.toContain("boards.greenhouse.io");
      })
  );

  it.effect("escapes listing text that came from a feed", () =>
    Effect.gen(function* escaped() {
      const { mailer, sent } = capture(Effect.void);

      yield* mailer.send(
        digest([
          job("x", {
            company: `"><script>alert(1)</script>`,
            title: "<img src=x onerror=alert(1)>",
          }),
        ])
      );

      expect(sent[0]?.html).not.toMatch(/<script|<img/u);
      expect(sent[0]?.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    })
  );

  it.effect("says how many roles it left out when there are more", () =>
    Effect.gen(function* more() {
      const { mailer, sent } = capture(Effect.void);

      yield* mailer.send(
        digest(
          Array.makeBy(MAX_DIGEST_JOBS, (index) => job(`id-${index}`)),
          MAX_DIGEST_JOBS + 7
        )
      );

      expect(sent[0]?.subject).toBe(
        `${MAX_DIGEST_JOBS + 7} new engineering leadership roles for your saved searches`
      );
      expect(sent[0]?.text).toContain(
        `Showing the newest ${MAX_DIGEST_JOBS} of ${MAX_DIGEST_JOBS + 7}.`
      );
    })
  );

  it.effect(
    "names the first new role and says why an instant alert arrived",
    () =>
      Effect.gen(function* instant() {
        const { mailer, sent } = capture(Effect.void);

        yield* mailer.send(digest([job("first"), job("second")], 2, "Instant"));

        expect(sent[0]?.subject).toBe(
          "New match: Engineering Manager and 1 more"
        );
        expect(sent[0]?.text).toContain(
          "You get this within 20 minutes of a new match because you turned on instant alerts for your saved searches."
        );
        expect(sent[0]?.text).not.toContain("You get this weekly");
      })
  );

  it.effect(
    "does not infer a refundable refusal from an uncertain error message",
    () =>
      Effect.gen(function* uncertain() {
        const failure = yield* Effect.flip(
          capture(
            Effect.fail({
              message:
                "connection failed after E_DAILY_LIMIT_EXCEEDED appeared in diagnostics",
            })
          ).mailer.send(digest([job("x")]))
        );

        expect(failure.quotaExhausted).toBe(false);
      })
  );

  it.effect.each<readonly [string, boolean]>([
    ["E_DAILY_LIMIT_EXCEEDED", true],
    ["E_RECIPIENT_SUPPRESSED", false],
    ["recipient.privacy@example.com", false],
  ])(
    "does not expose provider messages or arbitrary codes for %s",
    ([code, quotaExhausted]) =>
      Effect.gen(function* safeDiagnostic() {
        const failure = yield* capture(
          Effect.fail({
            cause: { code },
            message:
              "Delivery to recipient.privacy@example.com failed; token=private-provider-detail",
          })
        )
          .mailer.send(digest([job("privacy")]))
          .pipe(Effect.flip);

        expect(failure.quotaExhausted).toBe(quotaExhausted);
        expect(failure.message).not.toContain("recipient.privacy@example.com");
        expect(failure.message).not.toContain("private-provider-detail");
        expect(failure.message).not.toContain("token=");
      })
  );

  it.effect("reports quota errors from Email Sending so the run can stop", () =>
    Effect.gen(function* quota() {
      const daily = yield* Effect.flip(failingSend("E_DAILY_LIMIT_EXCEEDED"));

      const suppressed = yield* Effect.flip(
        failingSend("E_RECIPIENT_SUPPRESSED")
      );

      expect([daily.quotaExhausted, suppressed.quotaExhausted]).toEqual([
        true,
        false,
      ]);
      expect(daily.message).toContain("E_DAILY_LIMIT_EXCEEDED");
    })
  );
});

describe("unsubscribe token", () => {
  it.effect("needs no login and identifies only its own account", () =>
    Effect.gen(function* roundTrip() {
      const token = yield* unsubscribeToken(SECRET, ada);
      const [version = "", account = "", signature = ""] = token.split(".");
      const bob = yield* unsubscribeToken(SECRET, AccountId.make("user_bob"));
      const [, bobAccount = ""] = bob.split(".");

      expect(yield* verifyUnsubscribeToken(SECRET, token)).toEqual(
        Option.some(ada)
      );
      expect(yield* verifyUnsubscribeToken(OTHER_SECRET, token)).toEqual(
        Option.none()
      );
      expect(
        yield* verifyUnsubscribeToken(
          SECRET,
          `${version}.${bobAccount}.${signature}`
        )
      ).toEqual(Option.none());
      expect(
        yield* Effect.forEach(
          [
            "",
            account,
            `${account}.`,
            `${token}.x`,
            "!!.??",
            `${account}.AAAA`,
          ],
          (candidate) => verifyUnsubscribeToken(SECRET, candidate)
        )
      ).toEqual(Array.makeBy(6, () => Option.none()));
    })
  );
});

describe("unsubscribe token revocation", () => {
  it.effect(
    "changing the token version revokes earlier links with the same auth secret",
    () =>
      Effect.gen(function* revoked() {
        const legacy =
          "dXNlcl9hZGE.Qd27NDlQKl1-TUUhdYPw4pZ06c5iq0tAe2biMYQLKN4";

        const old = yield* unsubscribeToken(SECRET, ada, "1");
        const current = yield* unsubscribeToken(SECRET, ada, "2");

        expect(yield* verifyUnsubscribeToken(SECRET, legacy)).toEqual(
          Option.some(ada)
        );
        expect(yield* verifyUnsubscribeToken(SECRET, legacy, "2")).toEqual(
          Option.none()
        );
        expect(yield* verifyUnsubscribeToken(SECRET, old, "2")).toEqual(
          Option.none()
        );
        expect(yield* verifyUnsubscribeToken(SECRET, current, "2")).toEqual(
          Option.some(ada)
        );
        expect(
          yield* verifyUnsubscribeToken(SECRET, old.replace(/^1/u, "2"), "2")
        ).toEqual(Option.none());
      })
  );
});

describe("unsubscribe page", () => {
  it("asks before unsubscribing and escapes the token it echoes", () => {
    const confirm = unsubscribePage("Confirm", `x"><script>`);

    expect(confirm.status).toBe(200);
    expect(confirm.html).toContain('method="post"');
    expect(confirm.html).not.toContain("<script>");
    expect(unsubscribePage("Invalid", "").status).toBe(400);
    expect(unsubscribePage("Unavailable", "").status).toBe(503);
  });
});
