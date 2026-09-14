import { z } from 'zod';

/**
 * What KIND of stock something is. Mirrors the `InventoryCategory` enum in the
 * Prisma schema.
 *
 * This list used to be typed out by hand in ten validation schemas. Adding a
 * kind then meant finding every copy — and a missed one does not fail loudly: a
 * request carrying the new value is simply rejected by whichever route still
 * has the old list, long after the feature looks finished. One list, used
 * everywhere, removes that.
 */
export const INVENTORY_CATEGORIES = [
  'drug',
  'product',
  'consumable',
  'surgical_supply',
  'equipment',
  'other',
] as const;

export type InventoryCategoryValue = (typeof INVENTORY_CATEGORIES)[number];

export const inventoryCategorySchema = z.enum(INVENTORY_CATEGORIES);
