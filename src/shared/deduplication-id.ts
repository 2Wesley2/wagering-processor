import { createHash } from 'node:crypto';

/**
 * Construção de MessageDeduplicationId (§10, plano D35/D36/D38). Limite da AWS: até 128
 * caracteres, só alfanuméricos e a pontuação ASCII ``!"#$%&'()*+,-./:;<=>?@[\]^_`{|}~``. O
 * MiniStack não valida esse limite (CONF-21), então a garantia é desta função, verificada pelo
 * UT-14.
 *
 * - Valores externos (messageId do produtor, até 200 caracteres e qualquer símbolo) nunca entram
 *   crus: `dedupId(tipo, partes)` = `${tipo}:` + 40 hex do sha256 das partes, com cada parte
 *   prefixada pelo próprio tamanho (sem ambiguidade de separador).
 * - Sufixos numéricos identificam a tentativa (`:a2`, `:r3`): a MESMA tentativa reusa o mesmo id
 *   (o FIFO absorve o reenvio na janela de 5 min); uma tentativa nova gera id novo.
 * - Ids internos já seguros ficam legíveis: publicação normal = eventId (UUID).
 */
export const DEDUPLICATION_ID_RE = /^[A-Za-z0-9!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]{1,128}$/;

const TYPE_RE = /^[a-z]{1,8}$/;
const HASH_LENGTH = 40;

export type DedupSuffix = readonly [label: 'a' | 'r', value: number];

export class DeduplicationIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeduplicationIdError';
  }
}

function digestOf(parts: readonly string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(`${Buffer.byteLength(part, 'utf8')}:${part};`, 'utf8');
  return hash.digest('hex').slice(0, HASH_LENGTH);
}

export function deduplicationId(type: string, parts: readonly string[], suffixes: readonly DedupSuffix[] = []): string {
  if (!TYPE_RE.test(type)) throw new DeduplicationIdError(`tipo de DedupId inválido: ${type}`);
  if (parts.length === 0) throw new DeduplicationIdError('DedupId precisa de pelo menos uma parte');
  let id = `${type}:${digestOf(parts)}`;
  for (const [label, value] of suffixes) {
    if (!Number.isSafeInteger(value) || value < 0) throw new DeduplicationIdError(`sufixo inválido: ${label}${value}`);
    id += `:${label}${value}`;
  }
  return assertDeduplicationId(id);
}

/** Republicação intencional (D38): id novo por execução, nunca o eventId puro. */
export function republishDeduplicationId(eventId: string, runId: string): string {
  return assertDeduplicationId(`rp:${eventId}:${runId}`);
}

export function assertDeduplicationId(id: string): string {
  if (!DEDUPLICATION_ID_RE.test(id)) throw new DeduplicationIdError(`MessageDeduplicationId fora do formato: ${id}`);
  return id;
}
