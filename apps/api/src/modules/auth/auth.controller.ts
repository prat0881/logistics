import { Body, Controller, Get, HttpCode, Post, Req, Res, UsePipes } from "@nestjs/common";
import type { Request, Response } from "express";
import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE, loginSchema } from "@svyft/shared";
import type { AuthUser, LoginInput } from "@svyft/shared";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { Public } from "./decorators/public.decorator";
import { CurrentUser } from "./decorators/current-user.decorator";
import { AuthService, type AuthTokens } from "./auth.service";
import type { RequestUser } from "./types";

const ACCESS_MAX_AGE_MS = 15 * 60 * 1000;

function cookieSecure(): boolean {
  return process.env.COOKIE_SECURE === "true";
}

function readCookie(req: Request, name: string): string | undefined {
  return (req.cookies as Record<string, string> | undefined)?.[name];
}

function setAuthCookies(res: Response, tokens: AuthTokens): void {
  const secure = cookieSecure();
  res.cookie(ACCESS_TOKEN_COOKIE, tokens.accessToken, {
    httpOnly: true,
    sameSite: "strict",
    secure,
    path: "/",
    maxAge: ACCESS_MAX_AGE_MS,
  });
  res.cookie(REFRESH_TOKEN_COOKIE, tokens.refreshToken, {
    httpOnly: true,
    sameSite: "strict",
    secure,
    path: "/api/auth",
    expires: tokens.refreshExpiresAt,
  });
}

function clearAuthCookies(res: Response): void {
  const secure = cookieSecure();
  res.clearCookie(ACCESS_TOKEN_COOKIE, { httpOnly: true, sameSite: "strict", secure, path: "/" });
  res.clearCookie(REFRESH_TOKEN_COOKIE, {
    httpOnly: true,
    sameSite: "strict",
    secure,
    path: "/api/auth",
  });
}

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post("login")
  @HttpCode(200)
  @UsePipes(new ZodValidationPipe(loginSchema))
  async login(
    @Body() body: LoginInput,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ user: AuthUser }> {
    const { user, tokens } = await this.auth.login(body.email, body.password);
    setAuthCookies(res, tokens);
    return { user };
  }

  @Public()
  @Post("refresh")
  @HttpCode(200)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ user: AuthUser }> {
    const { user, tokens } = await this.auth.refresh(readCookie(req, REFRESH_TOKEN_COOKIE));
    setAuthCookies(res, tokens);
    return { user };
  }

  @Public()
  @Post("logout")
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.logout(readCookie(req, REFRESH_TOKEN_COOKIE));
    clearAuthCookies(res);
  }

  @Get("me")
  async me(@CurrentUser() user: RequestUser): Promise<{ user: AuthUser }> {
    return { user: await this.auth.me(user.userId) };
  }
}
