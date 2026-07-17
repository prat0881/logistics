import { Global, Module } from "@nestjs/common";
import { CodeSequenceService } from "./code-sequence.service";

@Global()
@Module({ providers: [CodeSequenceService], exports: [CodeSequenceService] })
export class CodeSequenceModule {}
