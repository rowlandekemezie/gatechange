// @effect-diagnostics nodeBuiltinImport:off -- local-only-state.ts is standalone Node tooling that reads one `alchemy state read` row on stdin.
import { readFileSync } from "node:fs";

import { Schema } from "effect";

const StateRow = Schema.Struct({
  old: Schema.optional(Schema.Unknown),
  providerMode: Schema.optional(Schema.String),
  status: Schema.Literals([
    "creating",
    "created",
    "updating",
    "updated",
    "deleting",
    "replacing",
    "replaced",
  ]),
});

const decodeRow = Schema.decodeUnknownSync(StateRow);

const generationModes = (row: typeof StateRow.Type): readonly string[] => {
  const mode = row.providerMode ?? "unstamped";

  return row.status === "replacing" || row.status === "replaced"
    ? [mode, ...generationModes(decodeRow(row.old))]
    : [mode];
};

const modes = generationModes(decodeRow(JSON.parse(readFileSync(0, "utf-8"))));

if (modes.some((mode) => mode !== "local")) {
  process.stderr.write(
    `${process.argv[2] ?? "row"} is not local-mode: ${modes.join(" <- ")}\n`
  );
  process.exit(1);
}
