-- Retire the legacy Stage-3 comms path (EmailLog / Escalation + their enums).
-- Emails + escalations now run through MessageLog / ScheduledEvent (comms framework).
-- Backfill first (preserving ids), then drop the now-unused tables and enum types.

-- (a) EmailLog -> MessageLog (entityType QUERY, channel EMAIL)
INSERT INTO "MessageLog" ("id", "tenantId", "entityType", "entityId", "eventKey", "channel", "templateKey", "fromAddress", "toAddress", "subject", "bodyRendered", "tokens", "composedById", "status", "createdAt")
SELECT
  "id", "tenantId", 'QUERY', "queryId",
  CASE "template"
    WHEN 'FOLLOW_UP' THEN 'query.follow_up'
    WHEN 'ACKNOWLEDGEMENT' THEN 'query.acknowledgement'
    WHEN 'ESCALATION' THEN 'query.escalation'
  END,
  'EMAIL'::"Channel",
  CASE "template"
    WHEN 'FOLLOW_UP' THEN 'query.follow_up.email'
    WHEN 'ACKNOWLEDGEMENT' THEN 'query.acknowledgement.email'
    WHEN 'ESCALATION' THEN 'query.escalation.email'
  END,
  "fromAddress", "toAddress", "subject", "bodyRendered", "tokens", "composedById", 'LOGGED'::"MessageStatus", "createdAt"
FROM "EmailLog";

-- (b) Escalation -> ScheduledEvent (eventKey query.escalation; tier carried as text)
INSERT INTO "ScheduledEvent" ("id", "tenantId", "entityType", "entityId", "eventKey", "tier", "dueAt", "firedAt", "cancelledAt", "createdAt")
SELECT "id", "tenantId", 'QUERY', "queryId", 'query.escalation', "tier"::text, "dueAt", "firedAt", "cancelledAt", "createdAt"
FROM "Escalation";

-- (c) drop the legacy tables (removes their FKs to Query automatically)
DROP TABLE "EmailLog";

-- (d)
DROP TABLE "Escalation";

-- (e) drop the now-unused enum types (Role is shared with User and is NOT dropped)
DROP TYPE "EmailTemplate";
DROP TYPE "EscalationTier";
DROP TYPE "EmailStatus";
DROP TYPE "NotificationType";
