-- Vendor credit period: how many days we have to pay the vendor after an invoice.
ALTER TABLE "suppliers" ADD COLUMN "payment_term_days" INTEGER;
