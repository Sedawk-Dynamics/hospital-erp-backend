-- Two reference fields on the vendor master, used by pharmacy + inventory
-- procurement (there is no vendor login / AP ledger — these are informational,
-- like payment_term_days already is):
--   credit_limit  — max ₹ outstanding the accounts team will carry with a vendor
--   payment_mode  — how the vendor is usually settled (cash/cheque/neft/upi/credit)
ALTER TABLE "suppliers" ADD COLUMN "credit_limit" DECIMAL(12,2);
ALTER TABLE "suppliers" ADD COLUMN "payment_mode" VARCHAR(30);
