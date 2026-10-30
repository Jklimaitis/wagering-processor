import { Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";

/** Ponto de extensão OIDC. A entrega local aceita chamadas sem autenticação. */
@Injectable()
export class ProviderIdentityGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    // Integração futura: validar JWT do IdP e associar a identidade ao providerId.
    return true;
  }
}
