import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";

import { VaultServer, type BodyFormat, type ValidatedRecord } from "@telepath-computer/vault-server";

import { folderEntryFor, isIgnored, loadConfig, type Config } from "./config.js";
import { writeFindings } from "./rules.js";

interface ServerState {
  config: Config;
  bodyFormat: (path: string) => BodyFormat;
}

const states = new WeakMap<VaultServer, ServerState>();

export interface ConfigWatchOptions {
  onReload?: (config: Config) => void;
  /** Receives the config finding's message, without a rule or file prefix. */
  onError?: (message: string) => void;
}

/** Compose vault-server with the conventions and write rules in an Autofile config. */
export function createVaultServer(root: string, config: Config): VaultServer {
  const state: ServerState = {
    config,
    bodyFormat: (path) => bodyFormatFor(state.config, path),
  };
  let server: VaultServer;
  server = new VaultServer({
    root,
    linkFormat: config.linkFormat,
    bodyFormat: state.bodyFormat,
    validate: (record) => validateWrite(server, state.config, record),
  });
  states.set(server, state);
  return server;
}

/** Adopt a newly parsed config in every dynamic part of a running server. */
export function configureVaultServer(server: VaultServer, config: Config): void {
  const state = states.get(server);
  if (state === undefined) throw new Error("VaultServer was not created by Autofile");
  const previous = state.config;
  state.config = config;
  try {
    server.configure({ linkFormat: config.linkFormat, bodyFormat: state.bodyFormat });
  } catch (error) {
    state.config = previous;
    throw error;
  }
}

/** Watch the config's directory so atomic editor replacements keep reloading. */
export function watchVaultConfig(
  root: string,
  server: VaultServer,
  opts: ConfigWatchOptions = {},
): FSWatcher {
  let pending = false;
  let reloading = false;
  let closed = false;
  let debounce: NodeJS.Timeout | undefined;
  const configPath = join(root, "autofile.yml");

  const reload = async (): Promise<void> => {
    if (reloading || closed) return;
    reloading = true;
    try {
      while (pending && !closed) {
        pending = false;
        const loaded = await loadConfig(configPath);
        if (!loaded.ok) {
          opts.onError?.(loaded.errors.map(({ message }) => message).join("; "));
          continue;
        }
        try {
          configureVaultServer(server, loaded.config);
          opts.onReload?.(loaded.config);
        } catch (error) {
          opts.onError?.(describe(error));
        }
      }
    } finally {
      reloading = false;
      if (pending && !closed) void reload();
    }
  };

  const watcher = watch(root, (_event, filename) => {
    if (filename?.toString() !== "autofile.yml") return;
    pending = true;
    if (debounce !== undefined) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = undefined;
      void reload();
    }, 25);
  });
  watcher.once("close", () => {
    closed = true;
    if (debounce !== undefined) clearTimeout(debounce);
  });
  watcher.on("error", (error) => opts.onError?.(describe(error)));
  return watcher;
}

function bodyFormatFor(config: Config, path: string): BodyFormat {
  return folderEntryFor(config, `${path}.md`)?.body === "raw" ? "raw" : "markdown";
}

function validateWrite(server: VaultServer, config: Config, record: ValidatedRecord): void {
  const governedPaths = [...server.paths].filter((path) => isGovernedPath(config, path));
  const findings = writeFindings(config, record, governedPaths);
  if (findings.length > 0) {
    throw new Error(findings.map(({ rule, message }) => `${rule}: ${message}`).join("; "));
  }
}

function isGovernedPath(config: Config, path: string): boolean {
  return path !== "autofile.yml" && !isIgnored(config, path) && folderEntryFor(config, path) !== undefined;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
