import { Injectable, UnauthorizedException } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify, JWTVerifyGetKey } from 'jose';
import { env, listEnv } from '../config/env';
import { AuthAccount, accountFromPayload } from './auth.types';

@Injectable()
export class AuthService {
  private jwks?: JWTVerifyGetKey;
  private discoveredJwksUrl?: string;

  async verifyBearerToken(token: string): Promise<AuthAccount> {
    try {
      const result = await jwtVerify(token, await this.getJwks(), {
        issuer: env('AUTH_ISSUER_URL', 'http://localhost:3032'),
        audience: env('AUTH_AUDIENCE', 'service:game-platform'),
      });
      return accountFromPayload(
        result.payload,
        env('AUTH_SERVICE_KEY', 'game-platform'),
        listEnv('AUTH_DENIED_PERMISSIONS'),
      );
    } catch (error) {
      throw new UnauthorizedException(error instanceof Error ? error.message : 'Invalid bearer token');
    }
  }

  private async getJwks(): Promise<JWTVerifyGetKey> {
    if (this.jwks) {
      return this.jwks;
    }
    const configuredJwksUrl = process.env.AUTH_JWKS_URL?.trim();
    const jwksUrl = configuredJwksUrl && configuredJwksUrl.length > 0
      ? configuredJwksUrl
      : await this.discoverJwksUrl();
    this.jwks = createRemoteJWKSet(new URL(jwksUrl));
    return this.jwks;
  }

  private async discoverJwksUrl(): Promise<string> {
    if (this.discoveredJwksUrl) {
      return this.discoveredJwksUrl;
    }
    const issuer = env('AUTH_ISSUER_URL', 'http://localhost:3032').replace(/\/$/, '');
    const response = await fetch(`${issuer}/.well-known/openid-configuration`);
    if (!response.ok) {
      throw new UnauthorizedException('Unable to load auth discovery metadata');
    }
    const metadata = (await response.json()) as Record<string, unknown>;
    if (typeof metadata.jwks_uri !== 'string') {
      throw new UnauthorizedException('Auth discovery metadata is missing jwks_uri');
    }
    this.discoveredJwksUrl = metadata.jwks_uri;
    return this.discoveredJwksUrl;
  }
}
