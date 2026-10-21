import { NotFoundException, type ExecutionContext } from '@nestjs/common';
import type { PrismaService } from '../../modules/prisma/prisma.service.js';
import { DatasetAccessGuard } from './dataset-access.guard.js';

const DATASETS: Record<string, { organizationId: string; visibility: 'PUBLIC' | 'PRIVATE' }> = {
  'private-a': { organizationId: 'org-a', visibility: 'PRIVATE' },
  'public-a': { organizationId: 'org-a', visibility: 'PUBLIC' },
};
const MEMBERS = new Set(['member-a:org-a']);

function makeGuard() {
  const prisma = {
    dataset: { findUnique: vi.fn(async ({ where }: any) => DATASETS[where.id] ?? null) },
    organizationMember: {
      findUnique: vi.fn(async ({ where }: any) => {
        const { userId, organizationId } = where.userId_organizationId;
        return MEMBERS.has(`${userId}:${organizationId}`) ? { id: 'm' } : null;
      }),
    },
  };
  return new DatasetAccessGuard(prisma as unknown as PrismaService);
}

function context(params: Record<string, string>, user?: { id: string; isSysadmin: boolean }): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => ({ params, user }) }) } as unknown as ExecutionContext;
}

const memberOfA = { id: 'member-a', isSysadmin: false };
const memberOfB = { id: 'member-b', isSysadmin: false };
const noOrganization = { id: 'lonely', isSysadmin: false };
const sysadmin = { id: 'admin', isSysadmin: true };

describe('DatasetAccessGuard (SDI-87)', () => {
  it('lets routes without :datasetId through', async () => {
    await expect(makeGuard().canActivate(context({ organizationId: 'org-a' }, noOrganization))).resolves.toBe(true);
  });

  it.each([
    ['a member of its organization', memberOfA],
    ['the sysadmin', sysadmin],
  ])('lets %s open a PRIVATE dataset', async (_who, user) => {
    await expect(makeGuard().canActivate(context({ organizationId: 'org-a', datasetId: 'private-a' }, user))).resolves.toBe(true);
  });

  it.each([
    ['a member of another organization', memberOfB],
    ['a user without organization', noOrganization],
    ['a request without user', undefined],
  ])('returns 404 to %s for a PRIVATE dataset', async (_who, user) => {
    await expect(
      makeGuard().canActivate(context({ organizationId: 'org-a', datasetId: 'private-a' }, user)),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('lets anyone open a PUBLIC dataset', async () => {
    await expect(makeGuard().canActivate(context({ organizationId: 'org-a', datasetId: 'public-a' }, noOrganization))).resolves.toBe(true);
  });

  it('returns 404 when the dataset belongs to another organization than the URL says', async () => {
    // A member of org-b must not reach org-a's dataset by putting it under /organizations/org-b/.
    await expect(
      makeGuard().canActivate(context({ organizationId: 'org-b', datasetId: 'private-a' }, memberOfB)),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      makeGuard().canActivate(context({ organizationId: 'org-b', datasetId: 'public-a' }, sysadmin)),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns 404 when the dataset does not exist', async () => {
    await expect(
      makeGuard().canActivate(context({ organizationId: 'org-a', datasetId: 'nope' }, sysadmin)),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
