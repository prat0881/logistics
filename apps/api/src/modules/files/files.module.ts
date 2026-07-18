import { Module } from "@nestjs/common";
import { FilesService } from "./files.service";
import { STORAGE, LocalDiskStorage } from "./storage";

@Module({
  providers: [FilesService, { provide: STORAGE, useClass: LocalDiskStorage }],
  exports: [FilesService],
})
export class FilesModule {}
