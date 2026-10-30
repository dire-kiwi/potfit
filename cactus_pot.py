"""Smooth-walled cactus pot (cachepot), v3, for 3D printing.

Run:  blender -b -P cactus_pot.py            # build + save .blend + export STL
      blender -b -P cactus_pot.py -- --render # also render preview images

All dimensions in millimetres (1 Blender unit = 1 mm, STL is written in mm).
The inner cavity and outer body are smooth frustums. The original foot and
rim bands are retained, so the base diameter and rim profile stay unchanged.
Set PATTERN to True to restore the raised diamond lattice and studs.
"""
import bpy
import bmesh
import math
import os
import sys

OUT_DIR = os.path.dirname(os.path.abspath(__file__))
NAME = "cactus_pot_v3"
PATTERN = False

# --- Original fit: nursery pot is 60 / 40 mm diameter and 55 mm tall,
# with 5 mm diameter clearance. Shorten from the top, preserving base and taper.
REFERENCE_ID_TOP = 65.0
REFERENCE_DEPTH = 55.0
HEIGHT_REDUCTION = 8.0
ID_BOTTOM = 45.0   # inner diameter at the floor
DEPTH = REFERENCE_DEPTH - HEIGHT_REDUCTION  # inner depth (floor to rim)
ID_TOP = ID_BOTTOM + (REFERENCE_ID_TOP - ID_BOTTOM) * DEPTH / REFERENCE_DEPTH
WALL = 1.0         # wall thickness, measured perpendicular to the tapered wall
FLOOR = 1.0        # floor thickness

# --- Ornament: crossing helical ribs forming a diamond lattice, a stud in each
# diamond, a foot band and a grooved rim band. All heights are radial, outward.
N_RIBS = 12        # ribs in each helical direction
HELIX_DEG = 45.0   # rib angle from vertical (<= 45 keeps undersides printable)
RIB_H = 1.2        # rib height
RIB_HW = 0.13      # rib half-width as a fraction of the rib spacing
STUD_H = 0.9       # stud height
STUD_R = 2.2       # stud radius
FOOT_TOP = 4.0     # height of the foot band
RIM_H = 1.6        # rim band projection
RIM_BOT = 50.5 - HEIGHT_REDUCTION  # move the rim band down with the top
RIM_RAMP = 2.6     # rise of the ramp under the rim band (keeps it under 45 deg)
GROOVE_D = 0.5     # depth of the groove around the rim band
GROOVE_HW = 0.9    # half-width of that groove
CHAMFER = 0.5      # 45 deg chamfer on the outer top and bottom edges

# --- Mesh resolution
SEGMENTS = 576     # around (multiple of N_RIBS)
Z_STEP = 0.25      # vertical spacing of outer rings

H = FLOOR + DEPTH
R_BOT = ID_BOTTOM / 2
R_TOP = ID_TOP / 2
SLOPE = (R_TOP - R_BOT) / DEPTH
WALL_OFFSET = WALL * math.sqrt(1 + SLOPE ** 2)  # horizontal offset giving WALL normal thickness
R_REF = R_BOT + SLOPE * REFERENCE_DEPTH / 2 + WALL_OFFSET  # preserve rib pitch
TWIST = math.tan(math.radians(HELIX_DEG)) / R_REF  # rad per mm of height


def r_inner(z):
    return R_BOT + (z - FLOOR) * SLOPE


def smoothstep(e0, e1, x):
    t = min(max((x - e0) / (e1 - e0), 0.0), 1.0)
    return t * t * (3 - 2 * t)


def bump(t):
    """Raised-cosine profile: 1 at t=0, 0 for |t|>=1."""
    t = abs(t)
    return 0.5 * (1 + math.cos(math.pi * t)) if t < 1 else 0.0


def band(z):
    foot = min(RIB_H, RIB_H - CHAMFER + z) * (1 - smoothstep(FOOT_TOP, FOOT_TOP + 1.0, z))
    rim = RIM_H * smoothstep(RIM_BOT - RIM_RAMP, RIM_BOT, z)
    if z > RIM_BOT - RIM_RAMP:
        z_groove = (RIM_BOT + H) / 2
        rim -= GROOVE_D * bump((z - z_groove) / GROOVE_HW)
        rim -= max(0.0, z - (H - CHAMFER))
    return max(foot, rim)


