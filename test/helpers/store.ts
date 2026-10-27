/** Keeps legacy acceptance fixtures readable while every operation uses Autofile. */

import { dirname } from "node:path";

import { getStorage } from "../../dist/config.js";
import { Autofile } from "../../dist/index.js";
import { buildResources } from "../../dist/mcp-resources.js";
import { buildTools } from "../../dist/mcp-tools.js";

export type { JsonObject, JsonValue } from "../../dist/index.js";

/** The MCP adapters and their one underlying library instance. */
export type Store = ReturnType<typeof buildTools> & ReturnType<typeof buildResources> & {
  autofile: Autofile;
};

/** Creates an initialized test fixture using the existing MCP result vocabulary. */
export async function openStore(options: {
  dataFolder?: string;
  writeLockPath?: string;
} = {}): Promise<Store> {
  const dataFolder = options.dataFolder ?? await getStorage();
  const previousHome = process.env.AUTOFILE_HOME;
  let autofile: Autofile;
  try {
    // The production class captures the existing AUTOFILE_HOME lock location.
    // A temporary environment setting keeps each historical fixture isolated.
    if (options.writeLockPath !== undefined) process.env.AUTOFILE_HOME = dirname(options.writeLockPath);
    autofile = new Autofile({ folder: dataFolder });
  } finally {
    if (previousHome === undefined) delete process.env.AUTOFILE_HOME;
    else process.env.AUTOFILE_HOME = previousHome;
  }
  await autofile.types.list();
  const tools = buildTools(autofile);
  return {
    ...tools,
    ...buildResources(autofile),
    autofile,
  };
}
