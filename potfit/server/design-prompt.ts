// Instructions and prompts for the Codex design agent, which writes the
// design scripts that tools/potlib.ts runs.

import type { FitSettings, ParamValues, PotModel, ReferencePot } from '../shared/types.ts';

export const DESIGN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'summary', 'warnings', 'confidence'],
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    warnings: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
};

export function designAgentsMd(manifoldTypes: string): string {
  return `# Pot design workspace

You design decorative outer pots (cachepots) for 3D printing. Each one holds a
particular nursery pot: the plain plastic pot the plant actually grows in. The
user describes the pot in words, reference images, or both. You write a
JavaScript design script; the app builds it into a mesh and shows it in a 3D
view and a side-on section. The user can change the parameters you expose and
send you feedback.

## Files

- \`design.mjs\`: the design script. Edit it in place; it is the design.
- \`state.json\`: the nursery pot ("reference"), the fit goals, the user's
  current parameter values ("params"), their description and the reference
  images. The app rewrites it before every turn. Don't edit it.
- \`refs/\`: the user's reference images. Look at every one of them.
- \`out/\`: what \`./pot-tool build\` and \`preview\` write: design.stl,
  report.json, preview.png, section.png.
- \`./pot-tool\`: \`build\`, \`preview\`, \`check\`, \`render\` (\`./pot-tool help\`).

## Design frame

Millimetres, +Z up, the base on z = 0, and the pot's axis on x = y = 0: the
nursery pot is centred on it. The front of the pot faces -Y; the app opens on
the front and the preview's first view looks at it. The nursery pot is a
frustum, radius bottomOD/2 at its base and topOD/2 at its rim.

## The script

\`\`\`js
export const params = {
  wall: { value: 3, min: 1.6, max: 8, step: 0.2, label: 'Wall', unit: 'mm' },
  ears: { value: true, label: 'Ears' },
  face: { value: 'smile', options: ['smile', 'sleepy'], label: 'Face' },
};

export default function design({ pot, lib, sdf, M, CS, params, note }) {
  const L = pot.layout({ floor: 2.4 });
  const body = lib.lathe(lib.smooth([[L.cavityRadius(0) + params.wall, 0], [L.cavityRadius(L.rimZ) + params.wall, L.rimZ]]));
  return body.subtract(L.cavity());
}
\`\`\`

Return one Manifold (an array is unioned). It must be one solid piece standing
on z = 0 with the cavity cut by \`L.cavity()\`.

### pot

- \`pot.reference\` { name, topOD, bottomOD, height } and \`pot.fit\`
  { clearance (diametral), topOffset (how far the nursery pot's rim stands
  above the pot's rim; null means no goal), floorGap }.
- \`pot.layout({ floor })\` returns L, with the nursery pot seated on a floor
  \`floor\` mm thick:
  - \`L.floorZ\`: top of the floor. \`L.seatZ\`: the nursery pot's base.
    \`L.nurseryTopZ\`: its rim.
  - \`L.rimZ\`: the height your pot's rim must have to meet the rim-offset goal.
  - \`L.cavityRadius(z)\`: the free radius the cavity needs at height z (the
    nursery pot plus clearance, and room for it to go in from above). The outer
    surface must stay at least a wall thickness beyond it from floorZ to rimZ.
  - \`L.cavity({ extra = 0, top })\`: the cavity as a solid. Subtract it last,
    after every decoration is added, so nothing intrudes into it.
  - \`L.drainHoles({ count = 1, diameter = 6, ring })\`: holes through the
    floor to subtract (one in the middle, or count around a ring).
  - \`L.nursery()\`: the seated nursery pot, for checks only.

### lib (all lengths mm, angles degrees unless noted)

- \`lib.lathe(points, { segments })\`: solid of revolution from an outer
  profile of [r, z] points, bottom to top, closed along the axis.
- \`lib.revolve(polygon)\`: revolve any closed [r, z] polygon (beads, lips, rings).
- \`lib.radial({ radius: (angle, z) => r, z0 = 0, z1, segments = 256, step = 0.5 })\`:
  solid whose surface is r(angle, z), with flat ends; angle in radians,
  counter-clockwise from +X seen from above. For twisted, faceted, lobed,
  ribbed and textured bodies.
- \`lib.shapes\`: factors for radial() with maximum 1, corners at angle 0:
  \`polygon(n, rounding 0..1)\`, \`lobes(n, depth)\`, \`scallops(n, depth)\`,
  \`star(n, depth)\`, \`circle()\`; and \`ribs(n, height, width = 0.5,
  'round' | 'v' | 'square')\`, which returns mm to add (negative height cuts
  flutes). Twist by subtracting an angle that grows with z.
- \`lib.interp([[x, y], ...])\`: smooth function through points, no overshoot
  (good for radius against height).
- \`lib.smooth(points, samples = 8)\`: dense smooth curve through 2D or 3D points.
- \`lib.sphere(c, r)\`, \`lib.ellipsoid(c, [rx, ry, rz])\`,
  \`lib.box(c, [sx, sy, sz], { round, rotate: [x, y, z] })\`,
  \`lib.cylinder(a, b, r1, r2)\`, \`lib.capsule(a, b, r1, r2)\`,
  \`lib.tube(points, radius | radii[] | (t) => r)\`,
  \`lib.torus(c, R, r, { rotate })\` (around Z unless rotated).
- \`lib.symmetric(m)\`: m plus its mirror across x = 0, for left/right pairs.
- \`lib.union([...])\`.
- \`lib.fromSDF(fn, { min, max }, edge = 0.6)\`: mesh a signed distance
  function (negative inside) over a box. Keep the shape inside the box. edge
  0.4 to 1 mm; finer is slower (about a second per 10M cells).
- \`lib.surface(body, from, to)\`: where the segment from -> to first enters
  body, with the normal, or null. Use it to sit features on a curved surface.
- \`lib.trimBase(m, z = 0)\`: cut off everything below z, for a flat base.
- \`lib.soften(m, { minSharpAngle = 60, edge = 1 })\`: round creases (slow on
  big meshes).

### sdf (signed distance functions, negative inside; for lib.fromSDF)

\`sdf.sphere(c, r)\`, \`sdf.ellipsoid(c, radii)\`, \`sdf.box(c, size, round)\`,
\`sdf.capsule(a, b, r1, r2)\`, \`sdf.tube(points, r, k)\`, \`sdf.torus(c, R, r)\`,
\`sdf.lathe(points)\`, \`sdf.union(...)\`, \`sdf.smoothUnion(k, ...)\` (blends
with a fillet of about k mm, like a sculpt), \`sdf.subtract(a, b)\`,
\`sdf.smoothSubtract(k, a, b)\`, \`sdf.intersect(a, b)\`,
\`sdf.translate(f, v)\`, \`sdf.rotateZ(f, degrees)\`.

For characters and other organic shapes, build the body and limbs as one
smooth-unioned SDF (sdf.lathe for the body), mesh it with lib.fromSDF, then cut
precise features (eyes, mouth, cavity) with lib/M booleans.

### M, CS

The manifold-3d Manifold and CrossSection classes, for anything else:
\`M.cube/cylinder/sphere/hull/union\`, \`.add .subtract .intersect\`,
\`.translate .rotate([x, y, z]) .scale .mirror .warp .refineToLength
.smoothOut .trimByPlane\`, \`CS.circle/square\`, \`.extrude(h, divisions,
twist, scaleTop)\`, \`.revolve()\`, \`.offset()\`. Types:
${manifoldTypes}

### params

Expose 3 to 8 values a user would want to change: sizes in mm, counts,
features on or off, styles. Each is { value, min, max, step, label, unit } for
numbers, { value: true/false, label } or { value, options: [...], label }.
state.json "params" holds the user's current values: make them your defaults
unless the user asks otherwise. The design must build at any value in range.

### note(text)

Adds a line to the build report, e.g. a dimension you want the user to see.

## Printing rules (FDM, printed upright, as designed)

- One solid piece, flat base on z = 0 (\`lib.trimBase\` if parts dip below).
- Walls at least 1.6 mm (2.4 to 3 mm is typical), floor at least 1.6 mm.
- No overhang steeper than 45° from vertical: chamfer the undersides of arms,
  chins, ledges and lips at 45°, or let them grow out of the body gradually.
  \`./pot-tool build\` lists overhangs; keep the total small (under about
  25 mm²) unless the user accepts supports, and say so if you can't.
- Details: raised features at least 1 mm, engraved lines at least 0.8 mm wide
  and 0.5 mm deep. Nothing thinner than 1.2 mm sticking out.
- Keep decorations out of the cavity and the opening; nothing across the top.
- Just big enough: the nursery pot, the walls and the decoration.

## Workflow

1. Read state.json. Look at every image in refs/ and every image attached to
   the prompt. Work out the shape, proportions, features and style.
2. Write design.mjs.
3. \`./pot-tool build\`: fix every error and warning. The nursery pot must
   clear, and the rim offset and floor gap must match the goals.
4. \`./pot-tool preview\`, then look at out/preview.png (front, right side,
   three-quarter, top) and out/section.png. Compare them with the references
   and the description and improve the design; two to five rounds is normal.
   \`./pot-tool preview --view 0,20 --out out/closeup.png\` gives one large view.
   preview, check and render rebuild first if design.mjs changed since the
   last build, but read the build report each time: it is how you know the
   design is still one piece that fits.
5. Make sure the final design.mjs builds, then reply with the JSON answer.

Work only in this directory. Don't edit state.json or the images in refs/.

## Answer

- \`title\`: two to four words naming the design.
- \`summary\`: 2-5 plain sentences: what you made, the outer size and wall, how
  it follows the references, any compromise.
- \`warnings\`: what the user should check (supports, fragile parts, likeness
  limits). Empty if none.
- \`confidence\`: how sure you are that it is what the user wants.
`;
}

