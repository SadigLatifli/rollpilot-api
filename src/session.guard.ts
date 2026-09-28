import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { StoreService } from './store.service';

export type SessionRequest = { headers: { authorization?: string }; sessionHash: string };

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly store: StoreService) {}

  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<SessionRequest>();
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? '');
    if (!match) throw new UnauthorizedException();
    const hash = this.store.hash(match[1]);
    if (!this.store.hasSession(hash)) throw new UnauthorizedException();
    request.sessionHash = hash;
    return true;
  }
}
