import { Option, Schema } from "effect";
import { defineTaggedUnion } from "foldkit/schema";

const AUTHORIZE_PATH = "/api/auth/oauth2/authorize";

const SIGNING_PARAMS: ReadonlySet<string> = new Set([
  "ba_iat",
  "ba_param",
  "ba_pl",
  "exp",
  "sig",
]);

export const ConnectRequest = Schema.Struct({
  authorizePath: Schema.String,
  clientId: Schema.String,
  redirectHost: Schema.String,
  signed: Schema.String,
});

export type ConnectRequestValue = typeof ConnectRequest.Type;

export const ClientName = defineTaggedUnion({
  Loading: {},
  Named: { name: Schema.String },
  NotAsked: {},
  Unnamed: {},
});

export type ClientNameValue = typeof ClientName.Type;

export const ConnectState = defineTaggedUnion({
  Answering: {
    accept: Schema.Boolean,
    client: ClientName,
    request: ConnectRequest,
  },
  Failed: { client: ClientName, request: ConnectRequest },
  Invalid: {},
  Ready: { client: ClientName, request: ConnectRequest },
});

export type ConnectStateValue = typeof ConnectState.Type;

export const Model = Schema.Struct({ state: ConnectState });

export type ModelValue = typeof Model.Type;

const withoutLoginPrompt = (prompt: string) =>
  prompt
    .split(" ")
    .filter((value) => value !== "" && value !== "login")
    .join(" ");

const authorizeQueryOf = (params: URLSearchParams) => {
  const authorize = new URLSearchParams();

  for (const [key, value] of params) {
    if (SIGNING_PARAMS.has(key)) {
      continue;
    }

    const kept = key === "prompt" ? withoutLoginPrompt(value) : value;

    if (kept !== "") {
      authorize.append(key, kept);
    }
  }

  return authorize.toString();
};

export const connectRequestOf = (
  search: string
): Option.Option<ConnectRequestValue> => {
  const params = new URLSearchParams(search);
  const clientId = params.get("client_id");
  const redirectHost = URL.parse(params.get("redirect_uri") ?? "")?.host;

  return clientId === null ||
    redirectHost === undefined ||
    redirectHost === "" ||
    !params.has("sig")
    ? Option.none()
    : Option.some({
        authorizePath: `${AUTHORIZE_PATH}?${authorizeQueryOf(params)}`,
        clientId,
        redirectHost,
        signed: params.toString(),
      });
};
