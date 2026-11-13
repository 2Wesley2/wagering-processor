import type { ProviderIdentity } from '../application/ports.ts';
import { ProviderNotRecognizedError } from '../application/submit-wager-transaction.ts';

/**
 * Identidade do provedor (D33) com a autenticação no-op: só confere o registro de provedores da
 * configuração. Com um IdP (F8), também compararia o provedor do token com o do payload
 * (PROVIDER_IDENTITY_MISMATCH).
 */
export class RegistryProviderIdentity implements ProviderIdentity {
  constructor(private readonly providers: ReadonlySet<string>) {}

  assertMaySubmit(providerId: string): void {
    if (!this.providers.has(providerId)) throw new ProviderNotRecognizedError();
  }
}
