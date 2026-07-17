export const stats = {
  startedAt: new Date(),
  lastCycleAt: null,
  lastCycleStatus: 'pending', // 'pending' | 'ok' | 'error'
  lastCycleDurationMs: null,
  cyclesTotal: 0,
  emailsProcessed: 0,
  emailsSkipped: 0,
  lastError: null,
};
