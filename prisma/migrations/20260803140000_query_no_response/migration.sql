-- Extend existing enum (PG12+: ADD VALUE is fine in a tx as long as the value isn't USED in this tx -- it isn't)
ALTER TYPE "QueryStatus" ADD VALUE 'NO_RESPONSE';
