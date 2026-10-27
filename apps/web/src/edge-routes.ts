export type EdgeRoute =
  | "agent"
  | "analytics"
  | "backend"
  | "private"
  | "public";

export const INGEST_PREFIX = "/ingest";

export const ANALYTICS_KEY_META = "posthog-key";

const UNSUBSCRIBE_PATH = "/unsubscribe";

const STRIPE_WEBHOOK_PATH = "/webhooks/stripe";

export const UNREDIRECTED_PATHS: ReadonlySet<string> = new Set([
  UNSUBSCRIBE_PATH,
  STRIPE_WEBHOOK_PATH,
]);

const routePrefixes: readonly (readonly [
  string,
  Exclude<EdgeRoute, "public">,
])[] = [
  [INGEST_PREFIX, "analytics"],
  ["/rpc", "backend"],
  ["/mcp", "agent"],
  ["/.well-known/mcp.json", "backend"],
  ["/api/auth", "backend"],
  [UNSUBSCRIBE_PATH, "backend"],
  [STRIPE_WEBHOOK_PATH, "backend"],
  ["/account", "private"],
];

export const edgeRouteOf = (pathname: string): EdgeRoute =>
  routePrefixes.find(
    ([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  )?.[1] ?? "public";

export const workerFirstPaths = routePrefixes.flatMap(([prefix]) => [
  prefix,
  `${prefix}/*`,
]);

export const PRIVATE_CACHE_CONTROL = "private, no-store";

export const HASHED_ASSET_PATHS = "/assets/*";

export const HASHED_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";

export const PRIVATE_REFERRER_POLICY = "no-referrer";

export const CANONICAL_REDIRECT_CACHE_CONTROL = "public, max-age=86400";
