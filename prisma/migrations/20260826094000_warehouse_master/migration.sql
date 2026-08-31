CREATE TYPE "WarehouseType" AS ENUM ('OWNED', 'CONTRACTED', 'CLIENT', 'FF');
CREATE TYPE "CapacityUnit" AS ENUM ('CBM', 'PALLETS', 'SQ_FT', 'MT');
CREATE TYPE "HandlingUnit" AS ENUM ('PER_PALLET', 'PER_CBM', 'PER_MT', 'PER_SHIPMENT', 'PER_PACKAGE');
CREATE TYPE "StorageUnit" AS ENUM (
  'PER_CBM_DAY', 'PER_CBM_MONTH', 'PER_PALLET_DAY',
  'PER_PALLET_MONTH', 'PER_SQ_FT_MONTH', 'PER_MT_DAY'
);
CREATE TYPE "WarehouseCapability" AS ENUM (
  'DG_COMPATIBLE', 'TEMPERATURE_CONTROLLED', 'HUMIDITY_CONTROLLED',
  'FIRE_FIGHTING', 'REEFER_COLD_STORAGE', 'CCTV_ACCESS'
);

CREATE TABLE "Warehouse" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID,
  "name" TEXT NOT NULL,
  "type" "WarehouseType" NOT NULL,
  "freightForwarderId" UUID,
  "clientId" UUID,
  "streetAddress" TEXT NOT NULL,
  "country" TEXT NOT NULL,
  "city" TEXT NOT NULL,
  "pinCode" TEXT NOT NULL,
  "capacity" DECIMAL(14,2) NOT NULL,
  "capacityUnit" "CapacityUnit" NOT NULL,
  "capabilities" "WarehouseCapability"[] NOT NULL DEFAULT ARRAY[]::"WarehouseCapability"[],
  "agreementValidUntil" TIMESTAMP(3),
  "insuranceValidUntil" TIMESTAMP(3),
  "isBonded" BOOLEAN NOT NULL DEFAULT FALSE,
  "weekendWorking" BOOLEAN NOT NULL DEFAULT FALSE,
  "weekendWorkingFee" DECIMAL(14,2),
  "workingEmployees" INTEGER,
  "forkLiftCount" INTEGER,
  "dipTrayCount" INTEGER,
  "freeStorageDays" INTEGER NOT NULL DEFAULT 0,
  "rateCurrency" TEXT,
  "handlingRate" DECIMAL(14,2),
  "handlingUnit" "HandlingUnit",
  "storageRate" DECIMAL(14,2),
  "storageUnit" "StorageUnit",
  "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
  -- TEXT, not UUID: consistent with every other master table (see
  -- 20260826093000_ff_contacts_and_terms). These columns carry no foreign key, so a UUID type
  -- would force a guard that silently nulls a malformed actor id, and would reject this repo's
  -- e2e JWT convention of a `sub` like "u-<ROLE>" with Prisma P2023.
  "createdById" TEXT,
  "updatedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Warehouse_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Warehouse_name_key" ON "Warehouse" ("name");
CREATE INDEX "Warehouse_tenantId_idx" ON "Warehouse" ("tenantId");
CREATE INDEX "Warehouse_freightForwarderId_idx" ON "Warehouse" ("freightForwarderId");
CREATE INDEX "Warehouse_clientId_idx" ON "Warehouse" ("clientId");

-- SET NULL, not CASCADE: deleting a forwarder must not delete a warehouse that exists in
-- the physical world. The warehouse simply becomes unassigned.
ALTER TABLE "Warehouse" ADD CONSTRAINT "Warehouse_ff_fkey"
  FOREIGN KEY ("freightForwarderId") REFERENCES "FreightForwarder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Warehouse" ADD CONSTRAINT "Warehouse_client_fkey"
  FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "WarehouseContact" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID,
  "warehouseId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "designation" TEXT,
  "email" TEXT NOT NULL,
  "contactNo" TEXT NOT NULL,
  "whatsappAvailable" BOOLEAN NOT NULL DEFAULT FALSE,
  "wechatAvailable" BOOLEAN NOT NULL DEFAULT FALSE,
  "botimAvailable" BOOLEAN NOT NULL DEFAULT FALSE,
  "pocLevel" "PocLevel" NOT NULL DEFAULT 'NONE',
  "isWeekendIncharge" BOOLEAN NOT NULL DEFAULT FALSE,
  "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
  -- TEXT, not UUID: see the note on Warehouse.createdById above.
  "createdById" TEXT,
  "updatedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WarehouseContact_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "WarehouseContact_warehouseId_idx" ON "WarehouseContact" ("warehouseId");
ALTER TABLE "WarehouseContact" ADD CONSTRAINT "WarehouseContact_warehouse_fkey"
  FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX "WarehouseContact_one_primary"
  ON "WarehouseContact" ("warehouseId") WHERE "pocLevel" = 'PRIMARY';

CREATE TABLE "WarehouseVehicle" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "warehouseId" UUID NOT NULL,
  "tonnage" "TruckTonnage" NOT NULL,
  "quantity" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WarehouseVehicle_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "WarehouseVehicle_warehouseId_idx" ON "WarehouseVehicle" ("warehouseId");
ALTER TABLE "WarehouseVehicle" ADD CONSTRAINT "WarehouseVehicle_warehouse_fkey"
  FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE CASCADE ON UPDATE CASCADE;
