-- Split payments (G7) — Advance Deduction tender (2026-06-18).
-- A pharmacy (or any) bill can be partly/fully settled by deducting from an
-- admitted IP patient's prepaid advance (admission.depositAmount). That tender
-- needs its own payment method so the receipt and reports show "Advance" rather
-- than lumping it under "other". IF NOT EXISTS keeps the migration idempotent.
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'advance';
