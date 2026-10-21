import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service.js';
import type { RegisterDto } from './dto/register.dto.js';
import type { LoginDto } from './dto/login.dto.js';
import type { AuthenticatedUser, JwtPayload } from './jwt-payload.interface.js';

export const SALT_ROUNDS = 12;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  async register(dto: RegisterDto) {
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) {
      throw new ConflictException({
        code: 'email_already_registered',
        message: 'A user with that email already exists.',
      });
    }

    const passwordHash = await bcrypt.hash(dto.password, SALT_ROUNDS);
    const user = await this.prisma.user.create({
      data: { email: dto.email, passwordHash, fullName: dto.fullName },
    });

    return this.buildToken(user.id, user.email, user.isSysadmin);
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (!user || !user.isActive) {
      throw new UnauthorizedException({
        code: 'user_not_found',
        message: 'User not found or inactive.',
      });
    }

    const valid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedException({ code: 'wrong_password', message: 'Incorrect password.' });
    }

    return this.buildToken(user.id, user.email, user.isSysadmin);
  }

  async validateUser(payload: JwtPayload): Promise<AuthenticatedUser | null> {
    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || !user.isActive) {
      return null;
    }
    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      isSysadmin: user.isSysadmin,
    };
  }

  private buildToken(userId: string, email: string, isSysadmin: boolean) {
    const payload: JwtPayload = { sub: userId, email, isSysadmin };
    return { accessToken: this.jwtService.sign(payload) };
  }
}