def lattice(z, theta, r):
    u1 = N_RIBS * (theta + TWIST * z) / (2 * math.pi)
    u2 = N_RIBS * (theta - TWIST * z) / (2 * math.pi)
    d1 = u1 - round(u1)
    d2 = u2 - round(u2)
    ribs = RIB_H * max(bump(d1 / RIB_HW), bump(d2 / RIB_HW))
    # stud at the centre of each diamond (u1, u2 both half-integer)
    c1 = u1 - math.floor(u1) - 0.5
    c2 = u2 - math.floor(u2) - 0.5
    d_theta = math.pi / N_RIBS * (c1 + c2)
    d_z = math.pi / (N_RIBS * TWIST) * (c1 - c2)
    stud = STUD_H * bump(math.hypot(r * d_theta, d_z) / STUD_R)
    mask = smoothstep(1.5, 2.5, z) * (1 - smoothstep(RIM_BOT - 1.0, RIM_BOT, z))
    return max(ribs, stud) * mask


def build_mesh():
    verts, faces = [], []
    seg = SEGMENTS
    thetas = [2 * math.pi * j / seg for j in range(seg)]


    half = math.pi / seg
    staggered = set()  # rings rotated by half a segment

    def ring(z, radius_fn, stagger=False):
        start = len(verts)
        off = half if stagger else 0.0
        for j in range(seg):
            t = thetas[j] + off
            r = radius_fn(t)
            verts.append((r * math.cos(t), r * math.sin(t), z))
        if stagger:
            staggered.add(start)
        return start

    def quads(a, b):  # connect ring a (lower) to ring b (upper); winding fixed later
        for j in range(seg):
            k = (j + 1) % seg
            if (a in staggered) == (b in staggered):
                faces.append((a + j, a + k, b + k, b + j))
            elif b in staggered:
                faces.append((a + j, a + k, b + j))
                faces.append((b + j, a + k, b + k))
            else:
                faces.append((a + j, b + k, b + j))
                faces.append((a + j, a + k, b + k))

    # outer surface, bottom to top. Alternate rings are staggered so the mesh
    # is a triangular lattice that resolves both rib directions equally.
    n_rows = round(H / Z_STEP) + 1
    outer = []
    for i in range(n_rows):
        z = H * i / (n_rows - 1)
        base = r_inner(z) + WALL_OFFSET
        b = band(z)
        outer.append(ring(z, lambda t, z=z, base=base, b=b: base + (max(b, lattice(z, t, base)) if PATTERN else b), stagger=i % 2 == 1))
    for a, b in zip(outer, outer[1:]):
        quads(a, b)

    # inner surface, top to bottom (reversed winding so normals face the cavity)
    n_inner = 12
    inner = []
    for i in range(n_inner):
        z = H - DEPTH * i / (n_inner - 1)
        inner.append(ring(z, lambda t, z=z: r_inner(z)))
    for a, b in zip(inner, inner[1:]):
        quads(a, b)

    # flat rim top: outer top ring -> inner top ring
    quads(outer[-1], inner[0])

    # base and floor as triangle fans
    for ring_start, z, flip in ((outer[0], 0.0, True), (inner[-1], FLOOR, False)):
        c = len(verts)
        verts.append((0.0, 0.0, z))
        for j in range(seg):
            k = (j + 1) % seg
            faces.append((c, ring_start + k, ring_start + j) if flip else (c, ring_start + j, ring_start + k))

    mesh = bpy.data.meshes.new(NAME)
    mesh.from_pydata(verts, [], faces)
    mesh.validate()
    return mesh


def check(obj):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(obj.data)
    non_manifold = sum(1 for e in bm.edges if not e.is_manifold)
    volume = bm.calc_volume(signed=True)
    xs = [v.co.x for v in bm.verts]
    zs = [v.co.z for v in bm.verts]
    print(f"[pot] verts={len(bm.verts)} faces={len(bm.faces)} non-manifold edges={non_manifold}")
    print(f"[pot] volume={volume / 1000:.2f} cm^3  max OD={2 * max(xs):.2f} mm  height={max(zs) - min(zs):.2f} mm")
    print(f"[pot] ID top={ID_TOP} ID bottom={ID_BOTTOM} depth={DEPTH} wall={WALL} floor={FLOOR}")
    bm.free()
    assert non_manifold == 0 and volume > 0


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    us = bpy.context.scene.unit_settings
    us.system = 'METRIC'
    us.scale_length = 0.001
    us.length_unit = 'MILLIMETERS'


