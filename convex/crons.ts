import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval(
  "expire funded listening sessions",
  { minutes: 5 },
  internal.sessions.sweepExpired,
  {},
);

crons.interval(
  "retry provider reconciliation and key cleanup",
  { minutes: 7 },
  internal.sessions.retryPendingFinalization,
  {},
);

crons.daily(
  "delete reconciled product sessions after 90 days",
  { hourUTC: 3, minuteUTC: 17 },
  internal.sessions.deleteOldReconciled,
  {},
);

export default crons;
