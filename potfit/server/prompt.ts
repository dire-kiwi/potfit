// Instructions and prompts for the Codex fit agent.

import type { FitSettings, PotModel, ReferencePot } from '../shared/types.ts';

const vec3 = {
  type: 'object',
  additionalProperties: false,
  required: ['x', 'y', 'z'],
  properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
};

export const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['transform', 'fit', 'summary', 'warnings', 'confidence', 'editedMesh'],
  properties: {
    transform: {
      type: 'object',
      additionalProperties: false,
      required: ['up', 'spin', 'position', 'scale'],
      properties: {
        up: { type: 'string', enum: ['+X', '-X', '+Y', '-Y', '+Z', '-Z'] },
        spin: { type: 'number' },
        position: vec3,
        scale: vec3,
      },
    },
    fit: {
      type: 'object',
      additionalProperties: false,
      required: ['clearance', 'scaleMode', 'topOffset', 'floorGap'],
      properties: {
        clearance: { type: 'number' },
        scaleMode: { type: 'string', enum: ['uniform', 'radial-height'] },
        topOffset: { type: ['number', 'null'] },
        floorGap: { type: 'number' },
      },
    },
    summary: { type: 'string' },
    warnings: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    editedMesh: { type: ['string', 'null'] },
  },
};

/** How to edit the mesh with Blender, for AGENTS.md; or why it can't be edited. */
function meshEditing(blender: string | null): string {
  if (!blender) {
    return `## Editing the mesh

Blender isn't installed on this server, so you can't change the mesh: only
place it. If the user asks for a change to the shape, say so in the summary
and leave \`editedMesh\` null.
`;
  }
  return `## Editing the mesh

Placing the pot can't fix everything. When the user asks for a change to the
shape itself (fill the empty space under the nursery pot, thicken a floor,
add or close a drainage hole, cut something off), edit the mesh with
${blender}, which runs headless here as \`./blender\`.

1. \`./pot-tool place --z-up --transform '<json>' --out placed.stl\` writes the
   pot as that transform places it, turned Z up for Blender: millimetres, the
   nursery pot's base centre at the origin and its axis along +Z, so it
   reaches z = height and the outer pot's floor is below z = 0 by the floor
   gap. Use the transform you mean to return.
2. Write a Blender script and run it: \`./blender -P edit.py -- <args>\`. It
   can \`import potfit_bpy as pb\`, which has the common steps (open its file
   to see them all): \`pb.reset()\`, \`pb.load(path)\`, \`pb.save(obj, path)\`,
   \`pb.boolean(a, b, 'UNION' | 'DIFFERENCE' | 'INTERSECT')\`,
   \`pb.cylinder(r, z0, z1)\`, \`pb.box(...)\`, \`pb.clean(obj)\`, \`pb.report(obj)\`
   (triangles, volume, pieces, whether it is a closed solid), and
   \`pb.fill_cavity(pot, top)\`, which fills the cavity solid from its floor
   up to z = top, following the walls whatever their shape. For the space
   under the nursery pot, top is minus the floor gap:

   \`\`\`python
   import potfit_bpy as pb
   pb.reset()
   pot = pb.load("placed.stl")
   pot = pb.fill_cavity(pot, top=-0.0)  # -floorGap
   print(pb.report(pot))
   pb.save(pot, "placed-edited.stl")
   \`\`\`

3. \`./pot-tool unplace --z-up --transform '<the same json>' --in placed-edited.stl --out edited.stl\`
   turns it back into mesh.stl's raw coordinates and prints the transform
   that puts it where you edited it (the bounding box may have changed).
4. \`./pot-tool check --mesh edited.stl --transform '<that>'\` and
   \`./pot-tool render --mesh edited.stl --transform '<that>' --out edited.png\`:
   check the fit and look at the section.
5. Answer with \`editedMesh: "edited.stl"\` and that transform. The app makes
   it the model's mesh (the user can revert it), and from the next turn
   mesh.stl is the edited mesh.

Rules for edits:

- Only edit when the user asks for a change to the shape, or agrees to one
  you suggest. Otherwise leave \`editedMesh\` null.
- The result must be one closed solid (\`pb.report\`: closed_solid true,
  pieces 1). Leave the outside of the pot as it was unless asked.
- Fill solid rather than leaving a hollow shelf: a shelf over a void needs
  supports, and the slicer's infill keeps a solid fill light. Mention the
  extra material (the report's volume) in the summary.
- The edit is made at this fit's scale and stored unscaled, so if the fit is
  rescaled later, the edit scales with it; say so if it matters.
- Keep the triangle count near the original's; don't remesh a detailed model.
`;
}

