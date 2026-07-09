#!/usr/bin/env node
import { createServer } from "node:http";
import { createApp } from "./app.js";
import { parseCliArgs } from "./cliArgs.js";
import { createRecordService } from "./recordService.js";

async function main(): Promise<void> {
  const config = parseCliArgs(process.argv.slice(2));
  const recordService = await createRecordService(config.vaults);
  const app = createApp({ recordService });
  const server = createServer(app);

  server.listen(config.port, config.host, () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : config.port;
    process.stdout.write(`autofile-server listening on http://${config.host}:${port}\n`);
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
