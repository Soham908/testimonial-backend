// The only file that actually starts the poll loop - see the comment on
// startWorker in src/worker.ts for why this is split out rather than an
// import-time side effect there.
import { startWorker } from "./worker";

startWorker();