export function agentsMd(blender: string | null): string {
  return `# Pot fitting workspace

You fit a 3D model of a decorative outer pot (a cachepot) around a reference
nursery pot: the plain inner pot that actually holds the plant. The user sees
your answer in a three.js app with a 3D view and a side-on section view; they
can move and scale the pot by hand and send you feedback.

## Files

- \`mesh.stl\`: the outer pot model in raw imported coordinates (assume mm). Do not modify it.
- \`state.json\`: the reference pot, the fit settings and the transform shown in
  the app right now (it includes any manual edits). The app rewrites it before
  every turn. Do not modify it; pass your own values to pot-tool instead.
- \`./pot-tool\`: measuring and fitting helper. \`./pot-tool help\` lists its options.
${blender ? '- `./blender`: headless Blender, for editing the mesh (see Editing the mesh).\n' : ''}
## Coordinates

The fit happens in the "pot frame": millimetres, +Y up. The reference pot is a
frustum with the centre of its base at the origin and its axis along +Y. It
reaches y = height, with radius bottomOD/2 at y = 0 and topOD/2 at the top.

A transform places the outer pot:

    world = position + scale * (spinY(spin) * (upRotation(up) * raw - anchor))

- \`up\`: which raw model axis points out of the pot's opening (+X -X +Y -Y +Z -Z).
  STL and 3MF files are usually +Z up.
- \`anchor\`: the centre of the bottom of the model's bounding box once \`up\` is
  applied, so \`position\` is where the outer pot's bottom centre lands and
  spin and scale happen about that point.
- \`spin\`: degrees about the vertical axis. It only matters for pots that are not round.
- \`scale\`: factors along world x, y (height) and z.

For a pot whose cavity sits on the reference axis with its floor 2 mm above
its bottom, \`position\` is about { x: 0, y: -2 * scale.y, z: 0 }. If the cavity
is off-centre in the bounding box (handles, faces, feet), x and z are not zero.
\`./pot-tool analyze\` and \`solve\` report the cavity axis.

## Fit settings (state.json "fit")

- \`clearance\`: diametral clearance between the reference pot and the cavity
  wall, so the radial gap must be at least clearance / 2 everywhere.
- \`scaleMode\`: \`uniform\` keeps proportions (scale.x = scale.y = scale.z);
  \`radial-height\` scales width (x = z) and height (y) independently.
- \`topOffset\`: how far the reference pot's rim should stand above the outer
  pot's rim (negative sinks it). null means: sit on the floor at the smallest
  scale that clears the walls.
- \`floorGap\`: gap to leave under the reference pot.

## Workflow

1. \`./pot-tool analyze\`: confirm the up axis. The opening must be at the top
   and the floor at the bottom.
2. \`./pot-tool solve\`: the deterministic solution for the current settings.
   Use \`--mode\`, \`--top-offset\`, \`--clearance\`, \`--up\`, \`--spin\` to try alternatives.
3. \`./pot-tool check --transform '<json>'\`: measure any transform you consider,
   and always the one you return.
4. \`./pot-tool render --transform '<json>' --out fit.png\` (add \`--angle 90\` for
   the other side) draws the section. Look at the image if you can view images.
5. Reply with the JSON result.

${meshEditing(blender)}
## Rules

- Work only in this directory. Never edit mesh.stl or state.json; an edited
  mesh goes in a new file (see Editing the mesh).
- Keep scale.x equal to scale.z unless the user asks for a non-round result,
  and in uniform mode keep all three equal.
- Start from the solver and only hand-tune for what it does not model (user
  feedback, odd shapes, decorative features), checking every change.
- The reference pot must not pass through the outer pot. Treat the clearance as
  a minimum unless the user says otherwise.
- If the user's instructions or feedback conflict with the fit settings, follow
  the user and say so in the summary.
- \`fit\`: the goals your transform meets (clearance, scaleMode, topOffset,
  floorGap). Return the current settings unchanged unless the user asked for
  different goals, e.g. "leave 1 mm for drainage" means floorGap 1. The app
  adopts what you return, so its measurements check against the same goals.
- \`summary\`: 2-5 plain sentences for the user: what you did, the resulting
  scale, gaps and rim offset, and any trade-off.
- \`warnings\`: things the user should check (thin walls, extreme scale,
  uncertain orientation, interference you could not avoid). Empty if none.
- \`confidence\`: how sure you are that the fit is what the user wants.
- \`editedMesh\`: the edited mesh's file name (e.g. "edited.stl") if you
  changed the shape, else null.
`;
}

