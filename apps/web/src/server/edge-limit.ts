import {
  ANONYMOUS_MCP_CALLS_PER_MINUTE,
  PUBLIC_READS_PER_MINUTE,
  TOKEN_MCP_CALLS_PER_MINUTE,
} from "@rat-stack/core";
import { Clock, Effect } from "effect";

export interface RateLimiter {
  readonly limit: (options: {
    readonly key: string;
  }) => Promise<{ readonly success: boolean }>;
}

const CALLS_PER_MINUTE = {
  MCP_ANONYMOUS_LIMIT: ANONYMOUS_MCP_CALLS_PER_MINUTE,
  MCP_TOKEN_LIMIT: TOKEN_MCP_CALLS_PER_MINUTE,
  PUBLIC_READ_LIMIT: PUBLIC_READS_PER_MINUTE,
  SESSION_READ_LIMIT: PUBLIC_READS_PER_MINUTE,
} as const;

type LimitName = keyof typeof CALLS_PER_MINUTE;

export type EdgeLimits = Readonly<Record<LimitName, RateLimiter>>;

export const RETRY_AFTER_SECONDS = 60;

const IPV6_GROUPS = 8;

const IPV6_SUBNET_GROUPS = 4;

const groupsOf = (part: string) =>
  part.split(":").filter((group) => group !== "");

const canonicalGroup = (group: string) =>
  group.toLowerCase().replace(/^0+(?=.)/u, "");

export const clientBucketOf = (address: string) => {
  if (!address.includes(":") || address.includes(".")) {
    return address;
  }

  const [head = "", tail = ""] = address.split("::");
  const left = groupsOf(head);
  const right = groupsOf(tail);

  const zeros = Array.from(
    { length: Math.max(0, IPV6_GROUPS - left.length - right.length) },
    () => "0"
  );

  return [...left, ...zeros, ...right]
    .slice(0, IPV6_SUBNET_GROUPS)
    .map(canonicalGroup)
    .join(":");
};

const WINDOW_MILLIS = 60_000;

const MAX_FALLBACK_WINDOWS = 10_000;

interface FallbackWindow {
  readonly calls: number;
  readonly startedAt: number;
}

const fallbackWindows = new Map<string, FallbackWindow>();

const withinFallback = (key: string, perMinute: number, now: number) => {
  const open = fallbackWindows.get(key);

  const window =
    open !== undefined && now - open.startedAt < WINDOW_MILLIS
      ? { ...open, calls: open.calls + 1 }
      : { calls: 1, startedAt: now };

  fallbackWindows.delete(key);
  fallbackWindows.set(key, window);

  if (fallbackWindows.size > MAX_FALLBACK_WINDOWS) {
    const [stalest] = fallbackWindows.keys();

    fallbackWindows.delete(stalest ?? key);
  }

  return window.calls <= perMinute;
};

// @effect-diagnostics-next-line asyncFunction:off -- The Rate Limiting binding is Promise-based.
const callAllowed = async (
  request: Request,
  limits: EdgeLimits,
  name: LimitName
) => {
  const caller = clientBucketOf(
    request.headers.get("cf-connecting-ip") ?? "unknown"
  );

  const key = `${new URL(request.url).host}|${caller}`;

  return await Effect.runPromise(
    // @effect-diagnostics-next-line asyncFunction:off -- The Rate Limiting binding is Promise-based.
    Effect.tryPromise(async () => await limits[name].limit({ key })).pipe(
      Effect.map(({ success }) => success),
      Effect.catch((error) =>
        Effect.logError(`${name} unavailable, counting locally`, error).pipe(
          Effect.andThen(Clock.currentTimeMillis),
          Effect.map((now) =>
            withinFallback(`${name}|${key}`, CALLS_PER_MINUTE[name], now)
          )
        )
      )
    )
  );
};

// @effect-diagnostics-next-line asyncFunction:off -- The Rate Limiting binding is Promise-based.
export const readAllowed = async (request: Request, limits: EdgeLimits) =>
  await callAllowed(
    request,
    limits,
    request.headers.has("cookie") ? "SESSION_READ_LIMIT" : "PUBLIC_READ_LIMIT"
  );

// @effect-diagnostics-next-line asyncFunction:off -- The Rate Limiting binding is Promise-based.
export const agentCallAllowed = async (request: Request, limits: EdgeLimits) =>
  await callAllowed(
    request,
    limits,
    request.headers.has("authorization")
      ? "MCP_TOKEN_LIMIT"
      : "MCP_ANONYMOUS_LIMIT"
  );

export const tooManyReads = () =>
  Response.json(
    {
      error: `Too many requests from this address. Retry in ${RETRY_AFTER_SECONDS} seconds.`,
    },
    { headers: { "retry-after": String(RETRY_AFTER_SECONDS) }, status: 429 }
  );
