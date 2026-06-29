-- Retire the Product Resolution Engine's learned distributor → product mapping.
-- Inward/scan resolution now relies on GTIN, formulary similarity, and the
-- platform drug catalog only. Vendor ↔ medicine links (supplier relations,
-- purchase-order items) live in other tables and are unaffected.

DROP TABLE IF EXISTS "distributor_product_map" CASCADE;
