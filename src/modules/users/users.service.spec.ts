import { BadRequestException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { UsersService } from './users.service.js';

async function makeService(password: string) {
  const user = { id: 'u1', passwordHash: await bcrypt.hash(password, 4) };
  const prisma = {
    user: {
      findUnique: vi.fn(async () => user),
      update: vi.fn(async ({ data }: any) => Object.assign(user, data)),
    },
  };
  return { service: new UsersService(prisma as any), prisma, user };
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
});
