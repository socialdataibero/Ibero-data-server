import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import { DatasetVisibility } from '@prisma/client';
import { PrismaService } from '../../modules/prisma/prisma.service.js';
import type { AuthenticatedUser } from '../../modules/auth/jwt-payload.interface.js';

/**
 * For routes with `:datasetId` (SDI-87): the dataset must belong to `:organizationId`, and a
 * PRIVATE dataset is only reachable by members of its organization and the sysadmin.
 * Anyone else gets 404, so a private dataset's existence is not revealed. Runs after
 * OrgRolesGuard, which handles the role a route requires.
 */
@Injectable()
export class DatasetAccessGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const datasetId: string | undefined = request.params?.datasetId;
    if (!datasetId) return true;

    const organizationId: string | undefined = request.params?.organizationId;
    const user: AuthenticatedUser | undefined = request.user;
    const dataset = await this.prisma.dataset.findUnique({
      where: { id: datasetId },
      select: { organizationId: true, visibility: true },
    });
    if (!dataset || dataset.organizationId !== organizationId) throw notFound();
    if (dataset.visibility === DatasetVisibility.PUBLIC || user?.isSysadmin) return true;
    if (!user) throw notFound();

    const membership = await this.prisma.organizationMember.findUnique({
      where: { userId_organizationId: { userId: user.id, organizationId: dataset.organizationId } },
      select: { id: true },
    });
    if (!membership) throw notFound();
    return true;
  }
}

function notFound(): NotFoundException {
  return new NotFoundException({ code: 'dataset_not_found', message: 'Dataset not found.' });
}
