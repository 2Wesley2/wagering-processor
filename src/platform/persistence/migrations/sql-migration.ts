import { createHash } from 'node:crypto';
import type { Constructor } from '@mikro-orm/core';
import { Migration } from '@mikro-orm/migrations';

/** Migration escrita à mão em SQL, reversível (§4: versionadas e reversíveis). */
export interface SqlMigrationDefinition {
  readonly name: string;
  readonly up: readonly string[];
  readonly down: readonly string[];
}

export interface RegisteredMigration {
  readonly name: string;
  readonly checksum: string;
  readonly migrationClass: Constructor<Migration>;
}

/** Checksum estável do SQL de subida: editar uma migration já aplicada é detectado (D20). */
export function checksumOf(definition: SqlMigrationDefinition): string {
  return `v1:${createHash('sha256').update(definition.up.join('\n;\n')).digest('hex')}`;
}

export function sqlMigration(definition: SqlMigrationDefinition): RegisteredMigration {
  class SqlMigration extends Migration {
    override up(): void {
      for (const statement of definition.up) this.addSql(statement);
    }

    override down(): void {
      for (const statement of definition.down) this.addSql(statement);
    }
  }
  Object.defineProperty(SqlMigration, 'name', { value: definition.name });
  return {
    name: definition.name,
    checksum: checksumOf(definition),
    migrationClass: SqlMigration,
  };
}
