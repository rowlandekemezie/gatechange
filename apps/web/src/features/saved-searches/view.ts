import type { SavedSearchValue } from "@rat-stack/core/contracts";
import { Array, Option, pipe, Schema } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import { defineView } from "foldkit/submodel";

import { SessionState } from "../../client/account/model.js";
import type { SessionStateValue } from "../../client/account/model.js";
import { regionGroupChip, roleChip } from "../../client/board/copy.js";
import type { FiltersValue } from "../../client/board/filters.js";
import { accountRouter, boardUrl } from "../../client/route.js";
import { Message } from "../../client/saved-searches/message.js";
import type { MessageValue } from "../../client/saved-searches/message.js";
import {
  boardFiltersOf,
  SaveState,
  searchFiltersOf,
  SearchesState,
} from "../../client/saved-searches/model.js";
import type { ModelValue } from "../../client/saved-searches/model.js";

interface SaveControlInputs {
  readonly filters: FiltersValue;
  readonly session: SessionStateValue;
}

const accountHref = accountRouter({ notice: "None" });

export const searchLabel = (search: SavedSearchValue) => {
  const filters = boardFiltersOf(search);
  const roles = filters.roles.map(roleChip).join(", ");
  const places = filters.regionGroups.map(regionGroupChip).join(", ");

  const text =
    search.filters.search === "" ? "" : ` matching "${search.filters.search}"`;

  return `${roles}, ${places}${text}`;
};

const saveButton = (
  h: HtmlBuilder<MessageValue>,
  filters: FiltersValue,
  isSaving: boolean
): Html =>
  pipe(
    searchFiltersOf(filters),
    Option.match({
      onNone: () => h.empty,
      onSome: (searchFilters) =>
        h.button(
          [
            h.Type("button"),
            h.Class("mark save-search"),
            h.Disabled(isSaving),
            h.OnClick(Message.ClickedSaveSearch({ filters: searchFilters })),
          ],
          [isSaving ? "Saving…" : "Email me new matches weekly"]
        ),
    })
  );

const signedInControl = (
  model: ModelValue,
  filters: FiltersValue,
  h: HtmlBuilder<MessageValue>
): readonly Html[] =>
  SaveState.match<readonly Html[]>(model.save, {
    Failed: ({ message }) => [
      saveButton(h, filters, false),
      h.span([h.Class("save-search-note"), h.Role("alert")], [message]),
    ],
    Idle: () => [saveButton(h, filters, false)],
    Saved: () => [
      h.span(
        [h.Class("save-search-note"), h.Role("status")],
        [
          "Saved. New matches arrive by email each week. ",
          h.a([h.Href(accountHref)], ["Manage saved searches"]),
        ]
      ),
    ],
    Saving: () => [saveButton(h, filters, true)],
  });

export const saveSearchControl = defineView<
  ModelValue,
  MessageValue,
  SaveControlInputs
>((model, { filters, session }, h) =>
  Option.isNone(searchFiltersOf(filters))
    ? h.empty
    : h.div(
        [h.Class("save-search-row")],
        Schema.is(SessionState.SignedIn)(session)
          ? signedInControl(model, filters, h)
          : [
              h.a(
                [h.Class("save-search-note"), h.Href(accountHref)],
                ["Sign in to get new matches by email"]
              ),
            ]
      )
);

const searchItem = (
  model: ModelValue,
  h: HtmlBuilder<MessageValue>,
  search: SavedSearchValue
): Html => {
  const isDeleting = Array.contains(model.deleting, search.id);

  return h.keyed("li")(
    search.id,
    [h.Class("saved-search")],
    [
      h.a(
        [
          h.Class("saved-search-label"),
          h.Href(boardUrl(boardFiltersOf(search))),
        ],
        [searchLabel(search)]
      ),
      h.button(
        [
          h.Type("button"),
          h.Class("mark"),
          h.Disabled(isDeleting),
          h.AriaLabel(`Delete saved search: ${searchLabel(search)}`),
          h.OnClick(Message.ClickedDeleteSearch({ id: search.id })),
        ],
        [isDeleting ? "Deleting…" : "Delete"]
      ),
    ]
  );
};

export const savedSearchesPanel = defineView<ModelValue, MessageValue>(
  (model, h) =>
    h.section(
      [h.Class("saved-searches"), h.AriaLabelledBy("saved-searches-title")],
      [
        h.h2([h.Id("saved-searches-title")], ["Weekly email digests"]),
        ...SearchesState.match<readonly Html[]>(model.searches, {
          Failed: () => [
            h.p(
              [h.Class("status"), h.Role("alert")],
              ["We could not load your saved searches. Reload to try again."]
            ),
          ],
          Loaded: ({ searches }) =>
            Array.isReadonlyArrayEmpty(searches)
              ? [
                  h.p(
                    [h.Class("account-lede")],
                    [
                      "No saved searches yet. Pick roles and places on the board, then choose “Email me new matches weekly”.",
                    ]
                  ),
                ]
              : [
                  h.p(
                    [h.Class("account-lede")],
                    [
                      "Once a week we email you roles that are new since your last digest. Every email has an unsubscribe link.",
                    ]
                  ),
                  h.ul(
                    [h.Class("saved-search-list")],
                    searches.map((search) => searchItem(model, h, search))
                  ),
                ],
          Loading: () => [
            h.p(
              [h.Class("status"), h.Role("status")],
              ["Loading your saved searches…"]
            ),
          ],
          NotAsked: () => [],
        }),
      ]
    )
);
