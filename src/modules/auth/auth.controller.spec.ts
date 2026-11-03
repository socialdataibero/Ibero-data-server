import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import { AuthController } from './auth.controller.js';
import { SYSADMIN_ONLY_KEY } from '../../shared/decorators/sysadmin.decorator.js';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard.js';
import { SysadminGuard } from '../../shared/guards/sysadmin.guard.js';

describe('AuthController', () => {
  it('only lets a signed-in sysadmin create accounts (SDI-111)', () => {
    const handler = AuthController.prototype.register;
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toEqual([JwtAuthGuard, SysadminGuard]);
    expect(Reflect.getMetadata(SYSADMIN_ONLY_KEY, handler)).toBe(true);
  });

  it('keeps login public', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, AuthController.prototype.login)).toBeUndefined();
  });
});
