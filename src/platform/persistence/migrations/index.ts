import { M0001_FINANCIAL_SCHEMA } from './0001-financial-schema.ts';
import { M0002_REVERSALS_AND_PENDING_REFERENCES } from './0002-reversals-and-pending-references.ts';
import { M0003_INBOX_AND_DEAD_LETTER } from './0003-inbox-and-dead-letter.ts';
import { M0004_RETENTION_AND_PROJECTION } from './0004-retention-and-projection.ts';
import type { RegisteredMigration } from './sql-migration.ts';

/**
 * Lista explícita de migrations, em ordem (sem descoberta por glob no Bun).
 * F2: schema financeiro. F4: reversões (P1 = C, P2 = (c)) e agenda de pendências. F5: inbox e
 * dead-letter. F6: retenção (purga controlada) e projeção de referência dos eventos. Uma migration aplicada nunca é editada.
 */
export const MIGRATIONS: readonly RegisteredMigration[] = [
  M0001_FINANCIAL_SCHEMA,
  M0002_REVERSALS_AND_PENDING_REFERENCES,
  M0003_INBOX_AND_DEAD_LETTER,
  M0004_RETENTION_AND_PROJECTION,
];
