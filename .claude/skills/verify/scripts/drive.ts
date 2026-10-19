// @effect-diagnostics nodeBuiltinImport:off asyncFunction:off globalDate:off globalFetch:off -- drive.ts is standalone Node tooling that drives Chrome over the DevTools protocol, outside any Effect runtime.
import { spawn } from "node:child_process";
import { randomInt } from "node:crypto";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

import { Schema } from "effect";

const { values } = parseArgs({
  options: {
    dark: { default: false, type: "boolean" },
    email: { default: "verify@example.com", type: "string" },
    "full-page": { default: false, type: "boolean" },
    "min-rows": { default: "20", type: "string" },
    mobile: { default: false, type: "boolean" },
    name: { type: "string" },
    out: { type: "string" },
    scenario: { default: "board", type: "string" },
    "timeout-ms": { default: "45000", type: "string" },
    url: { type: "string" },
  },
});

const scenarios = [
  "board",
  "filter",
  "search",
  "shortlist",
  "signin",
  "bad-email",
  "signout",
  "link-reuse",
] as const;

type Scenario = (typeof scenarios)[number];

const fail = (message: string): never => {
  process.stderr.write(`drive: ${message}\n`);
  process.exit(2);
};

const url = values.url ?? fail("--url is required");

const out = values.out ?? fail("--out is required");

const scenario =
  scenarios.find((candidate) => candidate === values.scenario) ??
  fail(`--scenario must be one of ${scenarios.join(", ")}`);

const minRows = Number(values["min-rows"]);

const deadline = Date.now() + Number(values["timeout-ms"]);

const name =
  values.name ??
  `${scenario}${values.mobile ? "-mobile" : ""}${values.dark ? "-dark" : ""}`;

const viewport = values.mobile
  ? { deviceScaleFactor: 3, height: 844, mobile: true, width: 390 }
  : { deviceScaleFactor: 1, height: 900, mobile: false, width: 1280 };

const chromePath =
  [
    process.env.CHROME,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].find((candidate) => candidate !== undefined && existsSync(candidate)) ??
  fail("no Chrome found; set CHROME to its binary");

const profile = mkdtempSync(path.join(tmpdir(), "verify-jobs-chrome-"));

const chrome = spawn(
  chromePath,
  [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-scrollbars",
    "about:blank",
  ],
  { stdio: "ignore" }
);

const shutdown = async () => {
  const exited = once(chrome, "exit");

  chrome.kill("SIGKILL");
  await Promise.race([exited, sleep(3000)]);
  rmSync(profile, {
    force: true,
    maxRetries: 5,
    recursive: true,
    retryDelay: 200,
  });
};

const waitFor = async <A>(
  label: string,
  probe: () => Promise<A | undefined>
): Promise<A> => {
  const found = await probe();

  if (found !== undefined) {
    return found;
  }

  if (Date.now() >= deadline) {
    throw new Error(`timed out waiting for ${label}`);
  }

  await sleep(150);

  return await waitFor(label, probe);
};

const devtoolsPort = await waitFor("Chrome DevTools port", async () => {
  const file = path.join(profile, "DevToolsActivePort");

  return await Promise.resolve(
    existsSync(file) ? readFileSync(file, "utf-8").split("\n")[0] : undefined
  );
});

const NewTarget = Schema.Struct({ webSocketDebuggerUrl: Schema.String });

const newTarget = await fetch(
  `http://127.0.0.1:${devtoolsPort}/json/new?about:blank`,
  {
    method: "PUT",
  }
);

const target = Schema.decodeUnknownSync(NewTarget)(await newTarget.json());

const socket = new WebSocket(target.webSocketDebuggerUrl);

const settlesAs = async <A>(pending: Promise<unknown>, value: A) => {
  await pending;

  return value;
};

const opened = await Promise.race([
  settlesAs(once(socket, "open"), true),
  settlesAs(once(socket, "close"), false),
]);

if (!opened) {
  fail("Chrome refused the DevTools connection");
}

