import "reflect-metadata";
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Module,
  Post,
  Req,
  Res,
  UnauthorizedException,
  ConflictException,
  ValidationPipe,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { APP_GUARD, NestFactory } from "@nestjs/core";
import { Throttle, ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { Transform } from "class-transformer";
import { IsEmail, IsString, MaxLength, MinLength } from "class-validator";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { EstimateController, EstimateStore } from "./estimates";
import type { Request, Response } from "express";
import { AuthStore, SESSION_MS, type User } from "./auth.store";

const COOKIE = "anfas_session";
class Credentials {
  @Transform(({ value }) =>
    typeof value === "string" ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @MinLength(10)
  @MaxLength(128)
  password!: string;
}

function origins(): string[] {
  return (
    process.env.FRONTEND_ORIGINS ||
    "http://127.0.0.1:5173,http://localhost:5173"
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

@Injectable()
class MutationGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return true;
    // A custom header plus JSON prevents cross-site HTML form submission; Origin is checked as well.
    return (
      req.get("X-Anfas-Client") === "web" &&
      req.is("application/json") === "application/json" &&
      !!req.get("Origin") &&
      origins().includes(req.get("Origin")!)
    );
  }
}

@Controller("auth")
class AuthController {
  constructor(@Inject(AuthStore) private readonly store: AuthStore) {}

  private async signIn(user: User, req: Request, res: Response) {
    await this.store.revoke(req.cookies?.[COOKIE]);
    res.cookie(COOKIE, await this.store.session(user), {
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.NODE_ENV === "production",
      path: "/api",
      maxAge: SESSION_MS,
    });
    return { user };
  }

  @Post("register")
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async register(
    @Body(
      new ValidationPipe({
        expectedType: Credentials,
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: Credentials,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const user = await this.store.register(dto.email, dto.password);
    if (!user)
      throw new ConflictException(
        "Этот email уже зарегистрирован. Войдите в аккаунт.",
      );
    return this.signIn(user, req, res);
  }

  @Post("login")
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async login(
    @Body(
      new ValidationPipe({
        expectedType: Credentials,
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: Credentials,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const user = await this.store.login(dto.email, dto.password);
    if (!user) throw new UnauthorizedException("Неверный email или пароль.");
    return this.signIn(user, req, res);
  }

  @Get("me")
  async me(@Req() req: Request) {
    const user = await this.store.current(req.cookies?.[COOKIE]);
    if (!user) throw new UnauthorizedException("Войдите в аккаунт.");
    return { user };
  }

  @Post("logout")
  @HttpCode(200)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.store.revoke(req.cookies?.[COOKIE]);
    res.clearCookie(COOKIE, {
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.NODE_ENV === "production",
      path: "/api",
    });
    return { user: null };
  }
}

@Controller("health")
class HealthController {
  @Get() health() {
    return { status: "ok" };
  }
}

@Module({
  imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }])],
  controllers: [AuthController, HealthController, EstimateController],
  providers: [
    AuthStore,
    EstimateStore,
    { provide: APP_GUARD, useClass: MutationGuard },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
class AppModule {}

export async function createApp() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ["error", "warn", "log"],
    bodyParser: false,
  });
  app.setGlobalPrefix("api");
  app.use(helmet());
  app.useBodyParser("json", { limit: "1100kb" });
  app.use(cookieParser());
  app.use((_req: Request, res: Response, next: () => void) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.enableCors({
    origin: origins(),
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "X-Anfas-Client"],
  });
  app.enableShutdownHooks();
  return app;
}
