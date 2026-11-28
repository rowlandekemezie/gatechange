import {
  getOAuthProviderApi,
  oauthProvider,
} from "@better-auth/oauth-provider";
import {
  MCP_PATH,
  OAUTH_ACCESS_TOKEN_PREFIX,
  OAUTH_REFRESH_TOKEN_PREFIX,
} from "@rat-stack/core";
import type {
  BetterAuthOptions,
  BetterAuthPlugin,
  DBAdapter,
  Session,
} from "better-auth";
import {
  createAuthEndpoint,
  createAuthMiddleware,
  isAPIError,
} from "better-auth/api";
import { Array, Option, Schema } from "effect";

export const OAUTH_CONNECT_PATH = "/account/connect";

export const MCP_SCOPE = "mcp";

export const OAUTH_SCOPES = [MCP_SCOPE, "offline_access"];

const TOKEN_PATH = "/oauth2/token";

const RESOURCE_PATHS: ReadonlySet<string> = new Set([
  "/oauth2/authorize",
  TOKEN_PATH,
]);

const TokenRequest = Schema.Struct({
  resource: Schema.String,
  token: Schema.String,
});

export const mcpResourceOf = (origin: string) =>
  `${new URL(origin).origin}${MCP_PATH}`;

const ActiveToken = Schema.Struct({
  active: Schema.Literal(true),
  aud: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
  scope: Schema.String,
  sub: Schema.String,
});

const decodeActiveToken = Schema.decodeUnknownOption(ActiveToken);

const RefreshableGrant = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.String,
});

const decodeRefreshableGrant = Schema.decodeUnknownOption(RefreshableGrant);

export interface TokenHolder {
  readonly email: string;
  readonly id: string;
  readonly name: string;
}

interface ResourceRow {
  readonly identifier: string;
}

const servesResource = (
  token: typeof ActiveToken.Type,
  resource: string
): boolean =>
  Array.ensure(token.aud).includes(resource) &&
  token.scope.split(" ").includes(MCP_SCOPE);

// @effect-diagnostics-next-line asyncFunction:off -- better-auth's adapter is Promise-based.
const ensureResource = async (adapter: DBAdapter, resource: string) => {
  const where = [{ field: "identifier", value: resource }];

  const found = await adapter.findOne<ResourceRow>({
    model: "oauthResource",
    where,
  });

  if (found !== null) {
    return;
  }

  // @effect-diagnostics-next-line globalDate:off -- better-auth stamps its rows with the same wall clock.
  const now = new Date();

  try {
    await adapter.create({
      data: {
        createdAt: now,
        disabled: false,
        dpopBoundAccessTokensRequired: false,
        identifier: resource,
        name: "Gate Change MCP",
        policyVersion: 1,
        updatedAt: now,
      },
      model: "oauthResource",
    });
  } catch (error) {
    const raced = await adapter.findOne<ResourceRow>({
      model: "oauthResource",
      where,
    });

    if (raced === null) {
      throw error;
    }
  }
};

const oauthProviderPlugin = () =>
  oauthProvider({
    allowDynamicClientRegistration: true,
    allowUnauthenticatedClientRegistration: true,
    clientRegistrationDefaultApplicationType: "infer",
    consentPage: OAUTH_CONNECT_PATH,
    disableJwtPlugin: true,
    enforcePerClientResources: false,
    grantTypes: ["authorization_code", "refresh_token"],
    loginPage: OAUTH_CONNECT_PATH,
    prefix: {
      opaqueAccessToken: OAUTH_ACCESS_TOKEN_PREFIX,
      refreshToken: OAUTH_REFRESH_TOKEN_PREFIX,
    },
    scopes: OAUTH_SCOPES,
  });

type OAuthProviderPlugin = ReturnType<typeof oauthProvider>;

interface Statement {
  readonly sql: string;
  readonly values: readonly string[];
}

type RunAtomically = (statements: readonly Statement[]) => Promise<void>;

type DatabaseOption = BetterAuthOptions["database"];

interface D1RunResult {
  readonly success: boolean;
}

interface D1BoundStatement {
  readonly run: () => Promise<D1RunResult>;
}

interface D1Binding {
  readonly batch: (
    statements: readonly D1BoundStatement[]
  ) => Promise<readonly D1RunResult[]>;
  readonly prepare: (sql: string) => {
    readonly bind: (...values: readonly string[]) => D1BoundStatement;
  };
}

interface SyncRunResult {
  readonly changes: number | bigint;
}

interface SyncSqlite {
  readonly prepare: (sql: string) => {
    readonly run: (...values: readonly string[]) => SyncRunResult;
  };
}

