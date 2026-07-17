import { Injectable } from "@nestjs/common";
import bcrypt from "bcryptjs";

const DEFAULT_COST = 10;

@Injectable()
export class PasswordService {
  private readonly cost = Number(process.env.BCRYPT_COST ?? DEFAULT_COST);

  async hash(plain: string): Promise<string> {
    return bcrypt.hash(plain, this.cost);
  }

  async verify(plain: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plain, hash);
  }
}