const Reply = Schema.Struct({
  error: Schema.optional(Schema.Struct({ message: Schema.String })),
  id: Schema.optional(Schema.Finite),
  result: Schema.optional(Schema.Unknown),
});

const received = new Map<string, typeof Reply.Type>();

const arrivals = new EventTarget();

const closed = settlesAs(once(socket, "close"), false);

const PausedRequest = Schema.Struct({
  method: Schema.Literal("Fetch.requestPaused"),
  params: Schema.Struct({
    request: Schema.Struct({
      headers: Schema.Record(Schema.String, Schema.String),
    }),
    requestId: Schema.String,
  }),
});

const isPausedRequest = Schema.is(PausedRequest);

const clientIp = `10.${[0, 0, 0].map(() => randomInt(1, 251)).join(".")}`;

socket.addEventListener("message", (event) => {
  const reply = Schema.decodeUnknownSync(Reply)(JSON.parse(String(event.data)));

  if (reply.id !== undefined) {
    received.set(String(reply.id), reply);
    arrivals.dispatchEvent(new Event(String(reply.id)));
  }
});

type CdpValue = boolean | number | string;

type CdpParams = Readonly<
  Record<
    string,
    | CdpValue
    | Readonly<Record<string, CdpValue>>
    | readonly Readonly<Record<string, CdpValue>>[]
  >
>;

let nextId = 0;

const send = async <S extends Schema.Decoder<unknown>>(
  schema: S,
  method: string,
  params: CdpParams = {}
): Promise<S["Type"]> => {
  nextId += 1;

  const id = String(nextId);
  const arrived = settlesAs(once(arrivals, id), true);

  socket.send(JSON.stringify({ id: nextId, method, params }));

  const answered = await Promise.race([arrived, closed]);
  const reply = received.get(id);

  received.delete(id);

  if (!answered || reply === undefined) {
    throw new Error(`Chrome closed the DevTools connection during ${method}`);
  }

  if (reply.error !== undefined) {
    throw new Error(`${method} failed: ${reply.error.message}`);
  }

  return Schema.decodeUnknownSync(schema)(reply.result);
};

const Ignored = Schema.Unknown;

const continueWithClientIp = async ({ params }: typeof PausedRequest.Type) => {
  await send(Ignored, "Fetch.continueRequest", {
    headers: [
      ...Object.entries(params.request.headers).map(([header, value]) => ({
        name: header,
        value,
      })),
      { name: "cf-connecting-ip", value: clientIp },
    ],
    requestId: params.requestId,
  });
};

socket.addEventListener("message", (event) => {
  const message: unknown = JSON.parse(String(event.data));

  if (isPausedRequest(message)) {
    void continueWithClientIp(message);
  }
});

const Evaluation = Schema.Struct({
  exceptionDetails: Schema.optional(Schema.Struct({ text: Schema.String })),
  result: Schema.Struct({ value: Schema.optional(Schema.Unknown) }),
});

const evaluate = async <S extends Schema.Decoder<unknown>>(
  schema: S,
  expression: string
): Promise<S["Type"]> => {
  const evaluation = await send(Evaluation, "Runtime.evaluate", {
    awaitPromise: true,
    expression,
    returnByValue: true,
  });

  if (evaluation.exceptionDetails !== undefined) {
    throw new Error(`page script failed: ${evaluation.exceptionDetails.text}`);
  }

  return Schema.decodeUnknownSync(schema)(evaluation.result.value);
};

const BoardState = Schema.Struct({
  count: Schema.String,
  error: Schema.String,
  rows: Schema.Finite,
  status: Schema.String,
});

type BoardStateValue = typeof BoardState.Type;

const boardState = async () =>
  await evaluate(
    BoardState,
    `({
    count: document.querySelector("p.count")?.textContent ?? "",
    error: document.querySelector(".empty[role=alert]")?.textContent ?? "",
    rows: document.querySelectorAll("li.job").length,
    status: document.querySelector(".status")?.textContent ?? "",
  })`
  );

