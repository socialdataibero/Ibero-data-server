import {
  All,
  Controller,
  Get,
  Param,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { JwtAuthGuard } from '../../../shared/guards/jwt-auth.guard.js';
import { CurrentUser } from '../../../shared/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../../auth/jwt-payload.interface.js';
import { HarmonizerUploadsService } from './harmonizer-uploads.service.js';

@Controller('harmonizer')
@UseGuards(JwtAuthGuard)
export class HarmonizerUploadsController {
  constructor(private readonly uploads: HarmonizerUploadsService) {}

  /** The tus protocol (POST to create, HEAD, PATCH, DELETE on `uploads/:id`), handled by @tus/server. */
  @All(['uploads', 'uploads/:id'])
  async tus(@Req() req: Request, @Res() res: Response): Promise<void> {
    await this.uploads.handle(req, res);
  }

  @Get('imports/:importId')
  status(
    @Param('importId') importId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.uploads.status(user, importId);
  }
}
