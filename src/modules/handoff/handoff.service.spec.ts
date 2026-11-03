import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { HandoffService } from './handoff.service.js';

const user = { id: 'u1', email: 'u1@example.test', fullName: 'User One', isSysadmin: false };
const context = { organizationId: 'org-1', organizationName: 'Org', datasetId: 'd1', datasetTitle: 'Dataset' };

function makeService() {
  const config = new ConfigService({ API_BASE_URL: 'http://api.test', VISTRACE_URL: 'http://vistrace.test' });
  return new HandoffService(new JwtService({ secret: 'test-secret' }), config);
}

function payloadOf(service: HandoffService, url: string) {
  return service.consume(new URL(url).searchParams.get('handoff')!);
}

describe('HandoffService publish token (SDI-134)', () => {
  it('gives ADMIN and EDITOR users a token to save back to Ibero Data', () => {
    const service = makeService();
    const url = service.buildResourceHandoffUrl(user, 'http://api.test/file', 'file.parquet', { ...context, canPublish: true });
    expect(payloadOf(service, url)?.ibero).toMatchObject({ canPublish: true, publishToken: expect.any(String) });
  });

  it('lets a member open vistrace without a token to save', () => {
    const service = makeService();
    const url = service.buildResourceHandoffUrl(user, 'http://api.test/file', 'file.parquet', { ...context, canPublish: false });
    const ibero = payloadOf(service, url)?.ibero;
    expect(ibero).toMatchObject({ canPublish: false, datasetId: 'd1' });
    expect(ibero?.publishToken).toBeUndefined();
  });
});
