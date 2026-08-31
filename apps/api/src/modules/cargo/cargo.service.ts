import { Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import type { CargoCreateInput, CargoDto, CargoUpdateInput } from "@svyft/shared";
import ExcelJS from "exceljs";
import { randomUUID } from "node:crypto";
import type { RequestUser } from "../auth/types";
import { PrismaService } from "../../prisma/prisma.service";
import { ChangeMediator } from "../changes/change-mediator";
import { ImpactRegistry } from "../changes/impact.registry";
import { assertApplied } from "../changes/assert-applied";
import { shapeCargo } from "./cargo-shape";
import { QueryLockService } from "../award/query-lock.service";

@Injectable()
export class CargoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mediator: ChangeMediator,
    private readonly impacts: ImpactRegistry,
    private readonly lock: QueryLockService,
  ) {}

  private async assertQueryExists(queryId: string): Promise<void> {
    if (!(await this.prisma.query.findUnique({ where: { id: queryId }, select: { id: true } })))
      throw new NotFoundException("Query not found");
  }

  private async load(queryId: string, cid: string) {
    const row = await this.prisma.cargo.findFirst({ where: { id: cid, queryId } });
    if (!row) throw new NotFoundException("Cargo not found");
    return row;
  }

  // Re-reads one cargo with its full packages->items tree, shaped. Used for GET-by-id-ish call
  // sites (a no-op `update` and, later, any single-cargo read).
  private async getOne(queryId: string, cid: string): Promise<CargoDto> {
    const row = await this.prisma.cargo.findFirst({
      where: { id: cid, queryId },
      include: {
        packages: {
          orderBy: [{ rowIndex: "asc" }, { createdAt: "asc" }, { id: "asc" }],
          include: {
            items: { orderBy: [{ rowIndex: "asc" }, { createdAt: "asc" }, { id: "asc" }] },
          },
        },
      },
    });
    if (!row) throw new NotFoundException("Cargo not found");
    return shapeCargo(row);
  }

  // Reads the full Query -> Cargo -> Package -> Item tree for a query, each cargo shaped with
  // its derived header (H4-H8). Same deterministic tie-break at every level (rowIndex asc, then
  // createdAt/id asc) as the pre-re-model CargoItem list, so display order stays stable even if
  // the known create-race (see `create` below) ever produces a duplicate rowIndex.
  async getTree(queryId: string): Promise<CargoDto[]> {
    await this.assertQueryExists(queryId);
    const rows = await this.prisma.cargo.findMany({
      where: { queryId },
      orderBy: [{ rowIndex: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      include: {
        packages: {
          orderBy: [{ rowIndex: "asc" }, { createdAt: "asc" }, { id: "asc" }],
          include: {
            items: { orderBy: [{ rowIndex: "asc" }, { createdAt: "asc" }, { id: "asc" }] },
          },
        },
      },
    });
    return rows.map(shapeCargo);
  }

  // Mediated @create: mint the next rowIndex, insert, shape the result (packages is always []
  // for a brand-new cargo) — all inside the Free-path strategy's transaction.
  async create(queryId: string, input: CargoCreateInput, user: RequestUser): Promise<CargoDto> {
    // S5.9.5 (D6) — a locked query (`awardSnapshot != null`, i.e. QUOTING_CLIENT /
    // AWAITING_CLIENT_DECISION) refuses every write. First, before any other read, so a locked
    // query never does partial work.
    await this.lock.assertUnlocked(queryId);
    await this.assertQueryExists(queryId);
    const id = randomUUID();
    let shaped: CargoDto | undefined;
    const result = await this.mediator.apply(
      { entity: "cargo", id, action: "@create", queryId, actorId: user.userId },
      async (tx) => {
        // KNOWN RACE (deferred, not fixed): this is a read-then-write (MAX(rowIndex)+1) inside
        // a READ COMMITTED tx with no unique constraint on (queryId, rowIndex). Two concurrent
        // POST /queries/:id/cargo on the *same* query can both read the same max and each
        // create their own row with the same rowIndex — a duplicate ordinal, not data loss (both
        // rows persist). Accepted for Stage 3 per spec §8.5 ("last-write-wins, no record
        // locking") — same acceptance as the pre-re-model CargoItem.create this replaces. Reads
        // order by rowIndex with a createdAt/id tie-break (see getTree/getOne above), so display
        // order stays deterministic even if a duplicate occurs.
        const max = await tx.cargo.aggregate({ where: { queryId }, _max: { rowIndex: true } });
        const created = await tx.cargo.create({
          data: {
            id,
            queryId,
            tenantId: user.tenantId,
            rowIndex: (max._max.rowIndex ?? 0) + 1,
            poReference: input.poReference ?? null,
            label: input.label ?? null,
            dimUnit: input.dimUnit,
            weightUnit: input.weightUnit,
          },
        });
        shaped = shapeCargo({ ...created, packages: [] });
      },
    );
    assertApplied(result);
    return shaped!;
  }

  // Mediated field edit: poReference/label/dimUnit/weightUnit are all Corrective (see
  // cargo.impact.ts) — a cargo grouping carries no RfqDefining fields of its own (those live on
  // Package). No `reason` to strip here: unlike packageUpdateSchema/itemUpdateSchema,
  // cargoUpdateSchema has no `reason` field (Corrective edits never need change-order
  // justification).
  async update(
    queryId: string,
    cid: string,
    input: CargoUpdateInput,
    user: RequestUser,
  ): Promise<CargoDto> {
    // S5.9.5 (D6) — a locked query (`awardSnapshot != null`, i.e. QUOTING_CLIENT /
    // AWAITING_CLIENT_DECISION) refuses every write. First, before any other read, so a locked
    // query never does partial work.
    await this.lock.assertUnlocked(queryId);
    await this.load(queryId, cid);
    const fields = Object.keys(input);
    if (fields.length === 0) return this.getOne(queryId, cid);
    let shaped: CargoDto | undefined;
    const result = await this.mediator.apply(
      {
        entity: "cargo",
        id: cid,
        field: this.impacts.highestImpactField("cargo", fields),
        patch: input,
        queryId,
        actorId: user.userId,
      },
      async (tx) => {
        const updated = await tx.cargo.update({
          where: { id: cid },
          data: input as Prisma.CargoUncheckedUpdateInput,
        });
        const packages = await tx.package.findMany({
          where: { cargoId: cid },
          orderBy: [{ rowIndex: "asc" }, { createdAt: "asc" }, { id: "asc" }],
          include: {
            items: { orderBy: [{ rowIndex: "asc" }, { createdAt: "asc" }, { id: "asc" }] },
          },
        });
        shaped = shapeCargo({ ...updated, packages });
      },
    );
    assertApplied(result);
    return shaped!;
  }

  // Mediated @delete. Package/Item cascade via the schema's onDelete: Cascade (Cargo->Package,
  // Package->Item), so no extra cleanup is needed here.
  async remove(queryId: string, cid: string, user: RequestUser): Promise<void> {
    // S5.9.5 (D6) — a locked query (`awardSnapshot != null`, i.e. QUOTING_CLIENT /
    // AWAITING_CLIENT_DECISION) refuses every write. First, before any other read, so a locked
    // query never does partial work.
    await this.lock.assertUnlocked(queryId);
    await this.load(queryId, cid);
    const result = await this.mediator.apply(
      { entity: "cargo", id: cid, action: "@delete", queryId, actorId: user.userId },
      async (tx) => {
        await tx.cargo.delete({ where: { id: cid } });
      },
    );
    assertApplied(result);
  }

  // Server-side exceljs stream, single worksheet "Packing List" (design §8.3) — re-added at the
  // new grain (Task 9) after Task 4 dropped the old flat one-row-per-CargoItem export. ONE ROW
  // PER ITEM: package+cargo context repeats on every item row of that package. A package with no
  // items still emits one row (item columns blank); every row of a DG package shows "Yes" in
  // DG (Yes/No) since DG/MSDS is a package-level safety attribute, not an item one. A trailing
  // TOTAL row closes the sheet with the distinct package count + Σ gross + Σ volume, summed once
  // per package (not per item, so a multi-item package isn't double-counted).
  async exportXlsx(queryId: string): Promise<Buffer> {
    // getTree already 404s a missing query via its own assertQueryExists — no need to repeat it.
    const cargos = await this.getTree(queryId);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Packing List");
    ws.columns = [
      { header: "Cargo #", key: "cargoNo", width: 8 },
      { header: "PO / Reference", key: "poReference", width: 18 },
      { header: "Package No", key: "packageNo", width: 14 },
      { header: "Package Type", key: "packageType", width: 14 },
      { header: "Dim L (cm)", key: "dimL", width: 12 },
      { header: "Dim W (cm)", key: "dimW", width: 12 },
      { header: "Dim H (cm)", key: "dimH", width: 12 },
      { header: "Gross Wt (kg)", key: "grossWt", width: 12 },
      { header: "Net Wt (kg)", key: "netWt", width: 12 },
      { header: "Volume (CBM)", key: "volumeCbm", width: 14 },
      { header: "Package Tags", key: "packageTags", width: 20 },
      { header: "SN", key: "sn", width: 6 },
      { header: "Product", key: "product", width: 24 },
      { header: "Qty", key: "qty", width: 8 },
      { header: "UoM", key: "uom", width: 8 },
      { header: "HSN", key: "hsCode", width: 14 },
      { header: "Item Tags", key: "itemTags", width: 20 },
      { header: "DG (Yes/No)", key: "dg", width: 10 },
    ];
    ws.getRow(1).font = { bold: true };

    // Totals row accumulators (§8.3: "package count, Σ gross, Σ volume"). Incremented once per
    // PACKAGE below (outside the item/blank-row branch), never once per item — a multi-item
    // package must contribute its gross/volume exactly once, not once per item row it renders.
    let packageCount = 0;
    let grossSum = 0;
    let volumeSum = 0;

    for (const cargo of cargos) {
      for (const pkg of cargo.packages) {
        packageCount += 1;
        grossSum += Number(pkg.grossWt);
        volumeSum += pkg.volumeCbm == null ? 0 : Number(pkg.volumeCbm);
        const base = {
          cargoNo: cargo.rowIndex + 1,
          poReference: cargo.poReference ?? "",
          packageNo: pkg.packageNo,
          packageType: pkg.packageType,
          dimL: Number(pkg.dimL),
          dimW: Number(pkg.dimW),
          dimH: Number(pkg.dimH),
          grossWt: Number(pkg.grossWt),
          netWt: pkg.netWt == null ? "" : Number(pkg.netWt),
          volumeCbm: pkg.volumeCbm == null ? "" : Number(pkg.volumeCbm),
          packageTags: pkg.effectiveTags.join(", "),
          // DG/MSDS is a PACKAGE-level safety attribute (effectiveTags = own tags ∪ item tags),
          // so every row of a DG package — including its blank-item row — shows "Yes" here, even
          // though the underlying "DG" tag may have been set on an item rather than the package.
          dg: pkg.effectiveTags.includes("DG") ? "Yes" : "No",
        };
        if (pkg.items.length === 0) {
          // A package with no items still gets exactly one row — cargo/package columns filled,
          // item-only columns blank — so the packing list shows every package, not just the
          // ones someone got around to itemizing.
          ws.addRow({ ...base, sn: "", product: "", qty: "", uom: "", hsCode: "", itemTags: "" });
        } else {
          pkg.items.forEach((item, idx) => {
            ws.addRow({
              ...base,
              sn: idx + 1,
              product: item.product ?? "",
              qty: item.qty == null ? "" : Number(item.qty),
              uom: item.uom ?? "",
              hsCode: item.hsCode ?? "",
              itemTags: item.tags.join(", "),
            });
          });
        }
      }
    }

    // TOTAL row: "Package No" carries the TOTAL label (§8.3); the distinct package count has no
    // single obviously-right column of its own, so it goes in the adjacent "Package Type" cell
    // (clearly a count, not a real package type, in context). Gross/volume sums land under their
    // own columns. Every other cell on this row is left blank.
    const totalsRow = ws.addRow({
      packageNo: "TOTAL",
      packageType: packageCount,
      grossWt: Number(grossSum.toFixed(3)),
      volumeCbm: Number(volumeSum.toFixed(6)),
    });
    totalsRow.font = { bold: true };

    // exceljs's own .d.ts declares a local `Buffer extends ArrayBuffer {}` for writeBuffer()'s
    // return type (browser-compat artifact) rather than Node's real Buffer, so `as Buffer` fails
    // strict structural overlap checking. At runtime (lib/utils/stream-buf.js) it always returns
    // a genuine Node Buffer via Buffer.concat(...); Buffer.from(...) both satisfies tsc against
    // the declared ArrayBuffer-shaped type and is a correct (if redundantly-copying) no-op on an
    // already-real Buffer at runtime — no `any` needed.
    return Buffer.from(await wb.xlsx.writeBuffer());
  }
}
