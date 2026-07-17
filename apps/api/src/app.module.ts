import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ServeStaticModule } from "@nestjs/serve-static";
import { join } from "node:path";
import { PrismaModule } from "./prisma/prisma.module";
import { AuthModule } from "./modules/auth/auth.module";
import { CodeSequenceModule } from "./common/code-sequence.module";
import { HealthModule } from "./modules/health/health.module";
import { ClientsModule } from "./modules/clients/clients.module";
import { VesselsModule } from "./modules/vessels/vessels.module";

const staticImports =
  process.env.SERVE_STATIC === "true"
    ? [
        ServeStaticModule.forRoot({
          rootPath: join(__dirname, "..", "client"),
          exclude: ["/api/(.*)"],
        }),
      ]
    : [];

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ...staticImports,
    PrismaModule,
    AuthModule,
    CodeSequenceModule,
    ClientsModule,
    VesselsModule,
    HealthModule,
  ],
})
export class AppModule {}
