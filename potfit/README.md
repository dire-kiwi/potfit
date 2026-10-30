# Potfit

A three.js web app for resizing 3D models of decorative pots (cachepots) so
they fit the nursery pot that actually holds the plant. You save reference
pots by their top OD, bottom OD and height. You import a model, and Codex
aligns and scales it around the reference pot. Then you review the result in a
3D view and a side-on section view, and either send Codex feedback or move and
scale the pot by hand. The fitted model exports as an STL ready for a slicer.

## Running it

Needs Node 23.6 or newer (the server and tools run TypeScript directly; tested
on Node 26) and the [Codex CLI](https://github.com/openai/codex) on the `PATH`,
logged in.

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

The API has no authentication, and it runs Codex as you with read access to
your whole filesystem. Anyone who can reach it can have Codex read your files
and report them back. So it only listens on loopback and only answers requests
addressed to `localhost`, `127.0.0.1` or `[::1]`. Set `POTFIT_HOST` to another
address only on a network you trust; the host-name check is then switched off.

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

Measurements update live as you edit: narrowest radial gap and its height,
rim offset, floor gap, whether the reference pot passes through the wall,
thinnest wall and floor thickness after scaling (amber under 1.2 mm, red under
0.8 mm), and the outer size.

## How the Codex fit works

Each model gets a working directory, `data/models/<id>/codex/`, that Codex
runs in (`codex exec --json`, sandbox `workspace-write`). It holds:

- `mesh.stl`: the model in its raw imported coordinates
- `state.json`: the reference pot, fit settings and the placement currently
  shown in the app, rewritten before every turn
- `AGENTS.md`: the task, the coordinate conventions and the rules
- `pot-tool`: a wrapper for `tools/pot-tool.ts`, with `analyze` (orientation
  candidates and the cavity profile), `solve` (the deterministic fit), `check`
  (gaps, rim offset, floor gap, interference, wall and floor thickness) and
  `render` (a PNG section Codex can look at)

Codex answers with JSON matching an output schema: a transform, the fit goals
it used, a summary, warnings and a confidence. The server re-measures that
transform itself before applying it. Feedback resumes the same thread with
`codex exec resume`. Every run keeps its prompt, the images sent, the event
log and the result under `data/models/<id>/runs/<runId>/`.

A review runs in a fresh `workspace/` inside its run directory. It has its own
`AGENTS.md`, `fitted.stl` (the model already placed in the pot frame, deleted
when the review ends), and a `state.json` with `"placed": true`, the reference
pot, the goals and the scale applied to the design. In placed mode `pot-tool
check` and `render` measure the mesh as it is. A review is a one-off
`codex exec --ephemeral` session with its own output schema; it never touches
the fitting thread or the placement. The server re-measures the reviewed
placement for the record.

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

Two checks against the designs in this repo: `cactus_pot_v3.stl` and
`cactus_pot_v4.stl` were built for a 60/40 × 55 mm nursery pot with 5 mm
clearance, standing 8 mm proud. The solver gives scale 1.000 for both.

## Layout

```
shared/   types, transforms, STL I/O, slicing, analysis, check and solver
server/   Express API, file store, Codex runner and prompts
tools/    pot-tool CLI and the PNG section renderer
src/      React UI, three.js viewer (viewer/PotViewer.ts), importers, worker
test/     node --test suites (npm test)
```

`npm test` runs the unit tests and `npm run typecheck` runs TypeScript.
