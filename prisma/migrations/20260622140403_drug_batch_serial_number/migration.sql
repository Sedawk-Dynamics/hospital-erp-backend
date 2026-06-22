-- DataMatrix serial (GS1 AI 21) captured at receipt for track-and-trace.
ALTER TABLE "drug_batches" ADD COLUMN "serial_number" VARCHAR(80);
