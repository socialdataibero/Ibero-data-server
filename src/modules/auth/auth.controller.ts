import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import { RegisterDto } from './dto/register.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard.js';
import { SysadminGuard } from '../../shared/guards/sysadmin.guard.js';
import { SysadminOnly } from '../../shared/decorators/sysadmin.decorator.js';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // Accounts are created by the sysadmin only (SDI-111); there is no public sign-up.
  @Post('register')
  @UseGuards(JwtAuthGuard, SysadminGuard)
  @SysadminOnly()
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }
}
