/** Reads, validates, and writes Autofile's process-wide settings. */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const DEFAULT_HTTP_HOST = "127.0.0.1";
const DEFAULT_HTTP_PORT = 7319;
const settingNames = ["storage", "http.host", "http.port", "http.origins"] as const;

export type SettingName = typeof settingNames[number];

interface Config {
  storage?: string;
  http?: {
    host?: string;
    port?: number;
    origins?: string[];
  };
}

export interface HttpSettings {
  host: string;
  port: number;
  origins: string[];
}

export interface Settings {
  storage: string;
  http: HttpSettings;
}

function getAutofileHome(): string {
  return resolve(process.env.AUTOFILE_HOME ?? join(homedir(), ".autofile"));
}

/** Returns whether a command argument names one of Autofile's settings. */
export function isSettingName(value: string): value is SettingName {
  return (settingNames as readonly string[]).includes(value);
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
  if (!isObject(value)) throw new Error(`${configPath}: must contain a JSON object`);

  const storage = "storage" in value ? value.storage : undefined;
  if (storage !== undefined && typeof storage !== "string") {
    throw new Error(`${configPath}: storage must be a string`);
  }

  const httpValue = "http" in value ? value.http : undefined;
  if (httpValue !== undefined && !isObject(httpValue)) {
    throw new Error(`${configPath}: http must be a JSON object`);
  }
  const host = httpValue === undefined || !("host" in httpValue) ? undefined : httpValue.host;
  if (host !== undefined && (typeof host !== "string" || host.length === 0)) {
    throw new Error(`${configPath}: http.host must be a non-empty string`);
  }
  const port = httpValue === undefined || !("port" in httpValue) ? undefined : httpValue.port;
  if (port !== undefined && !isPort(port)) {
    throw new Error(`${configPath}: http.port must be an integer from 1 to 65535`);
  }
  const originsValue = httpValue === undefined || !("origins" in httpValue)
    ? undefined
    : httpValue.origins;
  let origins: string[] | undefined;
  if (originsValue !== undefined && !Array.isArray(originsValue)) {
    throw new Error(
      `${configPath}: http.origins must contain only http or https origins without paths`,
    );
  }
  if (originsValue !== undefined) {
    origins = [];
    for (const origin of originsValue) {
      const normalized = typeof origin === "string" ? normalizeHttpOrigin(origin) : undefined;
      if (normalized === undefined) {
        throw new Error(
          `${configPath}: http.origins must contain only http or https origins without paths`,
        );
      }
      origins.push(normalized);
    }
  }

  return {
    ...(storage === undefined ? {} : { storage }),
    ...(host === undefined && port === undefined && origins === undefined
      ? {}
      : {
        http: {
          ...(host === undefined ? {} : { host }),
          ...(port === undefined ? {} : { port }),
          ...(origins === undefined ? {} : { origins }),
        },
      }),
  };
}

async function writeConfig(config: Config): Promise<void> {
  const autofileHome = getAutofileHome();
  await mkdir(autofileHome, { recursive: true });
  await writeFile(
    join(autofileHome, "config.json"),
    `${JSON.stringify(canonicalConfig(config), null, 2)}\n`,
    "utf8",
  );
}

/** Returns every effective setting, applying defaults to settings that are absent. */
export async function getSettings(): Promise<Settings> {
  const config = await readConfig();
  return {
    storage: config.storage ?? join(getAutofileHome(), "data"),
    http: {
      host: config.http?.host ?? DEFAULT_HTTP_HOST,
      port: config.http?.port ?? DEFAULT_HTTP_PORT,
      origins: [...(config.http?.origins ?? [])],
    },
  };
}

/** Returns the configured data folder, or the default folder when unset. */
export async function getStorage(): Promise<string> {
  return (await getSettings()).storage;
}

/** Returns a setting as the lines its CLI `get` command prints. */
export async function getSetting(name: SettingName): Promise<string[]> {
  const settings = await getSettings();
  switch (name) {
    case "storage": return [settings.storage];
    case "http.host": return [settings.http.host];
    case "http.port": return [String(settings.http.port)];
    case "http.origins": return settings.http.origins;
  }
}

