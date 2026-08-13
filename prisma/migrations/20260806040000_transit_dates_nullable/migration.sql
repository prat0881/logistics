-- FF Portal v2 (Task 9, addendum 3): TransitPlan.departureDate/arrivalDate were leftover
-- NOT NULL columns from v1's single-pair-of-dates transit shape. v2's submit gate replaced that
-- with mandatory `guaranteedTransitDays` (Q_TRANSIT) and made the mode-specific dates
-- (plannedDeparture/plannedArrival, etd/eta, plannedPickupDate) all optional -- so a v2 draft can
-- be fully valid and submittable with no generic departureDate/arrivalDate to derive these two
-- legacy columns from at all. ff-portal.service.ts's `submit` used to force-unwrap them
-- (`new Date(draft.transit.departureDate!)`), and `new Date(null)` doesn't throw -- it silently
-- writes 1970-01-01T00:00:00.000Z to a NOT NULL column instead of erroring, corrupting every
-- such quote's TransitPlan row. Dropping NOT NULL lets submit persist a genuine null instead.
ALTER TABLE "TransitPlan" ALTER COLUMN "departureDate" DROP NOT NULL;
ALTER TABLE "TransitPlan" ALTER COLUMN "arrivalDate" DROP NOT NULL;