def make_frustum(name, r_bot, r_top, height, z0=0.0, wall=0.8):
    """Simple thin-walled stand-in for the nursery pot (preview only)."""
    bm = bmesh.new()
    seg = 128
    def ring(z, r):
        return [bm.verts.new((r * math.cos(2 * math.pi * j / seg), r * math.sin(2 * math.pi * j / seg), z)) for j in range(seg)]
    rings = [ring(z0, r_bot), ring(z0 + height, r_top), ring(z0 + height, r_top - wall), ring(z0 + wall, r_bot - wall)]
    for a, b in zip(rings, rings[1:]):
        for j in range(seg):
            k = (j + 1) % seg
            bm.faces.new((a[j], a[k], b[k], b[j]))
    bm.faces.new(rings[0][::-1])
    bm.faces.new(rings[3])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    return obj


def material(name, color, rough=0.6):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (*color, 1)
    p.inputs["Roughness"].default_value = rough
    return m


def cut_half(obj):
    """Remove the y<0 half with a boolean (for the section view)."""
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, -100, 30))
    cutter = bpy.context.active_object
    cutter.scale = (300, 200, 200)
    mod = obj.modifiers.new("cut", 'BOOLEAN')
    mod.operation = 'DIFFERENCE'
    mod.object = cutter
    try:
        mod.solver = 'MANIFOLD'
    except TypeError:
        mod.solver = 'EXACT'
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_apply(modifier=mod.name)
    bpy.data.objects.remove(cutter)


def render(pot):
    import mathutils
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = 96
    scene.cycles.use_denoising = True
    scene.render.resolution_x = scene.render.resolution_y = 1100
    scene.view_settings.view_transform = 'AgX'

    world = bpy.data.worlds.new("world")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.8, 0.82, 0.85, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.5
    scene.world = world

    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", 'SUN'))
    sun.data.energy = 3.5
    sun.data.angle = math.radians(8)
    sun.rotation_euler = (math.radians(50), 0, math.radians(-35))
    scene.collection.objects.link(sun)

    bpy.ops.mesh.primitive_plane_add(size=2000, location=(0, 0, 0))
    bpy.context.active_object.data.materials.append(material("floor", (0.85, 0.85, 0.85), 0.8))

    pot.data.materials.append(material("pla", (0.62, 0.30, 0.20), 0.55))
    bpy.ops.object.shade_smooth()  # flat facets would hide the relief

    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    cam.data.clip_start, cam.data.clip_end = 1, 5000
    scene.collection.objects.link(cam)
    scene.camera = cam

    def aim(loc, target):
        cam.location = loc
        d = mathutils.Vector(target) - mathutils.Vector(loc)
        cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()

    # hero shot
    cam.data.lens = 85
    aim((150, -210, 120), (0, 0, 26))
    scene.render.filepath = os.path.join(OUT_DIR, f"{NAME}_preview.png")
    bpy.ops.render.render(write_still=True)

    # half-section with a stand-in nursery pot, orthographic from the front
    pot.select_set(True)
    bpy.context.view_layer.objects.active = pot
    cut_half(pot)
    nursery = make_frustum("nursery_pot", 20.0, 30.0, 55.0, z0=FLOOR)
    nursery.data.materials.append(material("nursery", (0.05, 0.05, 0.05), 0.4))
    cut_half(nursery)
    cam.data.type = 'ORTHO'
    cam.data.ortho_scale = 82
    aim((0, -300, H / 2), (0, 0, H / 2))
    sun.rotation_euler = (math.radians(60), 0, math.radians(-20))
    scene.render.filepath = os.path.join(OUT_DIR, f"{NAME}_section.png")
    bpy.ops.render.render(write_still=True)


def main():
    reset_scene()
    obj = bpy.data.objects.new(NAME, build_mesh())
    bpy.context.collection.objects.link(obj)
    check(obj)

    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.wm.stl_export(filepath=os.path.join(OUT_DIR, f"{NAME}.stl"), export_selected_objects=True)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT_DIR, f"{NAME}.blend"))
    print("[pot] wrote", os.path.join(OUT_DIR, f"{NAME}.stl"))

    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if "--render" in argv:
        render(obj)


main()