const mm = (v: number) => `${Number(v.toFixed(3))} mm`;

function describeFit(fit: FitSettings): string {
  const top =
    fit.topOffset === null
      ? 'none (sit on the floor at the smallest scale that clears the walls)'
      : `${mm(fit.topOffset)} (reference rim ${fit.topOffset >= 0 ? 'above' : 'below'} the outer rim)`;
  return [
    `- clearance: ${mm(fit.clearance)} diametral (${mm(fit.clearance / 2)} radial)`,
    `- scale mode: ${fit.scaleMode}`,
    `- rim offset target: ${top}`,
    `- floor gap: ${mm(fit.floorGap)}`,
  ].join('\n');
}

function describeImages(names: string[]): string {
  if (names.length === 0) return '';
  const labels: Record<string, string> = {
    section: 'the app\'s side-on section view (outer pot cut in half, reference pot outline in green, required clearance dashed)',
    view: 'the app\'s 3D view',
  };
  return `\nAttached images, in order: ${names.map((n) => labels[n] ?? n).join('; ')}.\n`;
}

export function fitPrompt(model: PotModel, ref: ReferencePot, instructions: string, images: string[]): string {
  return `Fit the outer pot model to the reference pot.

Model: ${model.name} (imported from ${model.sourceFile}, ${model.triangleCount} triangles)
Reference pot: ${ref.name}: top OD ${mm(ref.topOD)}, bottom OD ${mm(ref.bottomOD)}, height ${mm(ref.height)}${ref.notes ? ` (${ref.notes})` : ''}
Fit settings:
${describeFit(model.fit)}
Transform currently shown in the app: ${JSON.stringify(model.transform)}
${describeImages(images)}
User instructions: ${instructions.trim() || '(none)'}

Follow AGENTS.md: use ./pot-tool, verify your transform with \`./pot-tool check\`, and reply with the JSON result.`;
}

export function feedbackPrompt(model: PotModel, ref: ReferencePot, feedback: string, images: string[]): string {
  return `The user reviewed your fit and has feedback:

"""
${feedback.trim()}
"""

Transform currently shown in the app (it includes any manual moves or scaling the user made after your last answer):
${JSON.stringify(model.transform)}

Current reference pot: ${ref.name}: top OD ${mm(ref.topOD)}, bottom OD ${mm(ref.bottomOD)}, height ${mm(ref.height)}
mesh.stl is the model's current mesh (${model.triangleCount} triangles), with any edits you made that the user kept.
Current fit settings:
${describeFit(model.fit)}
${describeImages(images)}
state.json has been updated. Revise the fit to address the feedback, verify it with \`./pot-tool check\`, and reply with the JSON result.`;
}

// ------------------------------------------------------------------ review

