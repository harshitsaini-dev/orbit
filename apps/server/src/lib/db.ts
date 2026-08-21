import { createDatabase, type Database } from '@orbit/db';

let instance: Database | null = null;

/** One connection for the process. Tests can swap it via setDatabase(). */
export function db(): Database {
  instance ??= createDatabase();
  return instance;
}

export function setDatabase(next: Database): void {
  instance = next;
}
