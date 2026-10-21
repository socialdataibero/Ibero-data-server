import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';
import { SysadminGuard } from '../../shared/guards/sysadmin.guard.js';
import { OrganizationsController } from './organizations.controller.js';

function contextFor(user: { isSysadmin: boolean }): ExecutionContext {
  return {
    getHandler: () => OrganizationsController.prototype.create,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('OrganizationsController.create', () => {
  const guard = new SysadminGuard(new Reflector());

  it('is protected by the sysadmin guard', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, OrganizationsController.prototype.create);
    expect(guards).toContain(SysadminGuard);
  });

  it('lets the sysadmin create organizations', () => {
    expect(guard.canActivate(contextFor({ isSysadmin: true }))).toBe(true);
  });

  it('rejects any other user', () => {
    expect(() => guard.canActivate(contextFor({ isSysadmin: false }))).toThrow(ForbiddenException);
  });
});
