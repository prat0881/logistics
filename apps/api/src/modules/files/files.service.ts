import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { FileAsset } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { STORAGE, type StorageService } from "./storage";

// Structural subset of Express.Multer.File (avoids a hard @types/multer dep here).
export interface MsdsUpload {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

@Injectable()
export class FilesService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE) private readonly storage: StorageService,
  ) {}

  // MSDS is PDF-only (§7.3 F6). Validate BOTH the declared mime and the %PDF magic bytes.
  async storeMsds(
    queryId: string,
    file: MsdsUpload | undefined,
    uploadedById: string | null,
  ): Promise<FileAsset> {
    if (!file) throw new BadRequestException("No file uploaded");
    const isPdf =
      file.mimetype === "application/pdf" &&
      file.buffer.subarray(0, 5).toString("latin1") === "%PDF-";
    if (!isPdf) throw new BadRequestException("MSDS must be a PDF file");

    const storageKey = `msds/${queryId}/${randomUUID()}.pdf`;
    await this.storage.put(storageKey, file.buffer);
    return this.prisma.fileAsset.create({
      data: {
        queryId,
        kind: "MSDS",
        filename: file.originalname,
        mime: file.mimetype,
        sizeBytes: file.size,
        storageKey,
        uploadedById,
      },
    });
  }
}
