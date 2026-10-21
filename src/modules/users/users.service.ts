import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service.js';
import { SALT_ROUNDS } from '../auth/auth.service.js';

const PROFILE_SELECT = { id: true, email: true, fullName: true, isSysadmin: true, createdAt: true } as const;

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id }, select: PROFILE_SELECT });
    if (!user) {
      throw new NotFoundException({ code: 'user_not_found', message: 'User not found.' });
    }
    return user;
  }

  updateProfile(id: string, fullName: string) {
    return this.prisma.user.update({ where: { id }, data: { fullName }, select: PROFILE_SELECT });
  }

  async changePassword(id: string, currentPassword: string, newPassword: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw new NotFoundException({ code: 'user_not_found', message: 'User not found.' });
    }
    // 400, not 401: the session is valid, only the typed password is wrong.
    if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
      throw new BadRequestException({ code: 'wrong_current_password', message: 'The current password is incorrect.' });
    }
    const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    await this.prisma.user.update({ where: { id }, data: { passwordHash } });
  }

  findMemberships(userId: string) {
    return this.prisma.organizationMember.findMany({
      where: { userId },
      include: { organization: true },
    });
  }
}
