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
  required: ['transform', 'fit', 'summary', 'warnings', 'confidence'],
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
  },
};

export function agentsMd(): string {
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

## Rules

- Work only in this directory. Never edit mesh.stl or state.json.
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
Current fit settings:
${describeFit(model.fit)}
${describeImages(images)}
state.json has been updated. Revise the fit to address the feedback, verify it with \`./pot-tool check\`, and reply with the JSON result.`;
}
