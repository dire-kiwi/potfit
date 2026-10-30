// A plain tapered pot with optional rim and foot bands, sized around the
// reference pot. New designs start from this script. AGENTS.md documents the
// toolkit (pot, lib, sdf, M, CS, params, note).

export const params = {
  wall: { value: 3, min: 1.6, max: 10, step: 0.2, label: 'Wall', unit: 'mm' },
  floor: { value: 2.4, min: 1.2, max: 10, step: 0.2, label: 'Floor', unit: 'mm' },
  flare: { value: 2, min: -10, max: 20, step: 0.5, label: 'Extra flare at the rim', unit: 'mm' },
  bands: { value: true, label: 'Rim and foot bands' },
  holes: { value: 0, min: 0, max: 7, step: 1, label: 'Drainage holes' },
};

export default function design({ pot, lib, params: p }) {
  const L = pot.layout({ floor: p.floor });
  const top = L.rimZ;
  const base = L.cavityRadius(L.floorZ) + p.wall;
  const rim = L.cavityRadius(top) + p.wall + p.flare;
  const at = (z) => base + ((rim - base) * z) / top;

  // Outer profile, bottom to top, as [radius, height]. Steps out are 45° so
  // they print without supports; the foot has a small chamfer against
  // elephant's foot.
  const outline = [[base - 0.6, 0], [base, 0.6]];
  if (p.bands) {
    outline.push([base + 1.6, 2.2], [base + 1.6, 5], [at(6.6), 6.6]);
    outline.push([at(top - 7), top - 7], [at(top - 7) + 1.8, top - 5.2], [at(top - 7) + 1.8, top]);
  } else {
    outline.push([rim, top]);
  }

  let body = lib.lathe(outline).subtract(L.cavity());
  if (p.holes > 0) body = body.subtract(L.drainHoles({ count: p.holes, diameter: 6 }));
  return body;
}
