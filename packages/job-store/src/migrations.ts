import { fileURLToPath } from "node:url";

export const jobStoreMigrationDirectory = (): string =>
  import.meta.url ? fileURLToPath(new URL("../migrations/", import.meta.url).href) : ".";
