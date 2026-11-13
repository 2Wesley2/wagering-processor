/**
 * Erro de domínio com código estável e legível por máquina (§7.2). O código é
 * a chave do ErrorCatalog; a mensagem é só para humanos e logs.
 */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Violação de pré-condição: indica bug de chamada, não regra de negócio. */
export class PreconditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreconditionError';
  }
}
