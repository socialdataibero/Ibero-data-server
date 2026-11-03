import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomBytes } from 'node:crypto';
import type { AuthenticatedUser, JwtPayload } from '../auth/jwt-payload.interface.js';

export interface IberoContext {
  apiUrl: string;
  organizationId: string;
  organizationName: string;
  datasetId: string;
  datasetTitle: string;
  resourceId?: string;
  resourceName?: string;
  analysisId?: string;
  analysisTitle?: string;
  publishToken?: string;
  /** False for users who may open vistrace but not save back to Ibero Data (no publishToken then). */
  canPublish: boolean;
}

export interface CanvasTable {
  tableName: string;
  resourceId: string;
  downloadUrl: string;
}

export interface CanvasHandoff {
  state: Record<string, unknown>;
  tables: CanvasTable[];
}

export interface HandoffPayload {
  username: string;
  displayName: string;
  downloadToken: string;
  ibero?: IberoContext;
  canvas?: CanvasHandoff;
}

export interface PublishTokenPayload extends JwtPayload {
  purpose: typeof PUBLISH_PURPOSE;
  organizationId: string;
  datasetId: string;
}

export const PUBLISH_PURPOSE = 'vistrace_publish';

const TTL_MS = 300_000;
const DOWNLOAD_TOKEN_TTL = '10m';
const PUBLISH_TOKEN_TTL = '12h';

@Injectable()
export class HandoffService {
  private readonly store = new Map<string, { payload: HandoffPayload; expiresAt: number }>();

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  buildResourceHandoffUrl(
    user: AuthenticatedUser,
    downloadUrl: string,
    filename: string,
    ibero?: Omit<IberoContext, 'apiUrl' | 'publishToken'>,
  ): string {
    const token = this.createToken(user, ibero ? this.withPublishToken(user, ibero) : undefined);
    const params = new URLSearchParams({
      handoff: token,
      ckan_url: this.apiBaseUrl(),
      resource_url: downloadUrl,
      resource_name: this.safeName(filename),
      resource_format: 'parquet',
    });
    return `${this.vistraceUrl()}?${params.toString()}`;
  }

  buildAnalysisHandoffUrl(
    user: AuthenticatedUser,
    result: { downloadUrl: string; filename: string },
    source: { downloadUrl: string; filename: string },
    vistraceRecipe: Record<string, unknown>,
    joinResources: { alias: string; downloadUrl: string; filename: string }[] = [],
    ibero?: Omit<IberoContext, 'apiUrl' | 'publishToken'>,
  ): string {
    const token = this.createToken(user, ibero ? this.withPublishToken(user, ibero) : undefined);
    const pipeline = Buffer.from(JSON.stringify(vistraceRecipe)).toString('base64url');
    const params = new URLSearchParams({
      handoff: token,
      ckan_url: this.apiBaseUrl(),
      resource_url: result.downloadUrl,
      resource_name: this.safeName(result.filename),
      resource_format: 'parquet',
      source_resource_url: source.downloadUrl,
      source_resource_name: this.safeName(source.filename),
      pipeline,
    });
    if (joinResources.length > 0) {
      const encoded = joinResources.map((j) => ({
        alias: j.alias,
        url: j.downloadUrl,
        name: this.safeName(j.filename),
      }));
      params.set('join_resources', Buffer.from(JSON.stringify(encoded)).toString('base64url'));
    }
    return `${this.vistraceUrl()}?${params.toString()}`;
  }

  buildCanvasHandoffUrl(
    user: AuthenticatedUser,
    canvas: CanvasHandoff,
    ibero?: Omit<IberoContext, 'apiUrl' | 'publishToken'>,
  ): string {
    const token = this.createToken(user, ibero ? this.withPublishToken(user, ibero) : undefined, canvas);
    const params = new URLSearchParams({ handoff: token, ckan_url: this.apiBaseUrl() });
    return `${this.vistraceUrl()}?${params.toString()}`;
  }

  createDownloadToken(user: AuthenticatedUser): string {
    return this.jwtService.sign(
      { sub: user.id, email: user.email, isSysadmin: user.isSysadmin } satisfies JwtPayload,
      { expiresIn: DOWNLOAD_TOKEN_TTL },
    );
  }

  consume(token: string): HandoffPayload | null {
    const entry = this.store.get(token);
    this.store.delete(token);
    if (!entry || entry.expiresAt < Date.now()) {
      return null;
    }
    return entry.payload;
  }

  private createToken(user: AuthenticatedUser, ibero?: IberoContext, canvas?: CanvasHandoff): string {
    this.sweep();
    const downloadToken = this.createDownloadToken(user);
    const token = randomBytes(32).toString('base64url');
    this.store.set(token, {
      payload: { username: user.email, displayName: user.fullName, downloadToken, ibero, canvas },
      expiresAt: Date.now() + TTL_MS,
    });
    return token;
  }

  private withPublishToken(
    user: AuthenticatedUser,
    ibero: Omit<IberoContext, 'apiUrl' | 'publishToken'>,
  ): IberoContext {
    if (!ibero.canPublish) return { ...ibero, apiUrl: this.apiBaseUrl() };
    const publishToken = this.jwtService.sign(
      {
        sub: user.id,
        email: user.email,
        isSysadmin: user.isSysadmin,
        purpose: PUBLISH_PURPOSE,
        organizationId: ibero.organizationId,
        datasetId: ibero.datasetId,
      } satisfies PublishTokenPayload,
      { expiresIn: PUBLISH_TOKEN_TTL },
    );
    return { ...ibero, apiUrl: this.apiBaseUrl(), publishToken };
  }

  private safeName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 60) || 'ibero_data';
  }
  
  apiBaseUrl(): string {
    return this.configService.getOrThrow<string>('API_BASE_URL').replace(/\/+$/, '');
  }

  private vistraceUrl(): string {
    return this.configService.getOrThrow<string>('VISTRACE_URL').replace(/\/+$/, '');
  }

  private sweep(): void {
    const now = Date.now();
    for (const [token, entry] of this.store) {
      if (entry.expiresAt < now) this.store.delete(token);
    }
  }
}
