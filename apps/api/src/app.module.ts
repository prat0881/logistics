import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { EventEmitterModule } from "@nestjs/event-emitter";
import { ScheduleModule } from "@nestjs/schedule";
import { ServeStaticModule } from "@nestjs/serve-static";
import { join } from "node:path";
import { PrismaModule } from "./prisma/prisma.module";
import { AuthModule } from "./modules/auth/auth.module";
import { HealthModule } from "./modules/health/health.module";
import { ClientsModule } from "./modules/clients/clients.module";
import { VesselsModule } from "./modules/vessels/vessels.module";
import { ConfigDataModule } from "./modules/config/config-data.module";
import { StatusModule } from "./modules/status/status.module";
import { ChangesModule } from "./modules/changes/changes.module";
import { FilesModule } from "./modules/files/files.module";
import { QueriesModule } from "./modules/queries/queries.module";
import { CargoModule } from "./modules/cargo/cargo.module";
import { PointsModule } from "./modules/points/points.module";
import { LegsModule } from "./modules/legs/legs.module";
import { RoutingModule } from "./modules/routing/routing.module";
import { EmailsModule } from "./modules/emails/emails.module";

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
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
    ...staticImports,
    PrismaModule,
    AuthModule,
    ClientsModule,
    VesselsModule,
    ConfigDataModule,
    StatusModule,
    ChangesModule,
    FilesModule,
    QueriesModule,
    CargoModule,
    PointsModule,
    LegsModule,
    RoutingModule,
    EmailsModule,
    HealthModule,
  ],
})
export class AppModule {}