/** Validates and stores one setting while preserving every other setting. */
export async function setSetting(name: SettingName, values: string[]): Promise<void> {
  const config = await readConfig();
  switch (name) {
    case "storage": {
      const [folder] = values;
      if (values.length !== 1 || folder === undefined || folder === "") {
        throw new Error("storage must be a non-empty folder");
      }
      config.storage = resolveStorage(folder);
      break;
    }
    case "http.host": {
      const [host] = values;
      if (values.length !== 1 || host === undefined || host === "") {
        throw new Error("http.host must be a non-empty string");
      }
      config.http = { ...config.http, host };
      break;
    }
    case "http.port": {
      const [value] = values;
      if (values.length !== 1 || value === undefined) {
        throw new Error("http.port must be an integer from 1 to 65535");
      }
      config.http = { ...config.http, port: parsePort(value) };
      break;
    }
    case "http.origins": {
      if (values.length === 0) {
        throw new Error("http.origins must contain at least one origin");
      }
      config.http = { ...config.http, origins: values.map(parseOrigin) };
      break;
    }
  }
  await writeConfig(config);
}

/** Removes one setting so its default applies, preserving its siblings. */
export async function unsetSetting(name: SettingName): Promise<void> {
  const config = await readConfig();
  let changed = false;
  if (name === "storage") {
    changed = config.storage !== undefined;
    delete config.storage;
  } else if (config.http !== undefined) {
    const key = name.slice("http.".length) as keyof NonNullable<Config["http"]>;
    changed = config.http[key] !== undefined;
    delete config.http[key];
    if (Object.keys(config.http).length === 0) delete config.http;
  }
  if (changed) await writeConfig(config);
}

/** Parses a CLI port value and rejects anything outside the TCP port range. */
export function parsePort(value: string): number {
  if (!/^\d+$/u.test(value)) {
    throw new Error("http.port must be an integer from 1 to 65535");
  }
  const port = Number(value);
  if (!isPort(port)) throw new Error("http.port must be an integer from 1 to 65535");
  return port;
}

function resolveStorage(folder: string): string {
  if (folder === "~") return homedir();
  return folder.startsWith("~/") ? resolve(homedir(), folder.slice(2)) : resolve(folder);
}

function parseOrigin(value: string): string {
  const origin = normalizeHttpOrigin(value);
  if (origin === undefined) {
    throw new Error("http.origins must contain only http or https origins without paths");
  }
  return origin;
}

/** Returns the URL-normalized form of a strict HTTP origin, or undefined when invalid. */
export function normalizeHttpOrigin(value: string): string | undefined {
  const match = /^https?:\/\/(.+)$/iu.exec(value);
  if (match === null) return undefined;
  const authority = match[1];
  if (
    authority === undefined
    || authority.trim() !== authority
    || /[\s/\\?#@]/u.test(authority)
  ) {
    return undefined;
  }
  if (authority.startsWith("[")) {
    const closingBracket = authority.indexOf("]");
    if (
      closingBracket <= 1
      || (authority.slice(closingBracket + 1) !== ""
        && !/^:\d+$/u.test(authority.slice(closingBracket + 1)))
    ) {
      return undefined;
    }
  } else {
    const firstColon = authority.indexOf(":");
    if (
      firstColon !== -1
      && (firstColon !== authority.lastIndexOf(":")
        || !/^\d+$/u.test(authority.slice(firstColon + 1)))
    ) {
      return undefined;
    }
  }
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:")
      || url.hostname === ""
      || url.username !== ""
      || url.password !== ""
    ) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

function isPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65_535;
}

function canonicalConfig(config: Config): Config {
  const host = config.http?.host;
  const port = config.http?.port;
  const origins = config.http?.origins;
  return {
    ...(config.storage === undefined ? {} : { storage: config.storage }),
    ...(host === undefined && port === undefined && origins === undefined
      ? {}
      : {
        http: {
          ...(host === undefined ? {} : { host }),
          ...(port === undefined ? {} : { port }),
          ...(origins === undefined ? {} : { origins }),
        },
      }),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
