import { Effect } from "effect";

export interface RateLimiter {
  readonly limit: (options: {
    readonly key: string;
  }) => Promise<{ readonly success: boolean }>;
}

export interface ReadLimits {
  readonly PUBLIC_READ_LIMIT: RateLimiter;
  readonly SESSION_READ_LIMIT: RateLimiter;
}

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

// @effect-diagnostics-next-line asyncFunction:off -- The Rate Limiting binding is Promise-based.
export const readAllowed = async (request: Request, limits: ReadLimits) => {
  const limiter = request.headers.has("cookie")
    ? limits.SESSION_READ_LIMIT
    : limits.PUBLIC_READ_LIMIT;

  const caller = clientBucketOf(
    request.headers.get("cf-connecting-ip") ?? "unknown"
  );

  const key = `${new URL(request.url).host}|${caller}`;

  return await Effect.runPromise(
    // @effect-diagnostics-next-line asyncFunction:off -- The Rate Limiting binding is Promise-based.
    Effect.tryPromise(async () => await limiter.limit({ key })).pipe(
      Effect.map(({ success }) => success),
      Effect.catch((error) =>
        Effect.as(
          Effect.logError("read limit unavailable, serving anyway", error),
          true
        )
      )
    )
  );
};

export const tooManyReads = () =>
  Response.json(
    {
      error: `Too many requests from this address. Retry in ${RETRY_AFTER_SECONDS} seconds.`,
    },
    { headers: { "retry-after": String(RETRY_AFTER_SECONDS) }, status: 429 }
  );
