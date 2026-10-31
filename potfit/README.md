# Potfit

A three.js web app for resizing 3D models of decorative pots (cachepots) so
they fit the nursery pot that actually holds the plant. You save reference
pots by their top OD, bottom OD and height. You import a model, and Codex
aligns and scales it around the reference pot. Then you review the result in a
3D view and a side-on section view, and either send Codex feedback or move and
scale the pot by hand. You can also have Codex design a new pot from a
description, reference pictures or both, built around the nursery pot from
the start. Either way the result exports as an STL ready for a slicer.

## Running it

Needs Node 23.6 or newer (the server and tools run TypeScript directly; tested
on Node 26) and the [Codex CLI](https://github.com/openai/codex) on the `PATH`,
logged in. [Blender](https://www.blender.org) 4.1 or newer on the `PATH` is
optional: with it, Codex can edit an imported pot's mesh (fill the space under
the nursery pot, say) and model parts for designed pots. potfit checks for it
when it starts, and the Codex panel shows its version.

```sh
cd potfit
npm install
npm run dev        # API on :5174 and Vite on http://localhost:5173
```

For a single server without Vite:

```sh
npm run build
npm start          # http://localhost:5174
```

| Variable | Default | |
| --- | --- | --- |
| `POTFIT_HOST` | `127.0.0.1` | Address the API (and built app) listens on |
| `POTFIT_PORT` | `5174` | API (and built app) port |
| `POTFIT_WEB_PORT` | `5173` | Vite dev server port |
| `POTFIT_DATA` | `potfit/data` | Where references, models and Codex runs are stored |
| `POTFIT_CODEX_BIN` | `codex` | Codex executable |
| `POTFIT_CODEX_MODEL` | Codex's configured default | Model passed to `codex exec -m` |
| `POTFIT_CODEX_SANDBOX` | `workspace-write` | Codex's `sandbox_mode` for every run: `read-only`, `workspace-write` or `danger-full-access` |
| `POTFIT_BLENDER_BIN` | `blender` | Blender executable, run headless (`-b`) for mesh edits and design parts |

The API has no authentication, and it runs Codex as you with read access to
your whole filesystem. Anyone who can reach it can have Codex read your files
and report them back. So it only listens on loopback and only answers requests
addressed to `localhost`, `127.0.0.1` or `[::1]`. Set `POTFIT_HOST` to another
address only on a network you trust; the host-name check is then switched off.

Codex's sandbox needs unprivileged user namespaces, which a Docker container
doesn't allow by default, so Codex can't run its commands there. In a
container, set `POTFIT_CODEX_SANDBOX=danger-full-access` and let the container
be the sandbox: give it only potfit's data and Codex's login, and put an
authenticating proxy in front of it, since anyone who reaches the app can have
Codex run any command in the container.

## Using it

1. **Reference pots** (left): add each nursery pot you use with its top OD,
   bottom OD and height in mm. A model uses one of them; new models start with
   the one you used last.
2. **Import** an STL, 3MF, OBJ, GLB/glTF or PLY. Files with several objects
   (a 3MF plate, say) offer to import them separately or combined. On import
   the server guesses which axis is up, centres the cavity on the reference
   axis and stands the reference pot on the cavity floor, at scale 1.
3. **Fit goals** (right): diametral clearance, whether to keep proportions or
   scale width and height separately, how far the nursery pot's rim should
   stand above the outer rim (leave empty to sit it on the floor at the
   smallest scale that clears the walls), and a gap under it.
4. **Fit with Codex** starts a Codex session with optional instructions.
   Its commands and messages stream into the panel. When it finishes, the new
   placement is applied (Revert puts it back), with Codex's summary, its
   warnings and the server's own measurements.
5. **Feedback** continues the same Codex conversation. Type what's wrong or
   use the quick phrases. Codex gets your current placement, including any
   manual moves, and fresh screenshots of both views. If you ask for different
   goals ("leave 2 mm for drainage"), Codex updates the fit settings too.
   If you ask for a change to the shape itself ("fill the empty space under
   the nursery pot", "close the drainage hole") and Blender is installed,
   Codex edits the mesh in Blender. The edited mesh replaces the model's, and
   the result says how many triangles it has now. *Revert* puts back the
   mesh as well as the placement.
6. **Review** starts a separate Codex session that checks the fit as it
   stands now. It sees only the result: the placed pot, the reference pot, the
   goals and screenshots of both views. It never sees the fitting conversation.
   It reports a verdict (pass, concerns or fail), findings with numbers and
   severities, and a suggested instruction for the fitter. *Use as feedback*
   puts that suggestion in the feedback box for you to edit and send. If you
   change the fit afterwards, the review is marked out of date. You can keep
   moving the pot while a review runs; fitting waits until it finishes.
7. **Manual adjustment**: drag the gizmo in either view (W move, E scale,
   Q view only, F frame), type exact numbers under Placement, or use *Centre
   on cavity* and *Seat on floor*. The scale lock keeps scaling uniform, round
   (x = z) or free. Ctrl+Z / Ctrl+Shift+Z undo and redo. *Quick fit (no AI)*
   runs the same solver Codex uses, without Codex.
8. **Section view**: an orthographic cut through the reference axis. Cut faces
   are pale, the reference pot is green and the required clearance is dashed.
   The slider turns the cut plane, and *Cut 3D view* applies the same cut to
   the 3D view.
9. **Export STL** downloads the placed model, Z up and standing on z = 0.

### Designing a pot from scratch

1. **+ Design** (left) opens the new design dialog. Describe the pot, add
   reference images (pick, drop or paste them: photos of pots, characters,
   sketches), choose the nursery pot and the fit goals. Images are resized to
   at most 1600 px and sent as JPEG.
2. The new model starts as a plain pot built around the nursery pot, and
   Codex redesigns it. Its progress streams into the **Codex designer** panel;
   when it finishes, the new design replaces the plain pot.
3. The **Design** panel shows the settings Codex exposed (wall, twist, number
   of lobes, ears on or off, and so on). Changing one rebuilds the pot in a
   second or two. The panel also shows the size, the material, overhangs that
   would need supports and whether the pot is one solid piece.
4. **Feedback** continues the design conversation, with screenshots of both
   views and any images you attach ("make the ears like this"). *Revert* on a
   result goes back to the design from before that run.
5. If you change the nursery pot or the fit goals, the Design panel offers to
   rebuild the cavity for them. The design itself keeps its size.
6. *Design script* shows the script behind the design. You can edit it and
   rebuild; an edit that doesn't build is refused and the old script stays.

Unticking *Design it with Codex* gives you the plain starter pot to adjust by
hand. Review, manual moves, measurements and export work the same as for
imported models.

Measurements update live as you edit: narrowest radial gap and its height,
rim offset, floor gap, whether the reference pot passes through the wall,
thinnest wall and floor thickness after scaling (amber under 1.2 mm, red under
0.8 mm), and the outer size.

### On a phone or tablet

On a narrow or short screen the views sit on top and the panels below them
(beside them on a phone held sideways). Tabs switch between **Models** (the
left panels), **Fit** or **Design** (the right panels) and **View** (no
panels, so the views get the whole screen). One view shows at a time; *3D* and
*Section* over it switch between them. In the 3D view one finger turns the
camera; in the section view it pans. Two fingers zoom and pan in both, and a
finger on the gizmo moves or scales the pot.

The server only listens on loopback by default, and the Vite dev server
always does. To use a phone, build the app and run `npm start` with
`POTFIT_HOST` set to an address the phone can reach (see the warning above).

## How the Codex fit works

Each model gets a working directory, `data/models/<id>/codex/`, that Codex
runs in (`codex exec --json`, sandbox `workspace-write`). It holds:

- `mesh.stl`: the model in its raw imported coordinates
- `state.json`: the reference pot, fit settings and the placement currently
  shown in the app, rewritten before every turn
- `AGENTS.md`: the task, the coordinate conventions and the rules
- `pot-tool`: a wrapper for `tools/pot-tool.ts`, with `analyze` (orientation
  candidates and the cavity profile), `solve` (the deterministic fit), `check`
  (gaps, rim offset, floor gap, interference, wall and floor thickness),
  `render` (a PNG section Codex can look at), and `place` and `unplace` (see
  below)
- `blender`, when Blender is installed: headless Blender with
  `tools/blender/potfit_bpy.py` importable, which has helpers for loading and
  saving STLs, booleans, checking that a mesh is a closed solid and
  `fill_cavity` (fill a cavity from its floor up to a height, following the
  walls whatever their shape)

Codex answers with JSON matching an output schema: a transform, the fit goals
it used, a summary, warnings and a confidence. The server re-measures that
transform itself before applying it. Feedback resumes the same thread with
`codex exec resume`. Every run keeps its prompt, the images sent, the event
log and the result under `data/models/<id>/runs/<runId>/`.

To change the shape, Codex runs `pot-tool place --z-up`, which writes the pot
as placed, turned Z up for Blender, with the nursery pot's base centre at the
origin. It edits that in Blender, and `pot-tool unplace` turns the result back
into the raw coordinates of `mesh.stl` and prints the transform that leaves it
where it was edited. The answer then names the edited STL in `editedMesh`. The
server reads it (it has to be inside the workspace), keeps the old mesh as
`mesh-before.stl` in the run's directory, and makes the edited one the model's
mesh. Reverting the run puts `mesh-before.stl` back. An edit is stored
unscaled, so if the fit is rescaled later the edit scales with it.

A review runs in a fresh `workspace/` inside its run directory. It has its own
`AGENTS.md`, `fitted.stl` (the model already placed in the pot frame, deleted
when the review ends), and a `state.json` with `"placed": true`, the reference
pot, the goals and the scale applied to the design. In placed mode `pot-tool
check` and `render` measure the mesh as it is. A review is a one-off
`codex exec --ephemeral` session with its own output schema; it never touches
the fitting thread or the placement. The server re-measures the reviewed
placement for the record.

## How the Codex design works

A designed pot is a JavaScript module, `design.mjs`, that returns a solid
built with [manifold-3d](https://github.com/elalish/manifold), whose booleans
always give watertight meshes. It gets a toolkit (`tools/potlib.ts`):

- `pot.layout({ floor })`: where the nursery pot sits, the rim height that
  meets the rim-offset goal, the cavity radius needed at each height, the
  cavity itself (subtracted last, so decorations can't intrude), and drainage
  holes.
- `lib`: lathes from smooth profiles, radial bodies `r(angle, z)` for
  twisted, faceted, lobed and ribbed shapes, spheres, boxes, capsules, tubes
  along paths, tori, mirrored pairs, and meshing a signed distance function,
  which blends parts with fillets like a sculpt.
- `lib.part("name.stl")`: a closed STL from the design's `parts/` folder,
  which Codex models in Blender when a shape is easier there (sculpted
  features, text, modifiers). The build can read parts but can't run
  Blender, so a parameter can move, scale or switch a part but not reshape it.
- `params`: the settings the Design panel shows.

The design frame is millimetres, +Z up, the base on z = 0 and the nursery
pot's axis on x = y = 0, with the front facing -Y. The server places the built
mesh at scale 1 with the nursery pot lowered into the cavity until it rests.

Codex works in `data/models/<id>/design/`, which holds `design.mjs`, `refs/`
(the user's images), `parts/` (STL parts, if any), `state.json`, an
`AGENTS.md` describing the toolkit and printing rules, `blender` (as for
fitting) and `pot-tool`, with two extra commands:

- `build` runs the script and reports the size, material, pieces, overhangs
  steeper than 45° (by height and side) and the fit around the nursery pot.
- `preview` renders four shaded views (front, side, three-quarter, top) and
  the section as PNGs, which Codex looks at to compare with the references.
  It (like `check` and `render`) rebuilds first if the script has changed
  since the last build, so it never shows a stale design.

When Codex finishes, the server builds the script itself and makes it the
model's mesh; if it fails, the previous script is put back and Codex's version
is kept as `failed.mjs` for the next turn. Each run keeps the script and
parts from before and after it under `runs/<runId>/`, and putting a run back
restores both.

The server runs design scripts in a child Node process under the permission
model (`--permission`). The script can read only the build code, manifold-3d,
itself and its `parts/`, write only its output directory, and has no network,
subprocesses, workers or environment variables. A build is stopped after
two minutes.

`pot-tool` works on its own too:

```sh
node tools/pot-tool.ts analyze --mesh ../cactus_pot_v3.stl
node tools/pot-tool.ts help
```

## Geometry

Everything is in millimetres in a Y-up "pot frame". The reference pot is a
frustum standing on the origin. A placement is

    world = position + scale * (spinY(spin) * (upRotation(up) * raw - anchor))

where `up` names the raw axis that points out of the pot's opening and
`anchor` is the bottom centre of the model's bounding box once that axis is
up. So `position` is where the outer pot's bottom centre lands, and spinning
and scaling happen about that point.

Measuring slices the placed mesh horizontally every 0.1 mm. At each height it
records the free radius around the reference axis, using ray-crossing parity
to tell solid floor from open cavity. The floor is where that radius drops
below 30% of the widest cavity, so a drainage hole still counts as floor. The
solver lowers the reference frustum down the axis to find where the walls (with
clearance) or the floor stop it. It then bisects on scale to meet the rim and
floor goals. All of this is in `shared/` and runs in the browser (in a web
worker), the server and `pot-tool` alike.

A designed pot is measured the same way. Its cavity is the nursery pot plus
the clearance, so at scale 1 the narrowest gap is exactly the clearance.

Two checks against the designs in this repo: `cactus_pot_v3.stl` and
`cactus_pot_v4.stl` were built for a 60/40 × 55 mm nursery pot with 5 mm
clearance, standing 8 mm proud. The solver gives scale 1.000 for both.

## Layout

```
shared/   types, transforms, STL I/O, slicing, analysis, check and solver
server/   Express API, file store, designs, Codex runner and prompts
tools/    pot-tool CLI, PNG renderers, the design toolkit (potlib.ts), build and starter script,
          and blender/potfit_bpy.py (Blender helpers for Codex)
src/      React UI, three.js viewer (viewer/PotViewer.ts), importers, worker
test/     node --test suites (npm test)
```

`npm test` runs the unit tests and `npm run typecheck` runs TypeScript.
