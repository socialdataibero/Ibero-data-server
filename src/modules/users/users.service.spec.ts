import { BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { AuthService } from '../auth/auth.service.js';
import { UsersService } from './users.service.js';

async function makeService(password: string) {
  const user = {
    id: 'u1',
    email: 'u1@example.test',
    fullName: 'User One',
    isSysadmin: false,
    isActive: true,
    tokenVersion: 0,
    passwordHash: await bcrypt.hash(password, 4),
  };
  const prisma = {
    user: {
      findUnique: vi.fn(async () => user),
      update: vi.fn(async ({ data }: any) => {
        const { tokenVersion, ...rest } = data;
        Object.assign(user, rest);
        if (tokenVersion?.increment) user.tokenVersion += tokenVersion.increment;
        return user;
      }),
    },
  };
  const jwt = new JwtService({ secret: 'test-secret' });
  const auth = new AuthService(prisma as any, jwt);
  return { service: new UsersService(prisma as any, auth), auth, jwt, prisma, user };
}

describe('UsersService.changePassword', () => {
  it('stores a new hash when the current password matches', async () => {
    const { service, user } = await makeService('old-password');
    await service.changePassword('u1', 'old-password', 'new-password');
    expect(await bcrypt.compare('new-password', user.passwordHash)).toBe(true);
  });

  it('rejects a wrong current password and keeps the old hash', async () => {
    const { service, prisma, user } = await makeService('old-password');
    await expect(service.changePassword('u1', 'nope', 'new-password')).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(await bcrypt.compare('old-password', user.passwordHash)).toBe(true);
  });

  it('signs out sessions opened before the change and keeps the current one (SDI-133)', async () => {
    const { service, auth, jwt } = await makeService('old-password');
    const before = jwt.verify((await auth.login({ email: 'u1@example.test', password: 'old-password' })).accessToken);
    const legacy = { sub: 'u1', email: 'u1@example.test', isSysadmin: false };
    expect(await auth.validateUser(legacy)).not.toBeNull();

    const { accessToken } = await service.changePassword('u1', 'old-password', 'new-password');

    expect(await auth.validateUser(before)).toBeNull();
    expect(await auth.validateUser(legacy)).toBeNull();
    expect(await auth.validateUser(jwt.verify(accessToken))).not.toBeNull();
  });
});
