import { Config, Schema } from "effect";
import type { Option } from "effect";

export const PostHogRegion = Schema.Literals(["us", "eu"]);

export const PostHogKey = Schema.String.check(
  Schema.isPattern(/^phc_[A-Za-z0-9_-]{8,128}$/u)
);

export const PostHogConfig = Schema.Struct({
  key: PostHogKey,
  region: PostHogRegion,
});

export type PostHogConfigValue = typeof PostHogConfig.Type;

export const postHogConfigOf = (
  key: string | undefined,
  region: string | undefined
): Option.Option<PostHogConfigValue> =>
  Schema.decodeUnknownOption(PostHogConfig)({ key, region });

export const postHogHostOf = ({ region }: PostHogConfigValue) =>
  `https://${region}.i.posthog.com`;

export const postHogSetting = Config.all({
  key: Config.schema(
    Schema.Union([Schema.Literal(""), PostHogKey]),
    "POSTHOG_PROJECT_KEY"
  ).pipe(Config.withDefault("")),
  region: Config.schema(
    Schema.Union([Schema.Literal(""), PostHogRegion]),
    "POSTHOG_REGION"
  ).pipe(Config.withDefault("")),
}).pipe(Config.map(({ key, region }) => postHogConfigOf(key, region)));
