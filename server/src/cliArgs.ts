import { homedir } from "node:os";
import path from "node:path";

export interface VaultArg {
  name: string;
  root: string;
}

export interface CliConfig {
  host: string;
  port: number;
  vaults: VaultArg[];
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8766;
const VAULT_NAME_PATTERN = /^[a-z0-9-]+$/;

export function parseCliArgs(args: string[]): CliConfig {
  const config: CliConfig = {
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    vaults: []
  };

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];

    if (flag === "--vault") {
      const value = readFlagValue(args, index, flag);
      const vault = parseVault(value);
      if (config.vaults.some((existing) => existing.name === vault.name)) {
        throw new Error(`duplicate vault name: ${vault.name}`);
      }
      config.vaults.push(vault);
      index += 1;
      continue;
    }

    if (flag === "--host") {
      const value = readFlagValue(args, index, flag);
      if (value.trim() === "") {
        throw new Error("host must not be empty");
      }
      config.host = value;
      index += 1;
      continue;
    }

    if (flag === "--port") {
      const value = readFlagValue(args, index, flag);
      config.port = parsePort(value);
      index += 1;
      continue;
    }

    throw new Error(`unknown flag: ${flag}`);
  }

  if (config.vaults.length === 0) {
    throw new Error("at least one --vault is required");
  }

  return config;
}

function readFlagValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseVault(value: string): VaultArg {
  const separator = value.indexOf("=");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error("vault must use name=path syntax");
  }

  const name = value.slice(0, separator);
  if (!VAULT_NAME_PATTERN.test(name)) {
    throw new Error(`vault name must match [a-z0-9-]+: ${name}`);
  }

  const root = expandLeadingTilde(value.slice(separator + 1));
  return { name, root };
}

function expandLeadingTilde(root: string): string {
  if (root === "~") {
    return homedir();
  }
  if (root.startsWith("~/")) {
    return path.join(homedir(), root.slice(2));
  }
  return root;
}

function parsePort(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error("port must be an integer");
  }

  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("port must be between 1 and 65535");
  }

  return port;
}