const mm = (v: number) => `${Number(v.toFixed(3))} mm`;

function describeGoals(ref: ReferencePot, fit: FitSettings): string {
  return [
    `Nursery pot: ${ref.name}: top OD ${mm(ref.topOD)}, bottom OD ${mm(ref.bottomOD)}, height ${mm(ref.height)}${ref.notes ? ` (${ref.notes})` : ''}`,
    `Clearance: ${mm(fit.clearance)} diametral`,
    `Rim offset goal: ${fit.topOffset === null ? 'none (rim level with the nursery pot\'s)' : `nursery pot's rim ${mm(fit.topOffset)} ${fit.topOffset >= 0 ? 'above' : 'below'} the pot's rim`}`,
    `Floor gap: ${mm(fit.floorGap)}`,
  ].join('\n');
}

export interface PromptImage {
  /** File name as attached, e.g. ref-1.jpg or section.png. */
  name: string;
}

function describeImages(images: PromptImage[]): string {
  if (images.length === 0) return '';
  const label = (n: string) =>
    n.startsWith('section')
      ? 'the app\'s section view of the current design (nursery pot in green)'
      : n.startsWith('view')
        ? 'the app\'s 3D view of the current design'
        : `a reference image from the user (refs/${n})`;
  return `\nAttached images, in order: ${images.map((i) => label(i.name)).join('; ')}.\n`;
}

const paramsLine = (p: ParamValues) => (Object.keys(p).length ? JSON.stringify(p) : '(none yet)');

export function designPrompt(model: PotModel, ref: ReferencePot, description: string, images: PromptImage[]): string {
  return `Design a new pot for the user.

${description.trim() ? `The user's description:\n"""\n${description.trim()}\n"""` : 'The user gave no description; work from the reference images.'}
${describeImages(images)}
${describeGoals(ref, model.fit)}

design.mjs holds the current design: a plain starter pot if this is a new design. Replace it or build on it, whichever the request needs. Current parameter values: ${paramsLine(model.design?.params ?? {})}

Follow AGENTS.md: build, preview and compare until it looks right, then reply with the JSON answer.`;
}

export function designFeedbackPrompt(model: PotModel, ref: ReferencePot, feedback: string, images: PromptImage[], failed: string | null): string {
  return `The user looked at the design and has feedback:

"""
${feedback.trim()}
"""
${describeImages(images)}
${describeGoals(ref, model.fit)}

Parameter values the user has set: ${paramsLine(model.design?.params ?? {})}
${failed ? `\nNote: ${failed}\n` : ''}
state.json is up to date. Change design.mjs to address the feedback, build, preview and check it, then reply with the JSON answer.`;
}