export const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'summary', 'findings', 'feedbackForFitter'],
  properties: {
    verdict: { type: 'string', enum: ['pass', 'concerns', 'fail'] },
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'title', 'detail'],
        properties: {
          severity: { type: 'string', enum: ['major', 'minor', 'info'] },
          title: { type: 'string' },
          detail: { type: 'string' },
        },
      },
    },
    feedbackForFitter: { type: 'string' },
  },
};

export function reviewAgentsMd(): string {
  return `# Pot fit review workspace

You are reviewing a finished fit: a decorative outer pot (a cachepot) that has
been scaled and placed around a reference nursery pot, the plain inner pot that
holds the plant. Someone else made the fit and you only see the result, so
judge it on its own merits.

## Files

- \`fitted.stl\`: the outer pot as fitted, in the pot frame: millimetres, +Y up,
  with the reference pot's base centre at the origin and its axis along +Y.
- \`state.json\`: the reference pot, the goals the fit has to meet, and how much
  the design was scaled from its original size.
- \`./pot-tool\`: measuring helper (\`./pot-tool help\`). Here \`check\` and
  \`render\` measure fitted.stl exactly as placed; you don't need a transform.

The reference pot is a frustum: radius bottomOD/2 at y = 0, topOD/2 at
y = height. Clearance is diametral, so the radial gap must be at least
clearance / 2 everywhere along it. topOffset is how far the reference pot's rim
should stand above the outer pot's rim (null: no target, it should just sit on
the floor). floorGap is the gap wanted under the reference pot.

## What to check

1. The reference pot goes in without passing through the outer pot, with at
   least the required clearance all the way down, including at a narrower rim.
2. It rests on the cavity floor with the wanted floor gap instead of hanging on
   the walls, and it is centred in the cavity.
3. The rim offset matches the goal.
4. The scaled pot still prints: wall and floor thickness (flag under about
   1.2 mm for FDM printing, and under 0.8 mm as major) and overall size.
5. The design isn't visibly distorted, e.g. width and height scaled very
   differently.
6. Anything else wrong in the renders: upside down, tilted, cut off, the
   reference pot outside the cavity, decorations or inner features in the way.

Use \`./pot-tool check\`, \`./pot-tool analyze\` and
\`./pot-tool render --out section.png\` (also \`--angle 90\`), and look at the
images if you can view images. Work only in this directory and don't modify
fitted.stl or state.json.

## Answer

- \`verdict\`: pass (ready to print), concerns (usable, but the user should look
  at something), fail (needs refitting).
- \`summary\`: 2-4 plain sentences with the key numbers.
- \`findings\`: concrete issues with numbers, most important first. Severity
  major, minor or info. Leave out things that are fine; an empty list is right
  for a clean pass.
- \`feedbackForFitter\`: unless the verdict is pass, a short instruction the
  user can send to the agent that made the fit, e.g. "Scale up until the
  narrowest gap is at least 2.5 mm; it is 1.9 mm at the rim." Empty for a pass.
`;
}

export interface ReviewDesign {
  scale: { x: number; y: number; z: number };
  originalSize: { x: number; y: number; z: number };
  fittedSize: { x: number; y: number; z: number };
}

export function reviewPrompt(ref: ReferencePot, fit: FitSettings, design: ReviewDesign, images: string[]): string {
  const size = (s: ReviewDesign['originalSize']) => `${s.x.toFixed(1)} x ${s.z.toFixed(1)} mm wide, ${s.y.toFixed(1)} mm tall`;
  const sc = design.scale;
  return `Review the fitted pot in this directory.

Reference pot: ${ref.name}: top OD ${mm(ref.topOD)}, bottom OD ${mm(ref.bottomOD)}, height ${mm(ref.height)}${ref.notes ? ` (${ref.notes})` : ''}
Goals:
${describeFit(fit)}
Design: originally ${size(design.originalSize)}; scaled x ${sc.x.toFixed(4)}, y (height) ${sc.y.toFixed(4)}, z ${sc.z.toFixed(4)} to ${size(design.fittedSize)}.
${describeImages(images)}
Follow AGENTS.md and reply with the JSON review.`;
}
