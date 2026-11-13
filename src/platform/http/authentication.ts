import type { IncomingHttpHeaders } from 'node:http';
import { type CanActivate, type ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthenticationAdapter } from '../config/config.ts';
import { AUTHENTICATION } from '../tokens.ts';
import { AppError } from './problem-details.ts';

/**
 * Ponto de extensão de autenticação (§2, U1, D33). Hoje o adaptador padrão é no-op: o desafio não
 * pontua autenticação, e o desenho-alvo (IdP externo com client_credentials por provedor, JWT RS256
 * via JWKS e claim `provider_id` igual ao payload) fica para a F8 opcional.
 */
export interface AuthenticationPort {
  /** true = requisição autenticada; false = recusada (401 AUTHENTICATION_REQUIRED). */
  authenticate(headers: IncomingHttpHeaders): Promise<boolean>;
}

export class NoopAuthentication implements AuthenticationPort {
  authenticate(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

/** Só existe para testes (config recusa fora de NODE_ENV=test): prova que o guard está ligado. */
export class DenyAllAuthentication implements AuthenticationPort {
  authenticate(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

export function createAuthentication(adapter: AuthenticationAdapter): AuthenticationPort {
  return adapter === 'deny-all' ? new DenyAllAuthentication() : new NoopAuthentication();
}

const PUBLIC_ROUTE = 'wagering:public-route';

/** Rota sem autenticação (health, §2 e §9). */
export const Public = () => SetMetadata(PUBLIC_ROUTE, true);

interface RequestWithHeaders {
  readonly headers: IncomingHttpHeaders;
}

function isRequestWithHeaders(value: unknown): value is RequestWithHeaders {
  return typeof value === 'object' && value !== null && 'headers' in value && typeof value.headers === 'object';
}

/** Guard global (APP_GUARD): roda antes da leitura do corpo e de qualquer regra de negócio (D31). */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(AUTHENTICATION) private readonly authentication: AuthenticationPort,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(PUBLIC_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) return true;
    const request: unknown = context.switchToHttp().getRequest();
    const headers = isRequestWithHeaders(request) ? request.headers : {};
    if (await this.authentication.authenticate(headers)) return true;
    throw new AppError('AUTHENTICATION_REQUIRED', 'autenticação recusada');
  }
}