const clickButton = async (selector: string, text: string) =>
  await evaluate(
    Schema.Boolean,
    `(() => {
    const button = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((node) => node.textContent.trim().startsWith(${JSON.stringify(text)}));
    button?.click();
    return button !== undefined;
  })()`
  );

const waitForRows = async (
  label: string,
  accept: (state: BoardStateValue) => boolean
) =>
  await waitFor(label, async () => {
    const state = await boardState();

    if (state.error.length > 0) {
      throw new Error(`board shows an error: ${state.error.trim()}`);
    }

    return accept(state) ? state : undefined;
  });

const LayoutMetrics = Schema.Struct({
  cssContentSize: Schema.Struct({
    height: Schema.Finite,
    width: Schema.Finite,
  }),
});

const Screenshot = Schema.Struct({ data: Schema.String });

const screenshot = async (slug: string) => {
  const metrics = await send(LayoutMetrics, "Page.getLayoutMetrics");

  const fullPageClip = {
    height: metrics.cssContentSize.height,
    scale: 1,
    width: viewport.width,
    x: 0,
    y: 0,
  };

  const { data } = await send(
    Screenshot,
    "Page.captureScreenshot",
    values["full-page"]
      ? { captureBeyondViewport: true, clip: fullPageClip, format: "png" }
      : { captureBeyondViewport: false, format: "png" }
  );

  const file = path.join(out, `${slug}.png`);

  writeFileSync(file, Buffer.from(data, "base64"));

  return file;
};

interface Step extends Partial<BoardStateValue> {
  readonly background?: string;
  readonly companies?: readonly string[];
  readonly email?: string;
  readonly header?: string;
  readonly heading?: string;
  readonly localStorageKeys?: number;
  readonly problem?: string;
  readonly sent?: string;
  readonly step: string;
  readonly titles?: readonly string[];
}

const mailOutbox = new URL(
  "../../../../apps/infra/.alchemy/local/email/text/",
  import.meta.url
).pathname;

const mailCount = () =>
  existsSync(mailOutbox) ? readdirSync(mailOutbox).length : 0;

const MAGIC_LINK = /https?:\/\/\S+\/account\/confirm\?token=\S+/u;

