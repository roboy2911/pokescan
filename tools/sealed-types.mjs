// Shared by tools/update-prices.mjs (English) and tools/prices-ja.mjs (Japanese).

/* Kind of sealed product, from its TCGplayer name. Order matters (most specific first).
 * The app's Australian RRP table (prices.js) is keyed by these names. */
export const SEALED_TYPES = [
  [/\bcase\b/i, 'Case'],
  [/display/i, 'Display'],
  [/half booster box/i, 'Half Booster Box'],
  [/booster box/i, 'Booster Box'],
  [/pokemon center elite trainer box/i, 'Pokémon Center Elite Trainer Box'],
  [/elite trainer box/i, 'Elite Trainer Box'],
  [/booster bundle/i, 'Booster Bundle'],
  [/art bundle/i, 'Booster Pack Art Bundle'],
  [/sleeved booster/i, 'Sleeved Booster Pack'],
  [/booster pack|booster$/i, 'Booster Pack'],
  [/3-pack blister|three[- ]pack|3 pack/i, '3-Pack Blister'],
  [/2-pack blister/i, '2-Pack Blister'],
  [/blister/i, 'Blister'],
  [/ultra[- ]premium collection/i, 'Ultra-Premium Collection'],
  [/super[- ]premium collection/i, 'Super-Premium Collection'],
  [/premium collection/i, 'Premium Collection'],
  [/mini tin/i, 'Mini Tin'],
  [/\btin\b/i, 'Tin'],
  [/build & battle stadium/i, 'Build & Battle Stadium'],
  [/build & battle/i, 'Build & Battle Box'],
  [/battle deck|theme deck|league battle deck/i, 'Deck'],
  [/surprise box/i, 'Surprise Box'],
  [/collection|\bbox\b/i, 'Collection Box'],
];
export const sealedType = (name) => SEALED_TYPES.find(([re]) => re.test(name))?.[1] ?? 'Other';
