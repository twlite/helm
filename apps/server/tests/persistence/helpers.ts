import { PersistenceDatabase } from '../../src/db/database';

export function testDatabase(): PersistenceDatabase {
  return new PersistenceDatabase(':memory:');
}

export function closeDatabase(database: PersistenceDatabase): void {
  database.close();
}
