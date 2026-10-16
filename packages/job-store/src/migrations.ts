import { fileURLToPath } from "node:url";

export const jobStoreMigrationDirectory = (): string =>
  fileURLToPath(new URL("../migrations/", import.meta.url));
