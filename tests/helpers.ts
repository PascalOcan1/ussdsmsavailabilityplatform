import { config } from '../src/config.ts';
import { closeDb, get, openDb } from '../src/db.ts';
import { seedIfEmpty } from '../src/seed.ts';
import { cancelPendingTimers } from '../src/gateway.ts';

/** Fresh in-memory database with pilot seed data, delivery held for deterministic assertions. */
export function setupDb(): void {
  openDb(':memory:');
  config.autoDeliver = false;
  config.simulatedFailureRate = 0;
  seedIfEmpty();
}

export function teardownDb(): void {
  cancelPendingTimers();
  closeDb();
}

export function facilityId(code: string): number {
  return get<{ id: number }>('SELECT id FROM facilities WHERE code = ?', code)!.id;
}
