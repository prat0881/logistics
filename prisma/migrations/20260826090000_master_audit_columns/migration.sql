ALTER TABLE "Client"               ADD COLUMN "createdById" UUID, ADD COLUMN "updatedById" UUID;
ALTER TABLE "ClientContact"        ADD COLUMN "createdById" UUID, ADD COLUMN "updatedById" UUID;
ALTER TABLE "Vessel"               ADD COLUMN "createdById" UUID, ADD COLUMN "updatedById" UUID;
ALTER TABLE "FreightForwarder"     ADD COLUMN "createdById" UUID, ADD COLUMN "updatedById" UUID;
ALTER TABLE "ChargeLineDefinition" ADD COLUMN "createdById" UUID, ADD COLUMN "updatedById" UUID;
