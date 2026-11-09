# Potfit

A three.js web app for resizing 3D models of decorative pots (cachepots) so
they fit the nursery pot that actually holds the plant. You save nursery pots
by their top OD, bottom OD and height. You import a model, and Claude (Claude
Code, through [agent-threads](https://github.com/dire-kiwi/agent-threads))
aligns and scales it around the nursery pot. You review the result in a 3D
view and a side-on section view, then send Claude feedback or move and scale
the pot by hand. Claude can also design a new pot from a description,
reference pictures or both, built around the nursery pot from the start.
Either way the result exports as an STL ready for a slicer.

## Running it

Needs Node 24 or newer (the server and tools run TypeScript directly, and
agent-threads' thread store uses `node:sqlite`; tested on Node 26) and
[Claude Code](https://docs.anthropic.com/en/docs/claude-code) on the `PATH`,
logged in (`claude`, then `/login`), or an `ANTHROPIC_API_KEY` or
`CLAUDE_CODE_OAUTH_TOKEN` in the environment. [Blender](https://www.blender.org)
4.1 or newer on the `PATH` is optional: with it, Claude can edit an imported
pot's mesh (fill the space under the nursery pot, say) and model parts for
designed pots. potfit checks for both when it starts; the header shows them.

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
| `POTFIT_DATA` | `potfit/data` | Where nursery pots, models, checkpoints, reviews and the agent's threads (`threads.db`) are stored |
| `POTFIT_CLAUDE_BIN` | `claude` | Claude Code executable |
| `POTFIT_CLAUDE_MODEL` | Claude Code's default | Model for threads whose user picked *Default*: an alias (`opus`, `sonnet`, `haiku`, `fable`) or a full model ID |
| `POTFIT_CLAUDE_EFFORT` | Claude Code's default | Reasoning effort likewise: `low`, `medium`, `high`, `xhigh` or `max` |
| `POTFIT_BLENDER_BIN` | `blender` | Blender executable, run headless (`-b`) for mesh edits and design parts |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude Code's own: where its login and sessions are (see Containers) |
| `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` | | Claude Code's own: send its requests to another endpoint (a proxy, say) with that bearer token, instead of using a login |

The server passes its whole environment to Claude Code, so Claude Code's own
variables (`ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` for a proxy,
`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CONFIG_DIR`) go in the
server's environment. A `settings.json` `env` block isn't read (see below).

Threads run with none of your own Claude Code settings, hooks, MCP servers or
skills (agent-threads starts Claude with `--setting-sources ""` and
`--strict-mcp-config`): they see only potfit's tools. Your login is the one
they use.

### Security

The API has no authentication, and it runs Claude Code under your login.
Anyone who can reach it can use that login and have Claude run Blender
scripts (Python, which can do anything you can) on the machine. So it only
listens on loopback and only answers requests addressed to `localhost`,
`127.0.0.1` or `[::1]`. Set `POTFIT_HOST` to another address only on a
network you trust; the host-name check is then switched off.

Inside that, potfit's permission policy keeps the agent to what it needs
(`server/agent/policy.ts`):

| Tool call | Fitter / designer threads | Reviewer threads |
| --- | --- | --- |
| potfit's own tools (below) | allowed | allowed (their own, read-only set) |
| `run_blender` | allowed | not offered |
| Read, Glob, Grep | allowed in the model's working directory and potfit's Blender helpers, toolkit and manifold types; denied elsewhere | in the review's directory only |
| Write, Edit | allowed in the working directory, but not the model's `mesh.stl` or a design's `refs/` | denied |
| Bash | denied: there is no shell, and the agent is told to use potfit's tools | denied |
| WebFetch, WebSearch | allowed | denied |
| Subagents, todo lists | allowed (the same policy applies inside) | allowed |
| anything else | asks you, with a card in the Claude panel | denied (reviewers run unattended, in `dont_ask` mode) |

Paths are resolved, symlinks included, before they're checked. Clients can't
change a thread's permission mode.

### Containers

Claude Code's own sandbox (bubblewrap, for its Bash tool) needs unprivileged
user namespaces, which a Docker container doesn't allow by default. potfit
doesn't need it: the shell is denied outright and file access is kept to the
model's directory by the policy above. Blender scripts are the one way the
agent runs code, so let the container be the sandbox for them: give it only
potfit's data and Claude's login, and put an authenticating proxy in front of
it, since anyone who reaches the app can have Claude run Blender Python in
the container.

Claude Code needs a login that outlives the container. Either point
`CLAUDE_CONFIG_DIR` at a directory on a volume (create it before potfit
starts) and log in once inside the container (`claude`, then `/login`), or
make a long-lived token on a workstation with `claude setup-token` and pass
it as `CLAUDE_CODE_OAUTH_TOKEN`; an `ANTHROPIC_API_KEY` works too, as does a
proxy (`ANTHROPIC_BASE_URL` with `ANTHROPIC_AUTH_TOKEN`), which needs no login. Claude
Code keeps its sessions in its config directory, so keep that directory (and
`POTFIT_DATA`) on volumes, or threads can't resume after a redeploy. Run the
container as a non-root user.

### Upgrading from the Codex version

potfit used to run Codex. On the first start of this version it deletes what
only Codex used, for every model: the old runs (`models/<id>/runs/`, with
their logs and the before/after meshes and scripts that let a run be
reverted), the Codex workspace (`models/<id>/codex/`), Codex's files in a
design's directory, the screenshot review loop's state and the Codex thread
IDs. Models keep their mesh, placement, goals, design script, parts,
reference pictures and parameters. It writes `data/migrated-codex.json` when
it's done and doesn't run again. Back up `POTFIT_DATA` first if you might
want an old run's log or revert.

## Using it

The header has your model (click it for the list), the workflow
(**Nursery pot → Model → Fit → Review → Export**) and whether Claude and
Blender are available. Each step opens its panel on the left; a tick means it's
done, amber means something needs a look, and any step opens at any time. The
3D and section views fill the middle, side by side or one at a time
(*Split / 3D / Section*), with the fit's key numbers along the bottom. Claude's
conversation about the model is docked on the right.

1. **Nursery pot**: add each nursery pot you use with its top OD, bottom OD
   and height in mm, and choose the model's. New models start with the one you
   used last.
2. **Model**: import an STL, 3MF, OBJ, GLB/glTF or PLY (or drop it on the
   list). Files with several objects (a 3MF plate, say) offer to import them
   separately or combined. On import the server guesses which axis is up,
   centres the cavity on the nursery pot's axis and stands the nursery pot on
   the cavity floor, at scale 1. Or design a new pot (below).
3. **Fit**: the goals (diametral clearance, keep proportions or scale width
   and height separately, how far the nursery pot's rim should stand above the
   pot's rim, which you can leave empty to sit it on the floor at the smallest
   scale that clears the walls, and a gap under it) and the overhang
   preference. *Fit with Claude* sends Claude the job (with your notes, if
   any), and its work streams into the Claude panel: its tool calls, the
   renders it looks at, and a card for each change it applies, with its
   summary, warnings and the server's measurements. *Quick fit (no AI)* runs
   the same solver Claude starts from, without Claude. *Placement* has the
   numbers: up axis, spin, position and scale, the scale lock (uniform, round
   x = z, or free), *Centre on cavity*, *Seat on floor*, undo and redo.
4. **Review**: *Review the fit* starts a separate Claude that sees only the
   result (the placed pot, the nursery pot, the goals and the views), never
   the fitting conversation. Its verdict (pass, concerns or fail), findings
   and a suggested instruction show in its own thread (the panel's *Reviews*
   list); *Use as feedback* puts the suggestion in the fitter's message box. A
   review of an earlier placement is marked out of date. The iterative
   screenshot review is here too (below).
5. **Export**: the final checks (the nursery pot fits, wall and floor
   thickness, one solid piece and overhangs for designs) and *Export STL*: the
   placed model, Z up and standing on z = 0.

**The Claude panel.** Type feedback and send it; Claude gets your message,
fresh screenshots of both views (untick *Views* not to send them), any
pictures you attach (pick, drop or paste them) and a note of the model as it
is now: your manual moves, the goals and the overhang preference. Ask for
different goals ("leave 2 mm for drainage") and Claude changes them with the
fit. Ask for a change to the shape itself ("fill the empty space under the
nursery pot", "close the drainage hole") and, with Blender installed, Claude
edits the mesh. Sending while Claude works steers it: it reads the message
after its current step. ■ *Stop* interrupts it. The quick phrases fill in
common requests. The model and effort selectors apply to the thread from its
next step; *New conversation* starts a fresh one (the old one stays above).
While Claude works on the model, manual edits pause.

Every change Claude applies has a card with **Revert**, which puts back the
placement, goals and mesh (or design script, parts and parameters) from
before it, and 👍 / 👎 to rate it. Conversations persist: close the page, come
back later or restart the server, and the thread is there to carry on.

Manual adjustment: drag the gizmo in either view (W move, E scale, Q view
only, F frame) or type numbers in *Placement*. Ctrl+Z / Ctrl+Shift+Z undo and
redo, including Claude's changes. The section view is an orthographic cut
through the nursery pot's axis: cut faces are pale, the nursery pot is green
and the required clearance is dashed. The angle slider turns the cut plane,
and *Cut* applies the same cut to the 3D view.

### Designing a pot from scratch

1. *+ Design* (in the model list) opens the new design form. Describe the
   pot, add reference pictures (photos of pots, characters, sketches), choose
   the nursery pot, the goals and the overhang preference. Pictures are
   resized to at most 1600 px and sent as JPEG.
2. The new model starts as a plain pot built around the nursery pot, and the
   designer thread redesigns it: it writes the design script, builds it, looks
   at renders, and applies it when it's right. Each applied design replaces
   the pot in the viewer, with a card you can revert.
3. The **Model** step shows the settings Claude exposed (wall, twist, number
   of lobes, ears on or off, and so on). Changing one rebuilds the pot in a
   second or two. It also shows the size, the material, overhangs that would
   need supports and whether the pot is one solid piece.
4. Feedback works as for fitting; pictures you attach to a design become its
   reference pictures.
5. If you change the nursery pot or the goals, the Model step offers to
   rebuild the cavity for them. The design itself keeps its size.
6. *Design script* shows the script behind the design. You can edit it and
   rebuild; an edit that doesn't build is refused and the old script stays.

Unticking *Design it with Claude* gives you the plain starter pot to adjust by
hand.

### Iterative screenshot review

In the Review step, attach one target screenshot (and optional instructions)
and start the loop. Each round, three independent reviewer threads compare
fresh front, side, three-quarter and top renders with the target, each with a
different focus. If any asks for changes, the model's own thread gets the
panel's findings and adjusts the model before the next round. The loop stops
on unanimous approval, cancellation, an error, or 20 rounds (round 20 is a
review, so it never ends on an unreviewed adjustment). It runs on the server,
so it carries on when you switch models or close the page; a server restart
ends it. Each reviewer's conversation opens in the Claude panel. While the
loop runs, it drives the model's thread and manual edits pause.

### On a phone or tablet

On a narrow or short screen the views sit on top and a panel below them
(beside them on a phone held sideways). Tabs switch between **Steps**, **View**
(no panel, so the views get the whole screen) and **Claude**. One view shows at
a time; *3D* and *Section* in the toolbar switch between them. In the 3D view
one finger turns the camera; in the section view it pans. Two fingers zoom and
pan in both, and a finger on the gizmo moves or scales the pot.

The server only listens on loopback by default, and the Vite dev server
always does. To use a phone, build the app and run `npm start` with
`POTFIT_HOST` set to an address the phone can reach (see Security).

## Choosing a model and reasoning effort

The model and effort selectors are in the Claude panel's message box, the
Review step and the new design form. Your choice is remembered in this
browser, and new threads (fits, designs, reviews, the screenshot loop) start
with it. In a thread's message box they change that thread: a new model
applies from Claude's next step, a new effort from its next turn.

*Default* uses `POTFIT_CLAUDE_MODEL` / `POTFIT_CLAUDE_EFFORT` when they're set,
or else Claude Code's own defaults. The models offered are Claude Code's
aliases (`fable`, `opus`, `sonnet`, `haiku`: the latest of each); *Custom…*
takes any model ID your login can use. Efforts are Claude Code's `--effort`
levels: low, medium, high, extra high and max.

## How the agent works

`server/agent/` runs one agent-threads backend (`@dire-kiwi/agent-threads-node`)
on the `claude` harness, with its threads in `data/threads.db`. Each model has
one thread that fits it (imported) or designs it (designed); each review has a
thread of its own. Thread metadata says which model and role a thread is for,
and each role gets its own system prompt (`server/agent/prompts.ts`) and tools.
The browser draws a thread with `@dire-kiwi/agent-threads-react` over
server-sent events (`/api/threads/:id/stream`, `events`, `items`), and sends
its commands (send, interrupt, answer a permission card, change the model) as
POSTs to `/api/threads/:id/commands`. Changes to the model reach the browser
on `/api/models/:id/live`.

When you send a message to a fitter or designer, the server adds a
`<potfit-context>` block (the model, the nursery pot, the goals, the
placement and whether you moved it by hand since Claude's last change, the
design's parameters, the overhang preference and what the attached pictures
are), which the panel shows as a small expandable note.

**Tools** (`server/agent/tools.ts`), as Claude calls them (`mcp__app__…`). The
measuring and drawing ones run `tools/pot-tool.ts` as a child process, so the
server stays responsive:

| Tool | Roles | Does |
| --- | --- | --- |
| `get_state` | all | The model as you see it now: nursery pot, goals, placement, overhang preference; a design's description, pictures, parameters and last build |
| `list_reference_pots` | all | Your saved nursery pots |
| `analyze_mesh` | fit, review | Orientation candidates, cavity profile and dimensions |
| `solve_fit` | fit | The deterministic fit for the goals (or others to try) |
| `check_fit` | all | Gaps by height, rim offset, floor gap, interference, wall and floor thickness and size for a placement |
| `render_views` | all | Sections at given angles and shaded views as PNGs in `renders/`, which Claude looks at with its Read tool and the panel shows as thumbnails |
| `apply_fit` | fit | Makes a placement (and the goals it meets) the model's, with a summary; the server measures it again |
| `export_placed_mesh` | fit | The pot as placed, Z up, for Blender |
| `apply_mesh_edit` | fit | Takes the mesh edited in Blender back to the model's raw coordinates and makes it the model's mesh |
| `run_blender` | fit, design | Runs a Python script headless in Blender, with `tools/blender/potfit_bpy.py` importable (helpers for loading, saving, booleans, `fill_cavity` and checking for a closed solid). Only when Blender is installed |
| `build_design` | design | Builds `design.mjs` and reports size, material, pieces, overhangs and the fit |
| `apply_design` | design | Builds it on the server and makes it the model's mesh; one that doesn't build is refused with the error, so Claude fixes it in the same turn |
| `submit_review` | review | The verdict, findings and suggestion |

**Checkpoints.** Before `apply_fit`, `apply_mesh_edit` or `apply_design`
changes the model, the server saves what it replaces in
`models/<id>/checkpoints/<id>/` (placement, goals and parameters, and the old
mesh, or the last applied script and parts). The tool's result carries the
checkpoint, which the panel draws as the change's card; Revert and the rating
work on it. A mesh edit is stored unscaled, so if the fit is rescaled later the
edit scales with it.

**Workspaces.** A fitter works in `models/<id>/agent/`: `mesh.stl` (the
model's mesh, linked in afresh before each tool call), `state.json` (what
pot-tool reads) and whatever Claude writes there (Blender scripts, meshes,
renders). A designer works in `models/<id>/design/` (below). A reviewer works
in `models/<id>/reviews/<id>/`, which holds only `fitted.stl` (the model as
placed), `state.json` with `"placed": true` and its renders, next to the
review's record.

To change an imported pot's shape, Claude exports the placed pot Z up, edits it
in Blender, and gives it to `apply_mesh_edit` with the same placement: the
server turns it back into the raw coordinates of the model's mesh and places it
where it was edited.

## How the design works

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
  which the agent models in Blender when a shape is easier there (sculpted
  features, text, modifiers). The build can read parts but can't run
  Blender, so a parameter can move, scale or switch a part but not reshape it.
- `params`: the settings the Design panel shows.

The design frame is millimetres, +Z up, the base on z = 0 and the nursery
pot's axis on x = y = 0, with the front facing -Y. The server places the built
mesh at scale 1 with the nursery pot lowered into the cavity until it rests.

A designer works in `data/models/<id>/design/`, which holds `design.mjs`,
`refs/` (your pictures), `parts/` (STL parts, if any), `out/` and `renders/`.
Claude edits `design.mjs` with its Write and Edit tools, builds and renders it
with `build_design` and `render_views` (which rebuild first if the script has
changed since the last build), and applies it with `apply_design`. Edits it
never applies are undone when its turn ends, so `design.mjs` always matches the
pot you see; the unapplied version is kept as `unapplied.mjs`, and Claude is
told about it.

The server runs design scripts in a child Node process under the permission
model (`--permission`). The script can read only the build code, manifold-3d,
itself and its `parts/`, write only its output directory, and has no network,
subprocesses, workers or environment variables. A build is stopped after
two minutes.

`pot-tool`, which the tools run, works on its own too:

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
server/   Express API, file store, designs, the screenshot review loop, the Codex migration
  agent/  agent-threads backend, tools, permission policy, prompts, checkpoints, reviews
tools/    pot-tool CLI, PNG renderers, the design toolkit (potlib.ts), build and starter script,
          and blender/potfit_bpy.py (Blender helpers for the agent)
src/      React UI: steps/ (the workflow panels), agent/ (the Claude panel), components/,
          three.js viewer (viewer/PotViewer.ts), importers, worker
test/     node --test suites (npm test), with agent-threads' fake claude in fixtures/
vendor/   agent-threads' packages, packed (see below)
```

`npm test` runs the tests (the agent's run against a scriptable fake `claude`,
so they cost nothing) and `npm run typecheck` runs TypeScript.

### agent-threads

agent-threads isn't on npm yet, so potfit depends on packed tarballs of its
protocol, Node and React packages in `vendor/`, built from the commit in
`vendor/AGENT_THREADS`. To update them (needs git, Node 24+ and pnpm):

```sh
scripts/vendor-agent-threads.sh <commit or branch>   # default: main
npm install
```

That also copies agent-threads' fake `claude` into `test/fixtures/`. Run the
tests after updating.