const latestLink = () => {
  const [newest] = readdirSync(mailOutbox)
    .map((file) => path.join(mailOutbox, file))
    .toSorted((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);

  const [link] = MAGIC_LINK.exec(readFileSync(newest ?? "", "utf-8")) ?? [];

  return link ?? fail(`no magic link in ${newest ?? mailOutbox}`);
};

const AccountState = Schema.Struct({
  email: Schema.String,
  header: Schema.String,
  problem: Schema.String,
  sent: Schema.String,
});

const accountState = async () =>
  await evaluate(
    AccountState,
    `({
    email: document.querySelector(".account-email")?.textContent ?? "",
    header: document.querySelector("nav.tabs a.account-tab")?.textContent ?? "",
    problem: [...document.querySelectorAll(".sign-in-problem[role=alert]")].map((node) => node.textContent).join(" "),
    sent: document.querySelector(".sign-in-sent")?.textContent ?? "",
  })`
  );

const waitForAccount = async (
  label: string,
  accept: (state: typeof AccountState.Type) => boolean
) =>
  await waitFor(label, async () => {
    const state = await accountState();

    return accept(state) ? state : undefined;
  });

const goTo = async (address: string) => {
  const navigation = await send(
    Schema.Struct({ errorText: Schema.optional(Schema.String) }),
    "Page.navigate",
    { url: address }
  );

  if (navigation.errorText !== undefined) {
    throw new Error(`navigation to ${address} failed: ${navigation.errorText}`);
  }
};

const finishSignIn = async (link: string) => {
  await goTo(link);

  await waitFor("the finish-signing-in button", async () =>
    (await evaluate(
      Schema.Boolean,
      `(() => {
      const button = [...document.querySelectorAll("form button")]
        .find((node) => node.textContent.trim() === "Finish signing in");
      if (button !== undefined) setTimeout(() => button.click(), 0);
      return button !== undefined;
    })()`
    ))
      ? true
      : undefined
  );
};

const submitEmail = async (email: string) => {
  if (!(await clickButton("nav.tabs a.account-tab", "Sign in"))) {
    throw new Error("no Sign in link in the header");
  }

  await waitFor("the sign-in form", async () =>
    (await evaluate(
      Schema.Boolean,
      'document.querySelector("form.sign-in input") !== null'
    ))
      ? true
      : undefined
  );

  await evaluate(
    Ignored,
    `(() => {
    const input = document.querySelector("form.sign-in input");
    input.value = ${JSON.stringify(email)};
    input.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector("form.sign-in").requestSubmit();
  })()`
  );
};

const Shortlist = Schema.Struct({
  heading: Schema.String,
  titles: Schema.Array(Schema.String),
});

const run = async () => {
  await send(Ignored, "Page.enable");
  await send(Ignored, "Runtime.enable");
  await send(Ignored, "Network.enable");
  await send(Ignored, "Fetch.enable", {
    patterns: [
      { requestStage: "Request", urlPattern: `${new URL(url).origin}/*` },
    ],
  });
  await send(Ignored, "Emulation.setDeviceMetricsOverride", viewport);
  await send(Ignored, "Emulation.setEmulatedMedia", {
    features: [
      { name: "prefers-color-scheme", value: values.dark ? "dark" : "light" },
    ],
  });

  const navigation = await send(
    Schema.Struct({ errorText: Schema.optional(Schema.String) }),
    "Page.navigate",
    { url }
  );

  if (navigation.errorText !== undefined) {
    throw new Error(`navigation to ${url} failed: ${navigation.errorText}`);
  }

  const loaded = await waitForRows(
    `at least ${minRows} job rows`,
    (state) => state.rows >= minRows
  );

  const background = await evaluate(
    Schema.String,
    "getComputedStyle(document.body).backgroundColor"
  );

  const steps: Step[] = [{ step: "loaded", ...loaded, background }];

  const signIn = async () => {
    const before = mailCount();

    await submitEmail(values.email);

    const sent = await waitForAccount("the check-your-email notice", (state) =>
      state.sent.includes(values.email)
    );

    steps.push({ step: `asked for a link for ${values.email}`, ...sent });

    await waitFor("the magic link email", async () => {
      await sleep(0);

      return mailCount() > before ? true : undefined;
    });

    const link = latestLink();

    await finishSignIn(link);

    const signedIn = await waitForAccount(
      "the header to show the account",
      (state) => state.header === values.email
    );

    steps.push({ step: "opened the emailed link", ...signedIn });

    return link;
  };

  const signOut = async () => {
    if (!(await clickButton(".account button.more", "Sign out"))) {
      throw new Error("no Sign out button on the account page");
    }

    await waitForAccount(
      "the header to offer Sign in",
      (state) => state.header === "Sign in"
    );

    await goTo(url);

    const reloaded = await waitForAccount(
      "the reloaded page to stay signed out",
      (state) => state.header === "Sign in"
    );

    steps.push({ step: "signed out and reloaded", ...reloaded });
  };

  const actions: Partial<Record<Scenario, () => Promise<void>>> = {
    "bad-email": async () => {
      const before = mailCount();

      await submitEmail("not-an-email");

      const refused = await waitForAccount(
        "an inline email error",
        (state) => state.problem.length > 0
      );

      await sleep(1000);

      steps.push({
        step: `submitted not-an-email; outbox ${before} -> ${mailCount()}`,
        ...refused,
      });

      if (mailCount() !== before) {
        throw new Error("an email was sent for an invalid address");
      }
    },
    filter: async () => {
      if (!(await clickButton("button.phrase", "day"))) {
        throw new Error('no "day" age chip to click');
      }

      const narrowed = await waitForRows(
        "the 1-day filter to change the list",
        (state) => state.count !== loaded.count && state.rows > 0
      );

      steps.push({ step: "filtered to the last day", ...narrowed });

      if (narrowed.rows >= loaded.rows) {
        throw new Error(
          `the 1-day filter did not narrow the list (${loaded.rows} to ${narrowed.rows} rows)`
        );
      }
    },
    "link-reuse": async () => {
      const link = await signIn();

      await signOut();
      await finishSignIn(link);

      const refused = await waitForAccount(
        "the used link to be refused",
        (state) => state.problem.includes("already used")
      );

      steps.push({ step: "reopened the used link", ...refused });

      if (refused.header !== "Sign in") {
        throw new Error("a used link signed the viewer in again");
      }
    },
    search: async () => {
      const company = await evaluate(
        Schema.String,
        'document.querySelector("li.job .job-company")?.textContent ?? ""'
      );

      await evaluate(
        Ignored,
        `(() => {
        const input = document.querySelector("form.search input");
        input.value = ${JSON.stringify(company)};
        input.dispatchEvent(new Event("input", { bubbles: true }));
        document.querySelector("form.search").requestSubmit();
      })()`
      );

      const searched = await waitForRows(
        `a search for ${company}`,
        (state) => state.count !== loaded.count && state.rows > 0
      );

      const companies = await evaluate(
        Schema.Array(Schema.String),
        '[...document.querySelectorAll("li.job .job-company")].map((node) => node.textContent)'
      );

      steps.push({
        step: `searched for ${company}`,
        ...searched,
        companies: [...new Set(companies)],
      });

      if (!companies.every((found) => found === company)) {
        throw new Error(`search for ${company} returned other companies`);
      }
    },
    shortlist: async () => {
      const title = await evaluate(
        Schema.String,
        'document.querySelector("li.job .job-title")?.textContent ?? ""'
      );

      if (!(await clickButton("li.job button.mark", "Save"))) {
        throw new Error("no Save button on the first job");
      }

      if (!(await clickButton("nav.tabs a.tab", "Your shortlist"))) {
        throw new Error("no shortlist tab");
      }

      const saved = await waitFor(
        "the shortlist to list the saved job",
        async () => {
          const state = await evaluate(
            Shortlist,
            `({
          heading: document.querySelector(".day-heading")?.textContent ?? "",
          titles: [...document.querySelectorAll("li.job .job-title")].map((node) => node.textContent),
        })`
          );

          return state.heading === "Saved (1)" && state.titles.includes(title)
            ? state
            : undefined;
        }
      );

      const stored = await evaluate(
        Schema.Finite,
        "Object.keys(localStorage).length"
      );

      steps.push({
        heading: saved.heading,
        localStorageKeys: stored,
        step: `saved ${title}`,
        titles: saved.titles,
      });
    },
    signin: async () => {
      await signIn();
    },
    signout: async () => {
      await signIn();
      await signOut();
    },
  };

  await actions[scenario]?.();

  const file = await screenshot(name);

  return { ok: true, scenario, screenshot: file, steps, url, viewport };
};

const failureScreenshot = async () => {
  try {
    return await Promise.race([
      screenshot(`${name}-failed`),
      sleep(5000, "none"),
    ]);
  } catch {
    return "none";
  }
};

mkdirSync(out, { recursive: true });

let code = 0;

try {
  process.stdout.write(`${JSON.stringify(await run())}\n`);
} catch (error) {
  code = 1;

  const reason = error instanceof Error ? error.message : String(error);
  const file = await failureScreenshot();

  process.stdout.write(
    `${JSON.stringify({ ok: false, reason, scenario, screenshot: file, url })}\n`
  );
}

try {
  await shutdown();
} catch (error) {
  process.stderr.write(
    `drive: could not remove the Chrome profile ${profile}: ${String(error)}\n`
  );
}

process.exit(code);
