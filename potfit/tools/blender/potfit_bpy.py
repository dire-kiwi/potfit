"""Blender helpers for Codex's potfit workspaces.

The workspace's ./blender runs Blender headless with this folder on sys.path,
so a script run with `./blender -P edit.py -- <args>` can `import potfit_bpy as pb`.
Everything is in millimetres, Z up (Blender's frame): a fit workspace's
`./pot-tool place --z-up` mesh, or a design's frame.

    import potfit_bpy as pb
    pb.reset()
    pot = pb.load("placed.stl")
    filled = pb.fill_cavity(pot, top=-0.0)       # fill the void under the nursery pot
    print(pb.report(filled))
    pb.save(filled, "placed-edited.stl")
"""

import sys

import bmesh
import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree


def args():
    """The arguments after `--` on the command line."""
    return sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


def reset():
    """An empty scene."""
    bpy.ops.wm.read_factory_settings(use_empty=True)


def load(path, name=None):
    """Import an STL as a new object, as it is in the file (no axis or unit conversion)."""
    before = set(bpy.data.objects)
    bpy.ops.wm.stl_import(filepath=str(path), forward_axis="Y", up_axis="Z", global_scale=1.0)
    new = [o for o in bpy.data.objects if o not in before]
    if not new:
        raise RuntimeError(f"{path} imported no objects")
    obj = new[0]
    if name:
        obj.name = name
    return obj


def save(obj, path):
    """Export one object as a binary STL, modifiers applied, in its world coordinates."""
    select(obj)
    bpy.ops.wm.stl_export(
        filepath=str(path), export_selected_objects=True, apply_modifiers=True, ascii_format=False,
        forward_axis="Y", up_axis="Z", global_scale=1.0,
    )


def select(*objs):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]


def apply_all(obj):
    """Apply the object's modifiers and transform to its mesh."""
    select(obj)
    for m in list(obj.modifiers):
        bpy.ops.object.modifier_apply(modifier=m.name)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    return obj


def remove(obj):
    bpy.data.objects.remove(obj, do_unlink=True)


def boolean(a, b, op="UNION", solver="EXACT", keep_b=False):
    """a = a <op> b with op UNION, DIFFERENCE or INTERSECT, applied. b is removed unless keep_b."""
    m = a.modifiers.new("potfit_boolean", "BOOLEAN")
    m.operation = op
    m.solver = solver
    m.object = b
    if solver == "EXACT":
        m.use_self = False
        m.use_hole_tolerant = True
    apply_all(a)
    if not keep_b:
        remove(b)
    return a


def cylinder(radius, z0, z1, x=0.0, y=0.0, segments=128, name="cylinder"):
    """A closed cylinder around a vertical axis from z0 to z1."""
    bpy.ops.mesh.primitive_cylinder_add(vertices=segments, radius=radius, depth=z1 - z0, location=(x, y, (z0 + z1) / 2))
    obj = bpy.context.active_object
    obj.name = name
    return apply_all(obj)


def box(xmin, xmax, ymin, ymax, zmin, zmax, name="box"):
    bpy.ops.mesh.primitive_cube_add(size=1, location=((xmin + xmax) / 2, (ymin + ymax) / 2, (zmin + zmax) / 2))
    obj = bpy.context.active_object
    obj.scale = (xmax - xmin, ymax - ymin, zmax - zmin)
    obj.name = name
    return apply_all(obj)


def duplicate(obj, name=None):
    new = obj.copy()
    new.data = obj.data.copy()
    bpy.context.collection.objects.link(new)
    if name:
        new.name = name
    return new


def loose_parts(obj):
    """Split an object into its separate pieces."""
    select(obj)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.separate(type="LOOSE")
    bpy.ops.object.mode_set(mode="OBJECT")
    return list(bpy.context.selected_objects)


def bounds(obj):
    """((xmin, ymin, zmin), (xmax, ymax, zmax)) in world coordinates."""
    pts = [obj.matrix_world @ v.co for v in obj.data.vertices]
    return (tuple(min(p[i] for p in pts) for i in range(3)), tuple(max(p[i] for p in pts) for i in range(3)))


