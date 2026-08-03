import { Injectable } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { PrismaService } from "../../prisma/prisma.service";

// ── FfScope types ──────────────────────────────────────────────────────────────
type PointLite = { id: string; type: string; name: string | null; country: string | null };

export interface ScopedQuote {
  id: string;
  legId: string;
  status: string;
  rfqId: string | null;
  manifestSnapshot: unknown;
  draftJson: unknown;
  leg: {
    id: string;
    legCode: string;
    mode: string | null;
    originPoint: PointLite | null;
    destinationPoint: PointLite | null;
  };
}

export interface FfScope {
  rfq: {
    id: string;
    queryId: string;
    rfqNumber: string;
    incoterms: string | null;
    submissionDeadline: Date;
    currency: string | null;
    quoteValidityUntil: Date | null;
    freightForwarderId: string;
  };
  quotes: ScopedQuote[];
}

@Injectable()
export class RfqTokenService {
  constructor(private readonly prisma: PrismaService) {}

  /** 256-bit opaque token + its sha256 hash. Store the hash; put the token only in the link. */
  mint(): { token: string; hash: string } {
    const token = randomBytes(32).toString("hex");
    return { token, hash: this.hash(token) };
  }

  hash(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  async resolveByToken(rawToken: string): Promise<FfScope | null> {
    const accessTokenHash = this.hash(rawToken);
    const rfq = await this.prisma.rfq.findUnique({
      where: { accessTokenHash },
      include: {
        quotes: {
          where: { NOT: { status: "SELECT" } }, // only distributed quotes are in scope
          include: {
            leg: {
              select: {
                id: true,
                legCode: true,
                mode: true,
                originPoint: { select: { id: true, type: true, name: true, country: true } },
                destinationPoint: { select: { id: true, type: true, name: true, country: true } },
              },
            },
          },
        },
      },
    });
    if (!rfq) return null;
    return {
      rfq: {
        id: rfq.id,
        queryId: rfq.queryId,
        rfqNumber: rfq.rfqNumber,
        incoterms: rfq.incoterms,
        submissionDeadline: rfq.submissionDeadline,
        currency: rfq.currency,
        quoteValidityUntil: rfq.quoteValidityUntil,
        freightForwarderId: rfq.freightForwarderId,
      },
      quotes: rfq.quotes.map((q) => ({
        id: q.id,
        legId: q.legId,
        status: q.status,
        rfqId: q.rfqId,
        manifestSnapshot: q.manifestSnapshot,
        draftJson: q.draftJson,
        leg: {
          id: q.leg.id,
          legCode: q.leg.legCode,
          mode: q.leg.mode,
          originPoint: q.leg.originPoint,
          destinationPoint: q.leg.destinationPoint,
        },
      })),
    };
  }
}
