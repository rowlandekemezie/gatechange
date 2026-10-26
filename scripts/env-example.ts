// @effect-diagnostics nodeBuiltinImport:off -- This generator runs as Node tooling and reads repository files directly.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const SCHEMAS = [".env.schema", "apps/api/.env.schema"] as const;

const TARGET = ".env.example";

const HEADER = [
  "# Generated from .env.schema and apps/api/.env.schema by `pnpm env:example`.",
  "# Copy to .env.local and fill in only what you need. Every value is optional",
  "# except where its note says otherwise. Never commit .env.local.",
];

const bodyOf = (schema: string) => {
  const lines = readFileSync(schema, "utf-8").split("\n");
  const start = lines.indexOf("# ---") + 1;

  return lines
    .slice(start)
    .filter((line) => !line.startsWith("# @"))
    .map((line) => line.replace(/^(?<key>[A-Z][A-Z0-9_]*)=.*$/u, "$<key>="));
};

const example = `${[
  ...HEADER,
  ...SCHEMAS.flatMap((schema) => ["", `# ${schema}`, ...bodyOf(schema)]),
]
  .join("\n")
  .replaceAll(/\n{3,}/gu, "\n\n")
  .trimEnd()}\n`;

if (process.argv.includes("--check")) {
  if (!existsSync(TARGET) || readFileSync(TARGET, "utf-8") !== example) {
    process.stderr.write(
      `${TARGET} is stale. Run pnpm env:example and commit the result.\n`
    );
    process.exit(1);
  }
} else {
  writeFileSync(TARGET, example);
}
