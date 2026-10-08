/**
 * Resolves Autofile's settings folder and reads or writes its sole setting.
 * The data folder remains separate so later store code does not need to know
 * where configuration is kept.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

interface Config {
  storage?: string;
}

function getAutofileHome(): string {
  return resolve(process.env.AUTOFILE_HOME ?? join(homedir(), ".autofile"));
}

/** Returns the path shared stores use to serialize writes between processes. */
export function getWriteLockPath(): string {
  return join(getAutofileHome(), "write.lock");
}

async function readConfig(): Promise<Config> {
  const configPath = join(getAutofileHome(), "config.json");
  let text: string;
  try {
    text = await readFile(configPath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${configPath}: invalid JSON`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${configPath}: must contain a JSON object`);
  }
  const storage = "storage" in value ? value.storage : undefined;
  if (storage !== undefined && typeof storage !== "string") {
    throw new Error(`${configPath}: storage must be a string`);
  }
  return storage === undefined ? {} : { storage };
}

async function writeConfig(config: Config): Promise<void> {
  const autofileHome = getAutofileHome();
  await mkdir(autofileHome, { recursive: true });
  await writeFile(join(autofileHome, "config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

/** Returns the configured data folder, or the default folder when unset. */
export async function getStorage(): Promise<string> {
  const config = await readConfig();
  return config.storage ?? join(getAutofileHome(), "data");
}

/** Resolves and stores a data folder without creating or moving it. */
export async function setStorage(folder: string): Promise<void> {
  const storage = folder === "~"
    ? homedir()
    : folder.startsWith("~/")
      ? resolve(homedir(), folder.slice(2))
      : resolve(folder);
  await writeConfig({ storage });
}

/** Removes the configured data folder so the default applies again. */
export async function unsetStorage(): Promise<void> {
  const config = await readConfig();
  if (config.storage === undefined) return;
  await writeConfig({});
}
