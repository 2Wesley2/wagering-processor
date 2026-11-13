/**
 * Prazo efetivo de uma pendência (D40, seção 12 do plano). Depende só de
 * instantes gravados no banco, nunca do horário em que o worker roda:
 *   eff(P) = max(deadline(P), eff(R))  se R foi aceita até deadline(P) e também estava pendente;
 *   eff(P) = deadline(P)               nos demais casos.
 * A cadeia tem profundidade ≤ 2 (u1 → r1 → b1).
 */
export interface PendingReferenceInfo {
  readonly acceptedAt: Date;
  /** R também foi aceita como PENDING_REFERENCE. */
  readonly wasPending: boolean;
  /** Prazo efetivo de R, quando R era pendente. */
  readonly effectiveDeadline?: Date;
}

export function effectiveDeadline(deadline: Date, reference: PendingReferenceInfo | undefined): Date {
  if (reference === undefined || !reference.wasPending || reference.effectiveDeadline === undefined) {
    return new Date(deadline.getTime());
  }
  if (reference.acceptedAt.getTime() > deadline.getTime()) return new Date(deadline.getTime());
  return new Date(Math.max(deadline.getTime(), reference.effectiveDeadline.getTime()));
}
