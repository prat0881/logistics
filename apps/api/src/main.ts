import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import cookieParser from "cookie-parser";
import { AppModule } from "./app.module";
import { PrismaExceptionFilter } from "./common/prisma-exception.filter";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.use(cookieParser());
  app.useGlobalFilters(new PrismaExceptionFilter());
  app.setGlobalPrefix("api");
  await app.listen(Number(process.env.PORT ?? 4000));
}
void bootstrap();
