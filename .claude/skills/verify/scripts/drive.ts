import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    dark: { default: false, type: "boolean" },
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

const scenarios = ["board", "filter", "search", "shortlist"] as const;
type Scenario = (typeof scenarios)[number];

const fail = (message: string): never => {
  process.stderr.write(`drive: ${message}\n`);
  process.exit(2);
};

const url = values.url ?? fail("--url is required");
const out = values.out ?? fail("--out is required");
const scenario =
  scenarios.find((name) => name === values.scenario) ??
  fail(`--scenario must be one of ${scenarios.join(", ")}`);
const minRows = Number(values["min-rows"]);
const deadline = Date.now() + Number(values["timeout-ms"]);
const name =
  values.name ??
  `${scenario}${values.mobile ? "-mobile" : ""}${values.dark ? "-dark" : ""}`;
const viewport = values.mobile
  ? { deviceScaleFactor: 3, height: 844, mobile: true, width: 390 }
  : { deviceScaleFactor: 1, height: 900, mobile: false, width: 1280 };

const chromeCandidates = [
  process.env.CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter((path): path is string => path !== undefined && existsSync(path));
const chromePath =
  chromeCandidates[0] ?? fail("no Chrome found; set CHROME to its binary");

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

const profile = mkdtempSync(join(tmpdir(), "verify-jobs-chrome-"));
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
  const exited = new Promise((done) => chrome.once("exit", done));
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
  while (Date.now() < deadline) {
    const found = await probe();
    if (found !== undefined) {
      return found;
    }
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${label}`);
};

const devtoolsPort = await waitFor("Chrome DevTools port", async () => {
  const file = join(profile, "DevToolsActivePort");
  return existsSync(file)
    ? readFileSync(file, "utf8").split("\n")[0]
    : undefined;
});

const target = (await (
  await fetch(`http://127.0.0.1:${devtoolsPort}/json/new?about:blank`, {
    method: "PUT",
  })
).json()) as { webSocketDebuggerUrl: string };

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((done, reject) => {
  socket.addEventListener("open", done, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

let nextId = 0;
const pending = new Map<
  number,
  { reject: (error: Error) => void; resolve: (value: unknown) => void }
>();
socket.addEventListener("close", () => {
  for (const waiter of pending.values()) {
    waiter.reject(new Error("Chrome closed the DevTools connection"));
  }
  pending.clear();
});
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data)) as {
    error?: { message: string };
    id?: number;
    result?: unknown;
  };
  const waiter = message.id === undefined ? undefined : pending.get(message.id);
  if (waiter && message.id !== undefined) {
    pending.delete(message.id);
    if (message.error) {
      waiter.reject(new Error(message.error.message));
    } else {
      waiter.resolve(message.result);
    }
  }
});

const send = <A>(method: string, params: object = {}): Promise<A> => {
  nextId += 1;
  const id = nextId;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise<A>((resolve, reject) => {
    pending.set(id, { reject, resolve: (value) => resolve(value as A) });
  });
};