const atomicRunnerOf = (database: DatabaseOption): RunAtomically => {
  if (database !== undefined && "batch" in database) {
    // SAFETY: better-auth picks its D1 dialect for any database with batch, exec and prepare, and D1Binding names the calls made here.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- better-auth's database union names driver types this package does not install.
    const d1 = database as D1Binding;

    // @effect-diagnostics-next-line asyncFunction:off -- D1 batches are Promise-based.
    return async (statements) => {
      await d1.batch(
        statements.map(({ sql, values }) => d1.prepare(sql).bind(...values))
      );
    };
  }

  if (database !== undefined && "exec" in database && "prepare" in database) {
    // SAFETY: a database with exec and prepare and no batch is a synchronous SQLite driver, whose prepared statements run with positional values.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- better-auth's database union names driver types this package does not install.
    const sqlite = database as SyncSqlite;

    // @effect-diagnostics-next-line asyncFunction:off -- better-auth's database hooks await a Promise.
    return async (statements) => {
      await Promise.resolve();

      for (const { sql, values } of statements) {
        sqlite.prepare(sql).run(...values);
      }
    };
  }

  throw new TypeError(
    "mcp-resource needs a D1 binding or a node:sqlite database to end connections on sign-out"
  );
};

const endConnectionsOf = (sessionId: string, now: Date): Statement[] => [
  {
    sql: 'UPDATE "oauthAccessToken" SET "revoked" = ?1 WHERE "revoked" IS NULL AND "refreshId" IN (SELECT "id" FROM "oauthRefreshToken" WHERE "sessionId" = ?2)',
    values: [now.toISOString(), sessionId],
  },
  {
    sql: 'UPDATE "oauthRefreshToken" SET "revoked" = ?1 WHERE "sessionId" = ?2 AND "revoked" IS NULL',
    values: [now.toISOString(), sessionId],
  },
  { sql: 'DELETE FROM "session" WHERE "id" = ?1', values: [sessionId] },
];

// @effect-diagnostics-next-line asyncFunction:off -- better-auth database hooks are Promise-returning.
const signOutOf = async (runAtomically: RunAtomically, session: Session) => {
  // @effect-diagnostics-next-line globalDate:off -- better-auth stamps its rows with the same wall clock.
  const now = new Date();

  if (session.expiresAt < now) {
    return;
  }

  await runAtomically(endConnectionsOf(session.id, now));
};

const tokenHolderEndpoint = (provider: OAuthProviderPlugin) =>
  createAuthEndpoint.serverOnly(
    { body: Schema.toStandardSchemaV1(TokenRequest), method: "POST" },
    // @effect-diagnostics-next-line asyncFunction:off -- better-auth endpoints are Promise-returning handlers.
    async (ctx): Promise<TokenHolder | null> => {
      const api = getOAuthProviderApi(ctx, provider.options);
      let token = Option.none<typeof ActiveToken.Type>();

      try {
        token = decodeActiveToken(
          await api.validateAccessToken(ctx.body.token)
        );
      } catch (error) {
        if (!isAPIError(error)) {
          throw error;
        }
      }

      if (
        Option.isNone(token) ||
        !servesResource(token.value, ctx.body.resource)
      ) {
        return null;
      }

      const user = await ctx.context.internalAdapter.findUserById(
        token.value.sub
      );

      return user === null
        ? null
        : { email: user.email, id: user.id, name: user.name };
    }
  );

export interface McpResourcePlugin extends BetterAuthPlugin {
  readonly endpoints: {
    readonly oauthTokenHolder: ReturnType<typeof tokenHolderEndpoint>;
  };
}

export const mcpOAuth = (): readonly [BetterAuthPlugin, McpResourcePlugin] => {
  const provider = oauthProviderPlugin();

  return [
    provider,
    {
      endpoints: { oauthTokenHolder: tokenHolderEndpoint(provider) },
      hooks: {
        after: [
          {
            // @effect-diagnostics-next-line asyncFunction:off -- better-auth hooks are Promise-returning middleware.
            handler: createAuthMiddleware(async (ctx) => {
              const grant = decodeRefreshableGrant(ctx.context.returned);

              if (Option.isNone(grant)) {
                return;
              }

              const api = getOAuthProviderApi(ctx, provider.options);

              const stored = await api.hashToken(
                grant.value.access_token.slice(
                  OAUTH_ACCESS_TOKEN_PREFIX.length
                ),
                "access_token"
              );

              try {
                await ctx.context.adapter.update({
                  model: "oauthAccessToken",
                  update: { sessionId: null },
                  where: [{ field: "token", value: stored }],
                });
              } catch (error) {
                ctx.context.logger.warn(
                  "oauth access token stays bound to its browser session",
                  error instanceof Error ? error.name : "unknown error"
                );
              }
            }),
            matcher: (context) => context.path === TOKEN_PATH,
          },
        ],
        before: [
          {
            // @effect-diagnostics-next-line asyncFunction:off -- better-auth hooks are Promise-returning middleware.
            handler: createAuthMiddleware(async (ctx) => {
              await ensureResource(
                ctx.context.adapter,
                mcpResourceOf(ctx.context.baseURL)
              );
            }),
            matcher: (context) => RESOURCE_PATHS.has(context.path ?? ""),
          },
        ],
      },
      id: "mcp-resource",
      init: (context) => {
        const runAtomically = atomicRunnerOf(context.options.database);

        return {
          options: {
            databaseHooks: {
              session: {
                delete: {
                  // @effect-diagnostics-next-line asyncFunction:off -- better-auth database hooks are Promise-returning.
                  before: async (session) => {
                    await signOutOf(runAtomically, session);
                  },
                },
              },
            },
          },
        };
      },
    },
  ];
};
