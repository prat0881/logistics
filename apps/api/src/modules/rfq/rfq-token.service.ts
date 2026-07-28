import { Injectable } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";

@Injectable()
export class RfqTokenService {
  /** 256-bit opaque token + its sha256 hash. Store the hash; put the token only in the link. */
  mint(): { token: string; hash: string } {
    const token = randomBytes(32).toString("hex");
    return { token, hash: this.hash(token) };
  }
  hash(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }
}