def contains(obj, point):
    """Whether a point is inside a closed mesh (ray parity, voted over three directions)."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.transform(obj.matrix_world)
    tree = BVHTree.FromBMesh(bm)
    bm.free()
    votes = 0
    for d in (Vector((0.31, 0.53, 0.79)), Vector((-0.67, 0.21, -0.71)), Vector((0.12, -0.97, 0.2))):
        d.normalize()
        origin, hits = Vector(point), 0
        while True:
            loc, _n, _i, _dist = tree.ray_cast(origin, d)
            if loc is None:
                break
            hits += 1
            origin = loc + d * 1e-4
        votes += hits % 2
    return votes >= 2


def clean(obj, merge=1e-4):
    """Merge duplicate vertices, drop loose bits and make the normals point out."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=merge)
    bmesh.ops.dissolve_degenerate(bm, edges=bm.edges, dist=merge)
    loose = [v for v in bm.verts if not v.link_faces]
    bmesh.ops.delete(bm, geom=loose, context="VERTS")
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()
    return obj


def report(obj):
    """Triangles, volume (cm³), bounds, pieces and whether it is a closed solid."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.transform(obj.matrix_world)
    bmesh.ops.triangulate(bm, faces=bm.faces)
    non_manifold = sum(1 for e in bm.edges if not e.is_manifold)
    tris = len(bm.faces)
    volume = bm.calc_volume(signed=True) / 1000
    bm.free()
    lo, hi = bounds(obj)
    pieces = count_pieces(obj)
    return {
        "triangles": tris,
        "volume_cm3": round(volume, 2),
        "min": [round(v, 3) for v in lo],
        "max": [round(v, 3) for v in hi],
        "pieces": pieces,
        "non_manifold_edges": non_manifold,
        "closed_solid": non_manifold == 0 and volume > 0,
    }


def count_pieces(obj):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    seen, pieces = set(), 0
    for f in bm.faces:
        if f.index in seen:
            continue
        pieces += 1
        stack = [f]
        seen.add(f.index)
        while stack:
            for e in stack.pop().edges:
                for g in e.link_faces:
                    if g.index not in seen:
                        seen.add(g.index)
                        stack.append(g)
    bm.free()
    return pieces


def cavity_space(pot, top, bottom=None, point=None):
    """
    The empty space inside the pot's cavity between `bottom` (default: the pot's
    lowest point) and `top`, as a new object: the piece of (slab - pot) that
    holds `point` (default: on the z axis halfway between the cavity floor and
    `top`), so the space outside the pot and under its base is left out.
    """
    lo, hi = bounds(pot)
    bottom = lo[2] - 1 if bottom is None else bottom
    r = max(abs(lo[0]), abs(hi[0]), abs(lo[1]), abs(hi[1])) * 1.5 + 10
    slab = cylinder(r, bottom, top, name="slab")
    boolean(slab, pot, "DIFFERENCE", keep_b=True)
    parts = loose_parts(slab)
    if point is None:
        floor = cavity_floor(pot, top)
        point = (0.0, 0.0, (floor + top) / 2)
    keep = [p for p in parts if contains(p, point)]
    for p in parts:
        if p not in keep:
            remove(p)
    if not keep:
        raise RuntimeError(f"no empty space around {tuple(round(c, 2) for c in point)}: is it inside the cavity, below `top`?")
    return keep[0]


def cavity_floor(pot, top, x=0.0, y=0.0):
    """Height of the first surface straight down from (x, y, top): the cavity floor."""
    bm = bmesh.new()
    bm.from_mesh(pot.data)
    bm.transform(pot.matrix_world)
    tree = BVHTree.FromBMesh(bm)
    bm.free()
    loc, *_ = tree.ray_cast(Vector((x, y, top)), Vector((0, 0, -1)))
    if loc is None:
        raise RuntimeError(f"nothing under ({x}, {y}, {top}): is the axis inside the cavity?")
    return loc.z


def fill_cavity(pot, top, overlap=0.05, point=None):
    """
    Fill the cavity solid from its floor up to height `top` and union it with
    the pot, which becomes one solid with a new, flat floor at `top`. The fill
    follows the cavity walls whatever their shape. `overlap` grows the fill a
    little into the walls so the union has no slivers.
    """
    space = cavity_space(pot, top, point=point)
    if overlap:
        m = space.modifiers.new("grow", "DISPLACE")
        m.strength = overlap
        m.mid_level = 0
        apply_all(space)
        # Growing the top face would raise the floor; cut it back to `top`.
        lo, hi = bounds(space)
        cap = box(lo[0] - 10, hi[0] + 10, lo[1] - 10, hi[1] + 10, top, hi[2] + 10, name="cap")
        boolean(space, cap, "DIFFERENCE")
    boolean(pot, space, "UNION")
    return clean(pot)
