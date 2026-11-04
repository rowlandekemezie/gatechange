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
    backend: { type: "string" },
    dark: { default: false, type: "boolean" },
    email: { default: "verify@example.com", type: "string" },
    "expect-digests": { default: "1", type: "string" },
    "full-page": { default: false, type: "boolean" },
    log: { type: "string" },
    "min-rows": { default: "10", type: "string" },
    mobile: { default: false, type: "boolean" },
    name: { type: "string" },
    out: { type: "string" },
    scenario: { default: "board", type: "string" },
    search: { default: "", type: "string" },
    "timeout-ms": { default: "45000", type: "string" },
    url: { type: "string" },
    "victim-job": { type: "string" },
  },
});

const scenarios = [
  "board",
  "filter",
  "filter-steady",
  "search",
  "shortlist",
  "signin",
  "bad-email",
  "signout",
  "link-reuse",
  "save-search",
  "delete-search",
  "digest",
  "no-double-send",
  "unsubscribe",
  "digest-links",
  "tracker-import",
  "tracker-import-decline",
  "tracker-list",
  "tracker-stages",
  "tracker-note",
  "tracker-remove",
  "tracker-closed",
  "tracker-gone",
  "tracker-isolation",
  "pricing",
  "free-gate",
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

const isCancelledInterception = (error: Error) =>
  error.message.includes("Invalid InterceptionId") ||
  error.message ===
    "Chrome closed the DevTools connection during Fetch.continueRequest";

const continueWithClientIp = async ({ params }: typeof PausedRequest.Type) => {
  try {
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
  } catch (error) {
    if (!(error instanceof Error && isCancelledInterception(error))) {
      throw error;
    }
  }
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
    rows: document.querySelectorAll(".board .departure").length,
    status: document.querySelector(".status")?.textContent ?? "",
  })`
  );

const clickButton = async (selector: string, text: string) =>
  await evaluate(
    Schema.Boolean,
    `(async () => {
    const button = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((node) => node.textContent.trim().startsWith(${JSON.stringify(text)}));
    if (button === undefined) return false;
    const reveal = async (control) => {
      if (button.checkVisibility() || control === null) return;
      control.click();
      await new Promise((settled) => requestAnimationFrame(settled));
    };
    await reveal(document.querySelector(".filters-toggle"));
    await reveal(button.closest("details")?.querySelector("summary") ?? null);
    if (!button.isConnected || !button.checkVisibility()) return false;
    button.click();
    return true;
  })()`
  );

const waitForRows = async (
  label: string,
  accept: (state: BoardStateValue) => boolean
) =>
  await waitFor(label, async () => {
    const interactive = await evaluate(
      Schema.Boolean,
      `document.readyState === "complete" &&
        document.querySelector("[data-foldkit-app]") === null &&
        getComputedStyle(document.body).backgroundColor !== "rgba(0, 0, 0, 0)"`
    );

    const state = await boardState();

    if (state.error.length > 0) {
      throw new Error(`board shows an error: ${state.error.trim()}`);
    }

    return interactive && accept(state) ? state : undefined;
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
  readonly detail?: string;
  readonly tracker?: TrackerStateValue;
  readonly companies?: readonly string[];
  readonly email?: string;
  readonly header?: string;
  readonly heading?: string;
  readonly localStorageKeys?: number;
  readonly problem?: string;
  readonly query?: string;
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

const DIGEST_SENT =
  /From: digest@\S+\n.*To: (?<to>\S+)\n.*Subject: [^\n]*for your saved searches\n.*\n.*Text: (?<text>\S+)\n.*HTML: (?<html>\S+)/gu;

const digestsTo = (email: string) => {
  const log = values.log ?? fail("--log is required for digest scenarios");

  return [...readFileSync(log, "utf-8").matchAll(DIGEST_SENT)].flatMap(
    (sent) =>
      sent.groups?.to === email
        ? [{ html: sent.groups.html ?? "", text: sent.groups.text ?? "" }]
        : []
  );
};

const DAY_MILLIS = 86_400_000;

const DIGEST_CRON = "7 * * * *";

const triggerDigest = async (at: number) => {
  const backend =
    values.backend ?? fail("--backend is required for digest scenarios");

  const trigger = new URL("/cdn-cgi/handler/scheduled", backend);

  trigger.searchParams.set("cron", DIGEST_CRON);
  trigger.searchParams.set("time", String(at));

  const response = await fetch(trigger);

  if (!response.ok) {
    throw new Error(`digest cron answered ${response.status}`);
  }
};

const unsubscribeLink = (text: string) =>
  (/https?:\/\/\S+\/unsubscribe\?token=\S+/u.exec(
    readFileSync(text, "utf-8")
  ) ?? [])[0] ?? fail(`no unsubscribe link in ${text}`);

const expectDigests = (fresh: readonly unknown[], expected: number) => {
  if (fresh.length !== expected) {
    throw new Error(`expected ${expected} digest(s), got ${fresh.length}`);
  }
};

const onSite = (link: string) => {
  const moved = new URL(link);
  const site = new URL(url);

  return new URL(`${moved.pathname}${moved.search}`, site.origin).href;
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
    header: document.querySelector("a.nav-account")?.textContent ?? "",
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

const markRows = async (
  [kind, ...rest]: readonly ("Applied" | "Save")[],
  index = 0
): Promise<void> => {
  if (kind === undefined) {
    return;
  }

  if (values.mobile) {
    const href = await evaluate(
      Schema.String,
      `document.querySelectorAll(".board .departure a.departure-tiles")[${index}]?.href ?? ""`
    );

    await goTo(href);
    await waitFor("the job page buttons", async () =>
      (await evaluate(
        Schema.Boolean,
        'document.querySelector("[data-foldkit-app]") === null'
      )) && (await clickButton(".detail-actions button.mark", kind))
        ? true
        : undefined
    );
    await waitFor("the mark to take", async () =>
      (await evaluate(
        Schema.Boolean,
        'document.querySelector(".detail-actions button.mark[aria-pressed=true]") !== null'
      ))
        ? true
        : undefined
    );
    await goTo(url);
    await waitForRows("the board", (state) => state.rows > index);
  } else if (
    !(await evaluate(
      Schema.Boolean,
      `(() => {
      const button = document.querySelectorAll(".board .departure")[${index}]
        ?.querySelector('button.mark[aria-label="${kind}"]');
      button?.click();
      return button !== undefined && button !== null;
    })()`
    ))
  ) {
    throw new Error(`no ${kind} button on row ${index + 1}`);
  }

  await markRows(rest, index + 1);
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
  if (!(await clickButton("a.nav-account", "Sign in"))) {
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

const TrackerState = Schema.Struct({
  closed: Schema.Array(Schema.String),
  empty: Schema.Boolean,
  loading: Schema.Boolean,
  notes: Schema.Array(Schema.String),
  offer: Schema.String,
  overflow: Schema.Finite,
  pipeline: Schema.String,
  problem: Schema.String,
  sections: Schema.Array(
    Schema.Struct({
      heading: Schema.String,
      titles: Schema.Array(Schema.String),
    })
  ),
  stored: Schema.NullOr(Schema.String),
  titles: Schema.Array(Schema.String),
});

type TrackerStateValue = typeof TrackerState.Type;

const GonePage = Schema.Struct({
  company: Schema.String,
  link: Schema.String,
  pageTitle: Schema.String,
  title: Schema.String,
});

const trackerState = async () =>
  await evaluate(
    TrackerState,
    `({
    closed: [...document.querySelectorAll("li.tracked-closed .job-title")].map((node) => node.textContent),
    empty: [...document.querySelectorAll(".empty p")].some((node) => node.textContent === "Your tracker is empty."),
    loading: document.querySelector(".empty [role=status]") !== null,
    notes: [...document.querySelectorAll("li.tracked textarea")].map((node) => node.value),
    offer: document.querySelector(".import-offer")?.textContent ?? "",
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    pipeline: document.querySelector("ol.pipeline")?.textContent ?? "",
    problem: document.querySelector(".sign-in-problem[role=alert]")?.textContent ?? "",
    sections: [...document.querySelectorAll("section.day")].map((section) => ({
      heading: section.querySelector(".day-heading")?.textContent ?? "",
      titles: [...section.querySelectorAll("li.tracked .job-title")].map((node) => node.textContent),
    })),
    stored: localStorage.getItem("jobs.shortlist.v1"),
    titles: [...document.querySelectorAll("li.tracked .job-title")].map((node) => node.textContent),
  })`
  );

const waitForTracker = async (
  label: string,
  accept: (state: TrackerStateValue) => boolean
) =>
  await waitFor(label, async () => {
    const state = await trackerState();

    return !state.loading && accept(state) ? state : undefined;
  });

const stageOfTitle = (state: TrackerStateValue, title: string) =>
  state.sections
    .find((section) => section.titles.includes(title))
    ?.heading.replace(/ \(\d+\)$/u, "");

const duplicatesOf = (titles: readonly string[]) =>
  titles.filter((title, index) => titles.indexOf(title) !== index);

const inCard = async (title: string, script: string) =>
  await evaluate(
    Schema.Boolean,
    `(() => {
    const card = [...document.querySelectorAll("li.tracked")]
      .find((node) => node.querySelector(".job-title")?.textContent === ${JSON.stringify(title)});
    if (card === undefined) return false;
    ${script}
    return true;
  })()`
  );

const rpcCall = async (
  tag: string,
  payload: Readonly<Record<string, string>>
) =>
  await evaluate(
    Schema.String,
    `fetch("/rpc", {
      body: JSON.stringify({ _tag: "Request", headers: [], id: "1", payload: ${JSON.stringify(payload)}, tag: ${JSON.stringify(tag)} }),
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      method: "POST",
    }).then((response) => response.text())`
  );

const Cookies = Schema.Struct({
  cookies: Schema.Array(
    Schema.Struct({ name: Schema.String, value: Schema.String })
  ),
});

type RpcPayload = Readonly<
  Record<string, string | Readonly<Record<string, string>>>
>;

const rpcFromElsewhere = async (
  tag: string,
  payload: RpcPayload,
  site: Readonly<Record<string, string>>
) => {
  const { cookies } = await send(Cookies, "Network.getCookies");

  const response = await fetch(new URL("/rpc", url), {
    body: `{"_tag":"Request","headers":[],"id":"1","payload":${JSON.stringify(payload)},"tag":${JSON.stringify(tag)}}`,
    headers: {
      "content-type": "application/json",
      cookie: cookies
        .map((cookie) => `${cookie.name}=${cookie.value}`)
        .join("; "),
      ...site,
    },
    method: "POST",
  });

  return { body: await response.text(), status: response.status };
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

  const saveSearch = async () => {
    await signIn();
    await goTo(url);
    await waitForRows(
      `at least ${minRows} job rows`,
      (state) => state.rows >= minRows
    );

    if (values.search !== "") {
      await evaluate(
        Ignored,
        `(() => {
        const input = document.querySelector("form.search input");
        input.value = ${JSON.stringify(values.search)};
        input.dispatchEvent(new Event("input", { bubbles: true }));
        document.querySelector("form.search").requestSubmit();
      })()`
      );
      await waitFor("the board to show the search", async () => {
        const query = await evaluate(Schema.String, "location.search");

        return query.includes("q=") ? true : undefined;
      });
    }

    await waitFor("the save-search button", async () =>
      (await clickButton("button.save-search", "Email me new matches weekly"))
        ? true
        : undefined
    );

    const note = await waitFor("the saved notice", async () => {
      const text = await evaluate(
        Schema.String,
        'document.querySelector(".save-search-note[role=status]")?.textContent ?? ""'
      );

      return text.startsWith("Saved") ? text : undefined;
    });

    steps.push({
      sent: note,
      step: `saved the board search ${JSON.stringify(values.search)}`,
    });
  };

  const savedSearchLabels = async () =>
    await evaluate(
      Schema.Array(Schema.String),
      '[...document.querySelectorAll("li.saved-search .saved-search-label")].map((node) => node.textContent)'
    );

  const openAccount = async (
    accept: (labels: readonly string[]) => boolean
  ) => {
    await goTo(new URL("/account", url).href);

    return await waitFor("the saved-search list", async () => {
      const ready = await evaluate(
        Schema.Boolean,
        'document.querySelector("section.saved-searches .saved-search-list, section.saved-searches .account-lede") !== null'
      );

      const labels = await savedSearchLabels();

      return ready && accept(labels) ? labels : undefined;
    });
  };

  const runDigest = async (at: number, label: string) => {
    const before = digestsTo(values.email).length;

    await triggerDigest(at);
    await sleep(2500);

    const fresh = digestsTo(values.email).slice(before);

    steps.push({
      step: `${label}: ran the digest cron at ${new Date(at).toISOString()}, ${fresh.length} new digest(s)`,
    });

    return fresh;
  };

  const renderDigest = async () => {
    const html =
      digestsTo(values.email).at(-1)?.html ?? fail("no digest html in the log");

    await goTo(`file://${html}`);
    await waitFor("the digest heading", async () => {
      const heading = await evaluate(
        Schema.String,
        'document.querySelector("h1")?.textContent ?? ""'
      );

      return heading.length > 0 ? true : undefined;
    });

    const rendered = await evaluate(
      Schema.Struct({
        heading: Schema.String,
        links: Schema.Array(Schema.String),
        overflow: Schema.Boolean,
        titles: Schema.Array(Schema.String),
      }),
      `({
        heading: document.querySelector("h1").textContent,
        links: [...document.querySelectorAll("li a")].map((node) => node.href),
        overflow: document.documentElement.scrollWidth > window.innerWidth,
        titles: [...document.querySelectorAll("li a")].map((node) => node.textContent),
      })`
    );

    steps.push({
      heading: rendered.heading,
      step: `rendered ${path.basename(html)}; horizontal overflow ${rendered.overflow}`,
      titles: rendered.titles,
    });

    if (rendered.overflow) {
      throw new Error("the digest scrolls sideways");
    }

    return rendered;
  };

  const openEach = async (
    links: readonly string[],
    titles: readonly string[] = []
  ): Promise<readonly string[]> => {
    const [link, ...rest] = links;

    if (link === undefined) {
      return titles;
    }

    await goTo(onSite(link));

    const title = await waitFor(`the job page for ${link}`, async () => {
      const heading = await evaluate(
        Schema.String,
        'document.querySelector("h1.detail-title")?.textContent ?? ""'
      );

      return heading.length > 0 ? heading : undefined;
    });

    return await openEach(rest, [...titles, title]);
  };

  const digestActions: Partial<Record<Scenario, () => Promise<void>>> = {
    "delete-search": async () => {
      await saveSearch();
      await openAccount((labels) => labels.length > 0);

      if (!(await clickButton("li.saved-search button.mark", "Delete"))) {
        throw new Error("no Delete button on the saved search");
      }

      const left = await waitFor("the saved search to disappear", async () => {
        const labels = await savedSearchLabels();

        return labels.length === 0 ? labels : undefined;
      });

      steps.push({ step: "deleted the saved search", titles: left });
      expectDigests(await runDigest(Date.now() + 60_000, "after delete"), 0);
    },
    digest: async () => {
      await saveSearch();
      expectDigests(
        await runDigest(Date.now() + 60_000, "first run"),
        Number(values["expect-digests"])
      );

      if (Number(values["expect-digests"]) > 0) {
        await renderDigest();
      }
    },
    "digest-links": async () => {
      await saveSearch();
      expectDigests(await runDigest(Date.now() + 60_000, "first run"), 1);

      const { links } = await renderDigest();
      const titles = await openEach(links);

      steps.push({
        step: `opened ${titles.length} digest links on the board`,
        titles,
      });

      if (!links.every((link) => new URL(link).pathname.startsWith("/jobs/"))) {
        throw new Error("a digest link does not point at a job page");
      }
    },
    "no-double-send": async () => {
      await saveSearch();

      const at = Date.now() + 60_000;
      const first = await runDigest(at, "first run");
      const second = await runDigest(at, "same window again");
      const later = await runDigest(at + 3 * 3_600_000, "three hours later");

      expectDigests([...first, ...second, ...later], 1);
      await renderDigest();
    },
    "save-search": async () => {
      await saveSearch();

      const labels = await openAccount((found) => found.length > 0);

      steps.push({ step: "opened the account page", titles: labels });
    },
    unsubscribe: async () => {
      await saveSearch();

      const at = Date.now() + 60_000;
      const [sent] = await runDigest(at, "first run");

      const link = onSite(
        unsubscribeLink(sent?.text ?? fail("no digest arrived"))
      );

      await goTo(link);
      await waitFor("the unsubscribe button", async () =>
        (await clickButton("form button", "Unsubscribe")) ? true : undefined
      );

      const done = await waitFor("the unsubscribed page", async () => {
        const heading = await evaluate(
          Schema.String,
          'document.querySelector("h1")?.textContent ?? ""'
        );

        return heading === "You are unsubscribed" ? heading : undefined;
      });

      steps.push({
        heading: done,
        step: "pressed Unsubscribe on the emailed link",
      });

      expectDigests(await runDigest(at + 7 * DAY_MILLIS, "next week"), 0);
      await goTo(link);
      await clickButton("form button", "Unsubscribe");
      await waitFor("the unsubscribed page", async () =>
        (await evaluate(
          Schema.String,
          'document.querySelector("h1")?.textContent ?? ""'
        )) === "You are unsubscribed"
          ? true
          : undefined
      );
    },
  };

  const shortlistUrl = new URL("/shortlist", url).href;

  const openTracker = async (label: string) => {
    await goTo(shortlistUrl);

    const tracker = await waitForTracker(
      label,
      (state) => state.empty || state.titles.length > 0 || state.problem !== ""
    );

    if (tracker.problem !== "") {
      throw new Error(`the tracker shows a problem: ${tracker.problem}`);
    }

    steps.push({ step: label, tracker });

    return tracker;
  };

  const firstTracked = async () => {
    const tracker = await openTracker("opened the tracker");
    const [title] = tracker.titles;

    if (title !== undefined) {
      return title;
    }

    await goTo(url);
    await waitForRows("the board", (state) => state.rows > 0);

    const saved = await evaluate(
      Schema.String,
      'document.querySelector(".board .departure .role-title")?.textContent ?? ""'
    );

    await markRows(["Save"]);

    await sleep(1500);
    await openTracker("opened the tracker after saving a job");

    return saved;
  };

  const savedThreeSignedOut = async () => {
    const titles = await evaluate(
      Schema.Array(Schema.String),
      '[...document.querySelectorAll(".board .departure .role-title")].slice(0, 3).map((node) => node.textContent)'
    );

    await markRows(["Save", "Save", "Applied"]);

    steps.push({ step: "saved two and applied one while signed out", titles });

    return titles;
  };

  const askedToMove = async (label: string) => {
    await goTo(shortlistUrl);

    const asked = await waitForTracker(
      label,
      (state) =>
        state.offer.includes(values.email) && state.offer.includes("3 jobs")
    );

    steps.push({
      detail: await screenshot(`${name}-prompt`),
      step: label,
      tracker: asked,
    });

    return asked;
  };

  const actions: Partial<Record<Scenario, () => Promise<void>>> = {
    ...digestActions,
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

      if (narrowed.rows > loaded.rows) {
        throw new Error(
          `the 1-day filter did not narrow the list (${loaded.rows} to ${narrowed.rows} rows)`
        );
      }
    },
    "filter-steady": async () => {
      await evaluate(
        Schema.Null,
        `(() => {
        const watch = { boardGone: 0, shortest: document.documentElement.scrollHeight };
        window.__steady = watch;
        new MutationObserver(() => {
          if (!document.querySelector(".board")) watch.boardGone += 1;
          watch.shortest = Math.min(watch.shortest, document.documentElement.scrollHeight);
        }).observe(document.body, { childList: true, subtree: true });
        return null;
      })()`
      );

      if (!(await clickButton("button.phrase", "day"))) {
        throw new Error('no "day" age chip to click');
      }

      const narrowed = await waitForRows(
        "the 1-day filter to change the list",
        (state) => state.count !== loaded.count && state.rows > 0
      );

      const watch = await evaluate(
        Schema.Struct({ boardGone: Schema.Finite, shortest: Schema.Finite }),
        "window.__steady"
      );

      steps.push({ step: "filtered without a flicker", ...narrowed, ...watch });

      if (watch.boardGone > 0) {
        throw new Error(
          `the board left the page ${watch.boardGone} times while filtering`
        );
      }
    },
    "free-gate": async () => {
      await signIn();
      await goTo(url);

      const before = await waitForRows(
        `at least ${minRows} job rows`,
        (state) => state.rows >= minRows
      );

      await waitFor("the salary filter chip", async () =>
        (await clickButton("button.phrase", "Only roles that state a salary"))
          ? true
          : undefined
      );

      const prompt = await waitFor("the upgrade prompt", async () => {
        const text = await evaluate(
          Schema.String,
          'document.querySelector(".upgrade-prompt")?.textContent ?? ""'
        );

        return text.length > 0 ? text : undefined;
      });

      await sleep(1500);

      const after = await waitForRows(
        "the board after the salary filter",
        (state) => state.rows > 0
      );

      const query = await evaluate(Schema.String, "location.search");

      steps.push(
        { step: "board before the salary filter", ...before },
        {
          detail: prompt,
          step: "turned on the salary filter as Free",
          ...after,
          query,
        }
      );

      if (after.count !== before.count || after.rows !== before.rows) {
        throw new Error(
          `a Free member lost listings: ${before.count} became ${after.count}`
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
    pricing: async () => {
      await goTo(new URL("/pricing", url).href);

      const plans = await waitFor(
        "plan cards or the not-on-sale note",
        async () => {
          const found = await evaluate(
            Schema.Struct({
              names: Schema.Array(Schema.String),
              notOnSale: Schema.Boolean,
              overflow: Schema.Finite,
              prices: Schema.Array(Schema.String),
            }),
            `({
            names: [...document.querySelectorAll("li.plan .plan-name")].map((node) => node.textContent),
            notOnSale: document.body.textContent.includes("Pro is not on sale on this site."),
            overflow: document.documentElement.scrollWidth - window.innerWidth,
            prices: [...document.querySelectorAll("li.plan .plan-price")].map((node) => node.textContent),
          })`
          );

          return found.prices.length > 0 || found.notOnSale ? found : undefined;
        }
      );

      steps.push({ step: "opened the pricing page", ...plans });

      if (plans.overflow > 0) {
        throw new Error(
          `the pricing page scrolls sideways by ${plans.overflow}px`
        );
      }
    },
    search: async () => {
      const company = await evaluate(
        Schema.String,
        'document.querySelector(".board .departure .cell-company")?.textContent ?? ""'
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
        '[...document.querySelectorAll(".board .departure .cell-company")].map((node) => node.textContent)'
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
        'document.querySelector(".board .departure .role-title")?.textContent ?? ""'
      );

      await markRows(["Save"]);
      await sleep(500);

      if (!(await clickButton("a.nav-link", "Shortlist"))) {
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
    "tracker-closed": async () => {
      await signIn();

      const tracker = await openTracker("opened the tracker");

      if (tracker.closed.length === 0) {
        throw new Error("no tracked job shows the closed-posting note");
      }
    },
    "tracker-gone": async () => {
      await signIn();

      const tracker = await openTracker("opened the tracker");
      const [saved] = tracker.closed;

      if (saved === undefined) {
        throw new Error("no tracked job shows the closed-posting note");
      }

      await inCard(saved, 'card.querySelector("a.job-title").click();');

      const shown = await waitFor("the saved role's page", async () => {
        const gone = await evaluate(
          GonePage,
          `({
    company: document.querySelector(".job-company")?.textContent ?? "",
    link: document.querySelector("a.apply")?.getAttribute("href") ?? "",
    pageTitle: document.title,
    title: document.querySelector("h1.detail-title")?.textContent ?? "",
  })`
        );

        return gone.title === saved ? gone : undefined;
      });

      steps.push({
        step: `opened the gone role: ${shown.pageTitle}; ${shown.link}`,
      });

      if (shown.link === "") {
        throw new Error(`the gone role has no original posting link: ${saved}`);
      }
    },
    "tracker-import": async () => {
      const titles = await savedThreeSignedOut();

      await signIn();

      const asked = await askedToMove("the move prompt after sign-in");

      if (asked.stored === null) {
        throw new Error(
          "the browser shortlist moved before the member confirmed"
        );
      }

      if (!(await clickButton(".import-offer button", "Move them"))) {
        throw new Error("no Move button in the prompt");
      }

      const imported = await waitForTracker(
        "the moved jobs in the tracker",
        (state) => state.offer === "" && state.titles.length >= titles.length
      );

      steps.push({ step: "pressed Move them", tracker: imported });

      const missing = titles.filter(
        (title) => !imported.titles.includes(title)
      );

      const duplicated = duplicatesOf(imported.titles);

      if (missing.length > 0) {
        throw new Error(`the import lost ${missing.join(", ")}`);
      }

      if (duplicated.length > 0) {
        throw new Error(`the tracker repeats ${duplicated.join(", ")}`);
      }

      if (imported.stored !== null) {
        throw new Error("the browser shortlist was not cleared after import");
      }
    },
    "tracker-import-decline": async () => {
      const titles = await savedThreeSignedOut();

      await signIn();
      await askedToMove("the move prompt after sign-in");

      if (!(await clickButton(".import-offer button", "Keep them"))) {
        throw new Error("no Keep button in the prompt");
      }

      const kept = await waitForTracker(
        "the prompt to close",
        (state) => state.offer === ""
      );

      steps.push({ step: "pressed Keep them in this browser", tracker: kept });

      const stored = kept.stored ?? "";
      const lost = titles.filter((title) => !stored.includes(title));

      if (!kept.empty) {
        throw new Error("declining still moved jobs into the account");
      }

      if (lost.length > 0) {
        throw new Error(
          `declining dropped ${lost.join(", ")} from this browser`
        );
      }
    },
    "tracker-isolation": async () => {
      const victim = values["victim-job"] ?? fail("--victim-job is required");

      const anonymous = await rpcCall("trackedJobs", {});

      steps.push({ detail: anonymous, step: "asked for a tracker signed out" });

      if (!anonymous.includes("Unauthorized")) {
        throw new Error("a signed-out viewer was not refused");
      }

      await signIn();

      const replies = [
        await rpcCall("trackedJobs", {}),
        await rpcCall("noteTrackedJob", {
          jobId: victim,
          notes: "isolation probe",
        }),
        await rpcCall("untrackJob", { jobId: victim }),
      ];

      steps.push({
        detail: replies.join("\n"),
        step: `probed ${victim} as ${values.email}`,
      });

      if (replies.some((reply) => reply.includes(victim))) {
        throw new Error("another member's tracked job came back");
      }

      const probe = {
        jobId: "cross-site-probe",
        snapshot: {
          company: "Probe",
          location: "Remote",
          title: "Cross-site probe",
          url: "https://evil.example/probe",
        },
        stage: "Saved",
      };

      const crossSite = await rpcFromElsewhere("trackJob", probe, {
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
      });

      const sameOrigin = await rpcFromElsewhere(
        "trackedJobs",
        {},
        {
          origin: new URL(url).origin,
          "sec-fetch-site": "same-origin",
        }
      );

      steps.push({
        detail: `cross-site trackJob ${crossSite.status} ${crossSite.body}\nsame-origin trackedJobs ${sameOrigin.status}`,
        step: "replayed the session cookie from another site",
      });

      if (crossSite.status !== 403) {
        throw new Error(
          `a cross-site tracker write answered ${crossSite.status}`
        );
      }

      if (
        sameOrigin.status !== 200 ||
        sameOrigin.body.includes("Unauthorized")
      ) {
        throw new Error(
          "the same cookie from this site was not a member, so the refusal proves nothing"
        );
      }

      const after = await rpcCall("trackedJobs", {});

      if (after.includes("cross-site-probe")) {
        throw new Error("the cross-site write reached the tracker");
      }
    },
    "tracker-list": async () => {
      await signIn();
      await openTracker("opened the tracker");
    },
    "tracker-note": async () => {
      await signIn();

      const title = await firstTracked();
      const note = `Recruiter screen booked ${new Date().toISOString()}`;

      await inCard(
        title,
        `card.querySelector("details").open = true;
        const area = card.querySelector("textarea");
        area.value = ${JSON.stringify(note)};
        area.dispatchEvent(new Event("change", { bubbles: true }));`
      );

      await sleep(1500);
      await openTracker("reloaded the tracker");

      const reloaded = await waitForTracker("the note after reload", (state) =>
        state.notes.includes(note)
      );

      steps.push({ detail: note, step: `noted ${title}`, tracker: reloaded });
    },
    "tracker-remove": async () => {
      await signIn();

      const title = await firstTracked();

      await inCard(
        title,
        `[...card.querySelectorAll("button.mark")].find((button) => button.textContent === "Remove")?.click();`
      );

      await waitForTracker(
        "the card to leave",
        (state) => !state.titles.includes(title)
      );
      await sleep(1500);

      const reloaded = await openTracker("reloaded the tracker");

      steps.push({ detail: title, step: "removed a tracked job" });

      if (reloaded.titles.includes(title)) {
        throw new Error(`${title} came back after reload`);
      }
    },
    "tracker-stages": async () => {
      await signIn();

      const title = await firstTracked();

      const moveThrough = async (
        remaining: readonly string[]
      ): Promise<void> => {
        const [stage, ...rest] = remaining;

        if (stage === undefined) {
          return;
        }

        await inCard(
          title,
          `const select = card.querySelector("select");
          select.value = ${JSON.stringify(stage)};
          select.dispatchEvent(new Event("change", { bubbles: true }));`
        );

        await waitForTracker(
          `${title} under ${stage}`,
          (state) => stageOfTitle(state, title) === stage
        );
        await sleep(1500);
        await openTracker(`reloaded after moving to ${stage}`);

        const reloaded = await waitForTracker(
          `${stage} after reload`,
          (state) => stageOfTitle(state, title) === stage
        );

        steps.push({
          detail: stage,
          step: `moved ${title}`,
          tracker: reloaded,
        });

        await moveThrough(rest);
      };

      await moveThrough([
        "Applied",
        "Offer",
        "Rejected",
        "Saved",
        "Interviewing",
      ]);

      const final = await trackerState();

      if (final.overflow > 0) {
        throw new Error(`the tracker scrolls sideways by ${final.overflow}px`);
      }
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
