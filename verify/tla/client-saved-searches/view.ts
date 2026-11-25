interface Delete {
  readonly id: string;
}

interface Vars {
  readonly deletes: readonly Delete[];
  readonly filters: string;
  readonly gone: readonly string[];
  readonly list: readonly string[];
  readonly listState: string;
  readonly save: string;
  readonly server: readonly string[];
}

export const title = "Saved searches: save, list and delete";

const showsDeleted = (v: Vars) =>
  v.listState === "Loaded" && v.list.some((id) => v.gone.includes(id));

const falseSaved = (v: Vars) =>
  v.save === "Saved" && !v.server.includes(v.filters);

const saveLabels = new Map<string, string>([
  ["Failed", "Board shows a save problem"],
  ["Saved", "Board says Saved"],
  ["Saving", "Board says Saving"],
]);

export const state = (v: Vars) => {
  if (showsDeleted(v)) {
    return "List shows a deleted search";
  }

  if (falseSaved(v)) {
    return "Says Saved under filters that are not saved";
  }

  const saving = saveLabels.get(v.save);

  if (saving !== undefined) {
    return saving;
  }

  return v.deletes.length > 0 ? "Deleting a search" : "Idle";
};

export const group = (v: Vars) =>
  showsDeleted(v) || falseSaved(v) ? "wrong" : "fine";

export const colors = { fine: "teal", wrong: "orange" };

const labels = new Map<string, string | null>([
  ["DeleteConfirmed", "the delete is confirmed"],
  ["Done", null],
  ["ListArrives", "the saved list arrives"],
  ["ReaderChangesFilters", "you change a filter"],
  ["ReaderDeletes", "you tap Delete"],
  ["ReaderOpensAccount", "you open your account page"],
  ["ReaderSavesSearch", "you tap Email me new matches"],
  ["SaveAnswered", "the save answers"],
  ["ServerDeletes", "the server deletes it"],
  ["ServerReadsList", "the server reads your list"],
  ["ServerSaves", "the server saves it"],
]);

export const step = (action: string) =>
  labels.has(action) ? (labels.get(action) ?? null) : action;
