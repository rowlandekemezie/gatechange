// @effect-diagnostics nodeBuiltinImport:off -- local-only-state.ts is standalone Node tooling that reads one `alchemy state read` row on stdin.
import { readFileSync } from "node:fs";

import { Schema } from "effect";

interface StateRowValue {
  readonly old?: StateRowValue | undefined;
  readonly providerMode?: string | undefined;
}

const StateRow: Schema.Codec<StateRowValue> = Schema.Struct({
  old: Schema.optional(Schema.suspend(() => StateRow)),
  providerMode: Schema.optional(Schema.String),
});

const generations = (row: StateRowValue): readonly StateRowValue[] =>
  row.old === undefined ? [row] : [row, ...generations(row.old)];

const row = Schema.decodeUnknownSync(StateRow)(
  JSON.parse(readFileSync(0, "utf-8"))
);

const modes = generations(row).map(
  (generation) => generation.providerMode ?? "unstamped"
);

if (modes.some((mode) => mode !== "local")) {
  process.stderr.write(
    `${process.argv[2] ?? "row"} is not local-mode: ${modes.join(" <- ")}\n`
  );
  process.exit(1);
}
