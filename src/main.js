import { createWorkspaceServer } from "./server.js";

const app = await createWorkspaceServer();
const address = await app.listen(Number(process.env.PORT || 4173));
console.log(`Generation Workspace: ${address}`);
console.log("Press Ctrl+C to stop and clean temporary files.");

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await app.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
