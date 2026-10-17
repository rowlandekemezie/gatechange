export type EdgeRoute = "backend" | "private" | "public";

const routePrefixes: readonly (readonly [
  string,
  Exclude<EdgeRoute, "public">,
])[] = [
  ["/rpc", "backend"],
  ["/api/auth", "backend"],
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
