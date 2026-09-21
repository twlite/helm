import type { Database } from 'bun:sqlite';

export interface DatabaseDiagnostics {
  sqlite: boolean;
  fts5: boolean;
  sqliteVec: boolean;
  sqliteVersion?: string;
  sqliteVecVersion?: string;
  errors?: {
    fts5?: string;
    sqliteVec?: string;
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function hasFts5(database: Database): boolean {
  try {
    database.exec('CREATE VIRTUAL TABLE temp.helm_fts5_probe USING fts5(value)');
    database.exec('DROP TABLE temp.helm_fts5_probe');
    return true;
  } catch {
    try {
      database.exec('DROP TABLE IF EXISTS temp.helm_fts5_probe');
    } catch {
      // The probe is best effort and must not mask the original capability result.
    }
    return false;
  }
}

export function getDatabaseDiagnostics(database: Database): DatabaseDiagnostics {
  let sqliteVersion: string | undefined;
  try {
    const row = database.prepare('SELECT sqlite_version() AS version').get() as { version: string };
    sqliteVersion = row.version;
  } catch {
    return { sqlite: false, fts5: false, sqliteVec: false };
  }

  const errors: DatabaseDiagnostics['errors'] = {};
  let fts5 = false;
  try {
    fts5 = hasFts5(database);
  } catch (error) {
    errors.fts5 = errorMessage(error);
  }

  let sqliteVec = false;
  let sqliteVecVersion: string | undefined;
  try {
    const row = database.prepare('SELECT vec_version() AS version').get() as { version: string };
    sqliteVec = typeof row.version === 'string' && row.version.length > 0;
    sqliteVecVersion = row.version;
  } catch (error) {
    errors.sqliteVec = errorMessage(error);
  }

  return {
    sqlite: true,
    fts5,
    sqliteVec,
    sqliteVersion,
    ...(sqliteVecVersion === undefined ? {} : { sqliteVecVersion }),
    ...(Object.keys(errors).length === 0 ? {} : { errors }),
  };
}

export const databaseDiagnostics = getDatabaseDiagnostics;
