import {
  getOAuthProviderApi,
  oauthProvider,
} from "@better-auth/oauth-provider";
import {
  MCP_PATH,
  OAUTH_ACCESS_TOKEN_PREFIX,
  OAUTH_REFRESH_TOKEN_PREFIX,
} from "@rat-stack/core";
import type { BetterAuthPlugin, DBAdapter } from "better-auth";
import {
  createAuthEndpoint,
  createAuthMiddleware,
  isAPIError,
} from "better-auth/api";
import { Array, Option, Schema } from "effect";

export const OAUTH_CONNECT_PATH = "/account/connect";

export const MCP_SCOPE = "mcp";

export const OAUTH_SCOPES = [MCP_SCOPE, "offline_access"];

const RESOURCE_PATHS: ReadonlySet<string> = new Set([
  "/oauth2/authorize",
  "/oauth2/token",
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
    },
  ];
};
