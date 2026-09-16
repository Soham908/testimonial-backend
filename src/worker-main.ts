// Defensive fallback, not the primary mechanism - see the matching comment
// in src/index.ts. `npm run worker` already passes --env-file=.env, but
// this is the module that would actually run if something ever launches
// the worker directly (e.g. `node dist/worker-main.js`) without that
// wrapper. Must be the first import.
import "dotenv/config";

// The only file that actually starts the poll loop - see the comment on
// startWorker in src/worker.ts for why this is split out rather than an
// import-time side effect there.
import { startWorker } from "./worker";

startWorker();
