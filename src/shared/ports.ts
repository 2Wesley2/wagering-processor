/**
 * Portas transversais usadas pela camada de aplicação. Implementações ficam
 * na infraestrutura (platform/); o domínio e a aplicação só conhecem estas
 * interfaces.
 */

/** Handle opaco de uma transação SQL em andamento (D19: dono único = o caso de uso). */
export interface DatabaseTransaction {
  readonly kind: 'tx';
}

export interface UnitOfWork {
  /** Executa `fn` numa transação READ COMMITTED; commit só se `fn` resolver. */
  run<T>(work: (databaseTransaction: DatabaseTransaction) => Promise<T>): Promise<T>;
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  /** UUIDv7 (D14). */
  next(): string;
}

export const systemClock: Clock = { now: () => new Date() };
export const uuidV7Generator: IdGenerator = { next: () => Bun.randomUUIDv7() };
