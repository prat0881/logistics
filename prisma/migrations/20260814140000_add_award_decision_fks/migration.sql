ALTER TABLE "LegAwardDecision" ADD CONSTRAINT "LegAwardDecision_legId_fkey"   FOREIGN KEY ("legId")   REFERENCES "Leg"("id")   ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LegAwardDecision" ADD CONSTRAINT "LegAwardDecision_queryId_fkey" FOREIGN KEY ("queryId") REFERENCES "Query"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AwardDecisionEvent" ADD CONSTRAINT "AwardDecisionEvent_legId_fkey"   FOREIGN KEY ("legId")   REFERENCES "Leg"("id")   ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AwardDecisionEvent" ADD CONSTRAINT "AwardDecisionEvent_queryId_fkey" FOREIGN KEY ("queryId") REFERENCES "Query"("id") ON DELETE CASCADE ON UPDATE CASCADE;
