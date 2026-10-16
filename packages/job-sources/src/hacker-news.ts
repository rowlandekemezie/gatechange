import { Array, Effect, Option, pipe, Schema } from "effect";
import { classifyRole, FeedUnavailable } from "@rat-stack/core";
import type { Posting } from "@rat-stack/core";

import { fetchJson } from "./http.js";
import { textOfHtml } from "./parse.js";

const ALGOLIA = "https://hn.algolia.com/api/v1/search_by_date";

const MAX_COMMENTS = 1000;

const Story = Schema.Struct({
  created_at_i: Schema.Finite,
  objectID: Schema.NonEmptyString,
  title: Schema.String,
});

const Comment = Schema.Struct({
  comment_text: Schema.optional(Schema.NullOr(Schema.String)),
  created_at_i: Schema.Finite,
  objectID: Schema.NonEmptyString,
  parent_id: Schema.optional(Schema.NullOr(Schema.Finite)),
});

const Hits = Schema.Struct({ hits: Schema.Array(Schema.Unknown) });

const salaryPattern = /(?:\$|€|£|usd|cad)\s?\d|\d{2,3}\s?k\b/iu;

const firstLine = (html: string) => {
  const [head = ""] = html.split(/<p>/iu);

  return textOfHtml(head);
};

export const postingOfComment = (commentHtml: string, id: string, createdAtSeconds: number) => {
  const segments = Array.map(firstLine(commentHtml).split("|"), (segment) => segment.trim());
  const [company = "", ...rest] = segments;

  return Option.map(
    Array.findFirst(rest, (segment) => Option.isSome(classifyRole(segment))),
    (title): Posting => ({
      company,
      externalId: id,
      location: pipe(
        rest,
        Array.filter((segment) => segment !== title && !salaryPattern.test(segment)),
        Array.join(" | ")
      ),
      postedAt: createdAtSeconds * 1000,
      salary: Option.getOrNull(Array.findFirst(rest, (segment) => salaryPattern.test(segment))),
      title,
      url: `https://news.ycombinator.com/item?id=${id}`,
      workplace: "Unspecified",
    })
  );
};

export const hackerNewsPostings = (feed: string) =>
  Effect.gen(function* whoIsHiring() {
    const stories = yield* fetchJson(
      feed,
      `${ALGOLIA}?tags=story,author_whoishiring&hitsPerPage=20`,
      Hits
    );

    const story = yield* pipe(
      stories.hits,
      Array.map((item) => Schema.decodeUnknownOption(Story)(item)),
      Array.getSomes,
      Array.findFirst((candidate) => /who is hiring/iu.test(candidate.title)),
      Option.match({
        onNone: () =>
          Effect.fail(new FeedUnavailable({ feed, message: "No 'Who is hiring?' thread found" })),
        onSome: Effect.succeed,
      })
    );

    const comments = yield* fetchJson(
      feed,
      `${ALGOLIA}?tags=comment,story_${story.objectID}&hitsPerPage=${MAX_COMMENTS}`,
      Hits
    );

    return pipe(
      comments.hits,
      Array.map((item) => Schema.decodeUnknownOption(Comment)(item)),
      Array.getSomes,
      Array.filter((comment) => String(comment.parent_id ?? "") === story.objectID),
      Array.map((comment) =>
        postingOfComment(comment.comment_text ?? "", comment.objectID, comment.created_at_i)
      ),
      Array.getSomes
    );
  });
