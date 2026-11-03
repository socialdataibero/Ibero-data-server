import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from '../auth/auth.service.js';
import { PUBLISH_PURPOSE, type PublishTokenPayload } from './handoff.service.js';

@Injectable()
export class PublishTokenGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly authService: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const header: string | undefined = request.headers['authorization'];
    const token = header?.replace(/^Bearer\s+/i, '').trim();
    if (!token) {
      throw new UnauthorizedException({
        code: 'publish_token_required',
        message: 'Missing publish token.',
      });
    }

    let payload: PublishTokenPayload;
    try {
      payload = await this.jwtService.verifyAsync<PublishTokenPayload>(token);
    } catch {
      throw new UnauthorizedException({
        code: 'publish_token_invalid',
        message: 'Invalid or expired publish token. Open vistrace again from Ibero Data.',
      });
    }

    if (payload.purpose !== PUBLISH_PURPOSE) {
      throw new UnauthorizedException({
        code: 'publish_token_invalid',
        message: 'Invalid or expired publish token. Open vistrace again from Ibero Data.',
      });
    }
    if (
      payload.organizationId !== request.params?.organizationId ||
      payload.datasetId !== request.params?.datasetId
    ) {
      throw new ForbiddenException({
        code: 'publish_token_scope',
        message: 'This publish token belongs to a different dataset.',
      });
    }

    const user = await this.authService.validateUser(payload);
    if (!user) {
      throw new UnauthorizedException({
        code: 'publish_token_invalid',
        message: 'Invalid or expired publish token. Open vistrace again from Ibero Data.',
      });
    }
    request.user = user;
    return true;
  }
}