const evaluate = async <A>(expression: string): Promise<A> => {
  const result = await send<{
    exceptionDetails?: { text: string };
    result: { value: A };
  }>("Runtime.evaluate", {
    awaitPromise: true,
    expression,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(`page script failed: ${result.exceptionDetails.text}`);
  }
  return result.result.value;
};

interface BoardState {
  readonly count: string;
  readonly error: string;
  readonly rows: number;
  readonly status: string;
}

const boardState = () =>
  evaluate<BoardState>(`({
    count: document.querySelector("p.count")?.textContent ?? "",
    error: document.querySelector(".empty[role=alert]")?.textContent ?? "",
    rows: document.querySelectorAll("li.job").length,
    status: document.querySelector(".status")?.textContent ?? "",
  })`);

const clickButton = (selector: string, text: string) =>
  evaluate<boolean>(`(() => {
    const button = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((node) => node.textContent.trim().startsWith(${JSON.stringify(text)}));
    button?.click();
    return button !== undefined;
  })()`);

const waitForRows = (label: string, accept: (state: BoardState) => boolean) =>
  waitFor(label, async () => {
    const state = await boardState();
    if (state.error.length > 0) {
      throw new Error(`board shows an error: ${state.error.trim()}`);
    }
    return accept(state) ? state : undefined;
  });

const screenshot = async (slug: string) => {
  const metrics = await send<{
    cssContentSize: { height: number; width: number };
  }>("Page.getLayoutMetrics");
  const { data } = await send<{ data: string }>("Page.captureScreenshot", {
    captureBeyondViewport: values["full-page"],
    format: "png",
    ...(values["full-page"]
      ? {
          clip: {
            height: metrics.cssContentSize.height,
            scale: 1,
            width: viewport.width,
            x: 0,
            y: 0,
          },
        }
      : {}),
  });
  const path = join(out, `${slug}.png`);
  writeFileSync(path, Buffer.from(data, "base64"));
  return path;
};

const run = async (): Promise<Record<string, unknown>> => {
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", viewport);
  await send("Emulation.setEmulatedMedia", {
    features: [
      { name: "prefers-color-scheme", value: values.dark ? "dark" : "light" },
    ],
  });
  const navigation = await send<{ errorText?: string }>("Page.navigate", {
    url,
  });
  if (navigation.errorText) {
    throw new Error(`navigation to ${url} failed: ${navigation.errorText}`);
  }

  const loaded = await waitForRows(
    `at least ${minRows} job rows`,
    (state) => state.rows >= minRows
  );
  const background = await evaluate<string>(
    "getComputedStyle(document.body).backgroundColor"
  );
  const steps: Record<string, unknown>[] = [
    { step: "loaded", ...loaded, background },
  ];

  const actions: Record<Scenario, () => Promise<void>> = {
    board: async () => {},
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
    search: async () => {
      const company = await evaluate<string>(
        'document.querySelector("li.job .job-company")?.textContent ?? ""'
      );
      await evaluate(`(() => {
        const input = document.querySelector("form.search input");
        input.value = ${JSON.stringify(company)};
        input.dispatchEvent(new Event("input", { bubbles: true }));
        document.querySelector("form.search").requestSubmit();
      })()`);
      const searched = await waitForRows(
        `a search for ${company}`,
        (state) => state.count !== loaded.count && state.rows > 0
      );
      const companies = await evaluate<string[]>(
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
      const title = await evaluate<string>(
        'document.querySelector("li.job .job-title")?.textContent ?? ""'
      );
      if (!(await clickButton("li.job button.mark", "Save"))) {
        throw new Error("no Save button on the first job");
      }
      if (!(await clickButton("nav.tabs button.tab", "Your shortlist"))) {
        throw new Error("no shortlist tab");
      }
      const saved = await waitFor(
        "the shortlist to list the saved job",
        async () => {
          const state = await evaluate<{
            heading: string;
            titles: string[];
          }>(`({
          heading: document.querySelector(".day-heading")?.textContent ?? "",
          titles: [...document.querySelectorAll("li.job .job-title")].map((node) => node.textContent),
        })`);
          return state.heading === "Saved (1)" && state.titles.includes(title)
            ? state
            : undefined;
        }
      );
      const stored = await evaluate<number>("Object.keys(localStorage).length");
      steps.push({
        step: `saved ${title}`,
        ...saved,
        localStorageKeys: stored,
      });
    },
  };

  await actions[scenario]();
  const path = await screenshot(name);
  return { ok: true, scenario, screenshot: path, steps, url, viewport };
};

mkdirSync(out, { recursive: true });
const outcome = await run().then(
  (report) => ({ code: 0, report }),
  async (error: unknown) => {
    const path = await Promise.race([
      screenshot(`${name}-failed`),
      sleep(5000).then(() => "none"),
    ]).catch(() => "none");
    const reason = error instanceof Error ? error.message : String(error);
    return {
      code: 1,
      report: { ok: false, reason, scenario, screenshot: path, url },
    };
  }
);
process.stdout.write(`${JSON.stringify(outcome.report)}\n`);
await shutdown().catch((error: unknown) => {
  process.stderr.write(
    `drive: could not remove the Chrome profile ${profile}: ${String(error)}\n`
  );
});
process.exit(outcome.code);
