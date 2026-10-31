# flowerpot

3D-printable cachepots for cactus nursery pots, modelled procedurally in
Blender with Python. Each script builds the pot, exports an STL, saves a
`.blend` scene and renders preview images into this folder. The `.blend`
scenes aren't kept in git, since they're large: run a script to get its scene.

All dimensions are in millimetres (1 Blender unit = 1 mm, STLs are written in mm).

## Requirements

- Blender 4.1 or newer (the scripts use `bpy.ops.wm.stl_export`), run headless with `blender -b`.
- `compare_macetas_v3.py` also needs NumPy, which ships with Blender.

## Designs

| Version | Script | Outputs |
| --- | --- | --- |
| v1, v2 | none (earlier iterations of `cactus_pot.py`) | `cactus_pot_v1.stl`, `cactus_pot_v2.stl`, plus `cactus_pot.stl` (identical to v2), `cactus_pot.blend`, `cactus_pot_preview.png`, `cactus_pot_section.png` |
| v3 | `cactus_pot.py` | `cactus_pot_v3.stl`, `cactus_pot_v3.blend`, `cactus_pot_v3_preview.png`, `cactus_pot_v3_section.png` |
| v4 | `cactus_pot_v4.py` | `cactus_pot_v4.stl`, `cactus_pot_v4.blend`, `cactus_pot_v4_preview.png`, `cactus_pot_v4_front.png` |

### v3: smooth tapered pot (`cactus_pot.py`)

A smooth-walled frustum with a foot band and grooved rim band, sized for a
60 / 40 mm × 55 mm nursery pot with 5 mm diameter clearance, shortened by 8 mm
from the top. The cavity is 45 mm across at the floor, about 62.1 mm at the rim
and 47 mm deep, with 1 mm walls and floor.

Set `PATTERN = True` to bring back the raised diamond lattice (crossing helical
ribs) and studs. The rib angle is kept at 45° or less so the undersides print
without supports.

```sh
blender -b -P cactus_pot.py              # build, save .blend, export STL
blender -b -P cactus_pot.py -- --render  # also render preview and section images
```

### v4: seated reader (`cactus_pot_v4.py`)

A character cachepot with a rounded belly and tucked-in rim, built around the
same nursery-pot cavity as v3. It always exports the STL, saves the `.blend`
and renders the two previews.

```sh
blender -b -P cactus_pot_v4.py -- --render
```

## Comparison with the "macetas cactus" models

`compare_macetas_v3.py` imports the Faceted, Diamond and Spiral pots from a
`macetas-cactus.3mf` file and lines up unscaled centre sections of each one
with v3. It writes:

- `macetas_vs_v3_dimensions.json`: measured height, body width and cavity
  depth/widths for each design
- `macetas_vs_v3_section.png`: the rendered section comparison
- `macetas_vs_v3_comparison.blend`: the comparison scene, with the original
  assemblies kept in a hidden collection

The 3MF path is hard-coded in `SOURCE` at the top of the script and points at a
temporary upload location, so change it before running:

```sh
blender -b -P compare_macetas_v3.py
```

Measured cavities, from `macetas_vs_v3_dimensions.json`:

| Design | Height | Cavity floor Ø | Cavity rim Ø | Cavity depth |
| --- | --- | --- | --- | --- |
| v3 | 48.0 | 45.0 | 62.1 | 47.0 |
| Diamond | 55.0 | 34.6 | 51.7 | 52.6 |
| Faceted | 55.0 | 35.3 | 51.7 | 48.6 |
| Spiral | 55.0 | 38.2 | 57.5 | 52.5 |

## Potfit: fitting and designing pots

`potfit/` is a three.js web app that scales and aligns any pot model (STL,
3MF, OBJ, GLB, PLY) around a saved reference nursery pot. Codex does the
fitting; you review it in 3D and section views, give feedback or adjust it by
hand, and export the result. Codex can also design a new pot from a
description or reference pictures, built around the nursery pot. Where
Blender is installed, Codex also uses it headless to change an imported pot's
shape (filling the space under the nursery pot, say) and to model parts for
designed pots. See [potfit/README.md](potfit/README.md).

## Notes

- `cactus_pot.blend1` is a Blender auto-backup of `cactus_pot.blend`.
- `macetas_vs_v3_comparison.blend` is about 125 MB, which is over GitHub's
  100 MB per-file limit. Move it to Git LFS or drop it before pushing to GitHub.
- The `legacy` branch holds the original snapshot of these files.
