import { Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import type { AuthUser } from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";
import { PasswordService } from "./password.service";
import { generateRefreshToken, hashRefreshToken } from "./refresh-token.util";
import type { JwtPayload } from "./types";

const REFRESH_TTL_DAYS = Number(process.env.REFRESH_TTL_DAYS ?? 7);

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  refreshExpiresAt: Date;
}

export interface LoginResult {
  user: AuthUser;
  tokens: AuthTokens;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly jwt: JwtService,
  ) {}

  private toAuthUser(u: {
    id: string;
    name: string;
    email: string;
    role: AuthUser["role"];
  }): AuthUser {
    return { id: u.id, name: u.name, email: u.email, role: u.role };
  }

  private async issueTokens(u: {
    id: string;
    tenantId: string | null;
    role: AuthUser["role"];
  }): Promise<AuthTokens> {
    const payload: JwtPayload = { sub: u.id, role: u.role, tenantId: u.tenantId };
    const accessToken = this.jwt.sign(payload);
    const refreshToken = generateRefreshToken();
    const refreshExpiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000);
    await this.prisma.refreshToken.create({
      data: {
        userId: u.id,
        tenantId: u.tenantId,
        tokenHash: hashRefreshToken(refreshToken),
        expiresAt: refreshExpiresAt,
      },
    });
    return { accessToken, refreshToken, refreshExpiresAt };
  }

  async login(email: string, password: string): Promise<LoginResult> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || !user.isActive || !(await this.passwords.verify(password, user.passwordHash))) {
      throw new UnauthorizedException("Invalid credentials");
    }
    return { user: this.toAuthUser(user), tokens: await this.issueTokens(user) };
  }

  async refresh(rawToken: string | undefined): Promise<LoginResult> {
    if (!rawToken) {
      throw new UnauthorizedException("Missing refresh token");
    }
    const existing = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashRefreshToken(rawToken) },
    });
    if (!existing || existing.revokedAt || existing.expiresAt < new Date()) {
      throw new UnauthorizedException("Invalid refresh token");
    }
    const user = await this.prisma.user.findUnique({ where: { id: existing.userId } });
    if (!user || !user.isActive) {
      throw new UnauthorizedException("Invalid refresh token");
    }
    await this.prisma.refreshToken.update({
      where: { id: existing.id },
      data: { revokedAt: new Date() },
    });
    return { user: this.toAuthUser(user), tokens: await this.issueTokens(user) };
  }

  async logout(rawToken: string | undefined): Promise<void> {
    if (!rawToken) {
      return;
    }
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: hashRefreshToken(rawToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async me(userId: string): Promise<AuthUser> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.isActive) {
      throw new UnauthorizedException("User not found");
    }
    return this.toAuthUser(user);
  }
}
