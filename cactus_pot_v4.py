"""Seated reader cachepot, inspired by the supplied character reference.

Run: blender -b -P cactus_pot_v4.py -- --render
All coordinates and STL dimensions are millimetres. The nursery-pot cavity
matches v3: 45 mm at its floor, 62.090909 mm at its rim, 47 mm deep.
"""
import bpy
import bmesh
import math
import os
import sys
from mathutils import Vector

OUT_DIR = os.path.dirname(os.path.abspath(__file__))
NAME = "cactus_pot_v4"
HEIGHT = 48.0
FLOOR = 1.0
INNER_BOTTOM = 22.5
SLOPE = 10.0 / 55.0
INNER_TOP = INNER_BOTTOM + SLOPE * (HEIGHT - FLOOR)
VOXEL = 0.18
PROFILE = [(0, 23.4), (1, 26.0), (3, 29.5), (7, 33.8),
           (13, 37.4), (21, 39.0), (29, 38.5), (37, 36.5),
           (45, 33.6), (47.5, 32.85), (48.2, 32.5)]


def activate(obj):
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def surface_radius(z):
    """Cubic interpolation of the rounded belly and gently tucked-in rim."""
    for i in range(len(PROFILE) - 1):
        za, ra = PROFILE[i]
        zb, rb = PROFILE[i + 1]
        if za <= z <= zb:
            p = PROFILE[max(0, i - 1)]
            q = PROFILE[min(len(PROFILE) - 1, i + 2)]
            ma = (rb - p[1]) / (zb - p[0])
            mb = (q[1] - ra) / (q[0] - za)
            t = (z - za) / (zb - za)
            return ((2*t**3 - 3*t**2 + 1)*ra
                    + (t**3 - 2*t**2 + t)*(zb-za)*ma
                    + (-2*t**3 + 3*t**2)*rb
                    + (t**3 - t**2)*(zb-za)*mb)
    return PROFILE[0 if z < 0 else -1][1]


def front_y(x, z):
    return -math.sqrt(max(0.0, surface_radius(z)**2 - x*x))


def lathe(name, rings, segments=256):
    verts = [(r*math.cos(2*math.pi*j/segments),
              r*math.sin(2*math.pi*j/segments), z)
             for z, r in rings for j in range(segments)]
    faces = []
    for i in range(len(rings)-1):
        a, b = i*segments, (i+1)*segments
        for j in range(segments):
            k = (j+1) % segments
            faces.append((a+j, a+k, b+k, b+j))
    faces.append(tuple(reversed(range(segments))))
    faces.append(tuple(range((len(rings)-1)*segments, len(rings)*segments)))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    return obj


def ellipsoid(name, loc, radii):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=40, ring_count=24, location=loc)
    obj = bpy.context.object
    obj.name = name
    obj.scale = radii
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return obj


def rounded_box(name, loc, size, bevel, angle=0):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    obj = bpy.context.object
    obj.name = name
    obj.scale = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if bevel > 0:
        mod = obj.modifiers.new('Soft edges', 'BEVEL')
        mod.width = bevel
        mod.segments = 5
        bpy.ops.object.modifier_apply(modifier=mod.name)
    obj.rotation_euler.z = math.radians(angle)
    return obj


def tube(name, points, radius, sides=12):
    """Closed tube, with a stable frame for smile, handle, and finger grooves."""
    points = [Vector(p) for p in points]
    verts, faces = [], []
    for i, point in enumerate(points):
        tangent = (points[min(i+1, len(points)-1)] - points[max(i-1, 0)]).normalized()
        ref = Vector((0, 1, 0))
        if abs(tangent.dot(ref)) > 0.95:
            ref = Vector((1, 0, 0))
        u = tangent.cross(ref).normalized()
        v = tangent.cross(u).normalized()
        for j in range(sides):
            t = 2*math.pi*j/sides
            verts.append(tuple(point + radius*(math.cos(t)*u + math.sin(t)*v)))
        if i:
            a, b = (i-1)*sides, i*sides
            for j in range(sides):
                k = (j+1) % sides
                faces.append((a+j, a+k, b+k, b+j))
    faces.append(tuple(reversed(range(sides))))
    faces.append(tuple(range((len(points)-1)*sides, len(points)*sides)))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    return obj


def join(objects, name):
    bpy.ops.object.select_all(action='DESELECT')
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.object.join()
    objects[0].name = name
    return objects[0]


def boolean(obj, cutter, operation='DIFFERENCE'):
    activate(obj)
    mod = obj.modifiers.new(cutter.name, 'BOOLEAN')
    mod.operation = operation
    mod.solver = 'EXACT'
    mod.object = cutter
    bpy.ops.object.modifier_apply(modifier=mod.name)
    bpy.data.objects.remove(cutter, do_unlink=True)


def build():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.preferences.filepaths.save_version = 0
    units = bpy.context.scene.unit_settings
    units.system = 'METRIC'
    units.scale_length = 0.001
    units.length_unit = 'MILLIMETERS'
    print('[v4] Building rounded character, book, mug, and limbs', flush=True)
    parts = [lathe('Body', [(48.2*i/193, surface_radius(48.2*i/193)) for i in range(194)])]

    for side in (-1, 1):
        parts.append(rounded_box('Foot', (side*20, -24, 5), (16, 24, 10), 3.8, side*12))
        arm = [(side*(33 - 5*t + 3*math.sin(math.pi*t)), -14-18*t, 25-8*t)
               for t in [i/12 for i in range(13)]]
        parts.append(tube('Arm', arm, 4.4, 20))
        parts.append(ellipsoid('Shoulder', arm[0], (4.4, 4.4, 4.4)))
        parts.append(ellipsoid('Hand', (side*28, -34.0, 17.0), (4.8, 5.6, 5.0)))
    parts.append(ellipsoid('Book thumb', (-25.8, -37.5, 20.1), (2.0, 2.0, 2.7)))
    parts.append(ellipsoid('Mug thumb', (25.0, -37.0, 20.8), (2.0, 2.1, 2.6)))

    # Two angled covers meet at a rounded spine, with inset page blocks above.
    spine = Vector((-15.0, -41.5, 19.0))
    parts.append(rounded_box('Book spine', spine, (2.6, 3.6, 17.0), 1.1))
    for side in (-1, 1):
        angle = math.radians(side*22)
        offset = Vector((side*5.2*math.cos(angle), side*5.2*math.sin(angle), 0))
        center = spine + offset
        parts.append(rounded_box('Book cover', center, (11.2, 2.5, 16.4), 0.8, side*22))
        pages = center + Vector((0, 0.7, 0.8))
        parts.append(rounded_box('Book pages', pages, (10.1, 2.6, 16.4), 0.7, side*22))

    # The mug is an integral relief with a shallow visible opening and a handle.
    mug = lathe('Mug', [(12.0, 4.0), (12.5, 4.4), (24.8, 5.6), (25.6, 5.4)], 96)
    mug.location = (17, -40, 0)
    parts.append(mug)
    handle_points = [(23.0+3.7*math.cos(t), -39.8, 19.7+4.0*math.sin(t))
                     for t in [2*math.pi*i/96 for i in range(97)]]
    parts.append(tube('Mug handle', handle_points, 1.25, 16))
    bpy.ops.mesh.primitive_torus_add(major_segments=96, minor_segments=16,
                                   location=(17, -40, 25.2), major_radius=5.1, minor_radius=0.65)
    parts.append(bpy.context.object)

    obj = join(parts, NAME)
    activate(obj)
    remesh = obj.modifiers.new('Fuse sculpted parts', 'REMESH')
    remesh.mode = 'VOXEL'
    remesh.voxel_size = VOXEL
    remesh.use_smooth_shade = True
    bpy.ops.object.modifier_apply(modifier=remesh.name)
    smooth = obj.modifiers.new('Soften sculpture', 'SMOOTH')
    smooth.factor = 0.35
    smooth.iterations = 2
    bpy.ops.object.modifier_apply(modifier=smooth.name)
    simplify = obj.modifiers.new('Reduce exterior mesh before cutting precise cavity', 'DECIMATE')
    simplify.ratio = 0.32
    simplify.use_collapse_triangulate = True
    bpy.ops.object.modifier_apply(modifier=simplify.name)
    print('[v4] Fused exterior; carving details and original cavity', flush=True)

    # Trim after remeshing, then cut the cavity analytically, so smoothing never
    # changes the floor plane, internal taper, or opening dimensions.
    bounds = rounded_box('Height and flat sole trim', (0, 0, 24), (200, 200, 48), 0)
    boolean(obj, bounds, 'INTERSECT')
    cavity = lathe('Original nursery-pot cavity',
                   [(FLOOR, INNER_BOTTOM), (50, INNER_BOTTOM + (50-FLOOR)*SLOPE)], 576)
    boolean(obj, cavity)

    for x in (-8.7, 8.7):
        z = 33.5
        cutter = ellipsoid('Eye dimple', (x, front_y(x, z)-0.5, z), (1.8, 1.8, 1.8))
        boolean(obj, cutter)
    smile = []
    for i in range(49):
        x = -4.8 + 9.6*i/48
        z = 27.5 + 1.9*(x/4.8)**2
        smile.append((x, front_y(x, z)-0.13, z))
    boolean(obj, tube('Smile', smile, 0.62, 16))

    cup_opening = lathe('Mug opening', [(23.0, 3.7), (25.2, 4.35), (26.2, 4.35)], 96)
    cup_opening.location = (17, -40, 0)
    boolean(obj, cup_opening)

    for side in (-1, 1):
        for z in (15.3, 17.1):
            points = []
            for i in range(17):
                x = side*(27.0 + 3.4*i/16)
                y = -34.0 - 5.6*math.sqrt(max(0.0, 1-((abs(x)-28)/4.8)**2-((z-17)/5.0)**2))
                points.append((x, y-0.05, z))
            boolean(obj, tube('Finger crease', points, 0.28, 10))

    return obj


def validate(obj):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(obj.data)
    bad = sum(not edge.is_manifold for edge in bm.edges)
    volume = bm.calc_volume(signed=True)
    remaining = set(bm.verts)
    components = 0
    while remaining:
        components += 1
        todo = [remaining.pop()]
        while todo:
            vertex = todo.pop()
            for edge in vertex.link_edges:
                neighbor = edge.other_vert(vertex)
                if neighbor in remaining:
                    remaining.remove(neighbor)
                    todo.append(neighbor)
    lo = [min(v.co[i] for v in bm.verts) for i in range(3)]
    hi = [max(v.co[i] for v in bm.verts) for i in range(3)]
    print(f'[v4] non-manifold edges={bad}; components={components}; volume={volume/1000:.2f} cm3', flush=True)
    print(f'[v4] overall dimensions: {[round(b-a, 3) for a,b in zip(lo,hi)]} mm', flush=True)
    assert bad == 0 and components == 1 and volume > 0
    assert abs(lo[2]) < 1e-5 and abs(hi[2] - HEIGHT) < 1e-5
    bm.free()
    for face in obj.data.polygons:
        face.use_smooth = True


def material(name, color, roughness=0.65):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1)
    mat.use_nodes = True
    node = mat.node_tree.nodes['Principled BSDF']
    node.inputs['Base Color'].default_value = (*color, 1)
    node.inputs['Roughness'].default_value = roughness
    return mat


def setup_render(obj):
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = 64
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 1200
    scene.render.resolution_y = 1100
    scene.render.resolution_percentage = 100
    scene.view_settings.view_transform = 'AgX'
    obj.data.materials.clear()
    obj.data.materials.append(material('Dusty rose PLA', (0.64, 0.29, 0.25)))
    for face in obj.data.polygons:
        face.material_index = 0
    world = bpy.data.worlds.new('Warm studio')
    world.use_nodes = True
    world.node_tree.nodes['Background'].inputs[0].default_value = (0.74, 0.69, 0.63, 1)
    world.node_tree.nodes['Background'].inputs[1].default_value = 0.35
    scene.world = world
    for name, loc, power, size in [('Key', (-75, -100, 130), 240000, 90),
                                    ('Fill', (95, -50, 60), 100000, 80),
                                    ('Rim', (0, 90, 100), 170000, 70)]:
        light = bpy.data.objects.new(name, bpy.data.lights.new(name, 'AREA'))
        light.location = loc
        light.data.energy = power
        light.data.shape = 'DISK'
        light.data.size = size
        light.rotation_euler = (Vector((0, -5, 22))-light.location).to_track_quat('-Z', 'Y').to_euler()
        scene.collection.objects.link(light)
    bpy.ops.mesh.primitive_plane_add(size=2000, location=(0, 0, -0.03))
    bpy.context.object.name = 'Studio floor (not exported)'
    bpy.context.object.data.materials.append(material('Warm ivory', (0.75, 0.70, 0.62)))
    camera = bpy.data.objects.new('Camera', bpy.data.cameras.new('Camera'))
    scene.collection.objects.link(camera)
    camera.data.type = 'ORTHO'
    camera.data.ortho_scale = 108
    camera.data.clip_start, camera.data.clip_end = 0.1, 5000
    scene.camera = camera


def render_view(filename, loc, target):
    scene = bpy.context.scene
    camera = scene.camera
    camera.location = loc
    camera.rotation_euler = (Vector(target)-camera.location).to_track_quat('-Z', 'Y').to_euler()
    scene.render.filepath = os.path.join(OUT_DIR, filename)
    bpy.ops.render.render(write_still=True)


def main():
    obj = build()
    validate(obj)
    activate(obj)
    bpy.ops.wm.stl_export(filepath=os.path.join(OUT_DIR, NAME+'.stl'), export_selected_objects=True)
    setup_render(obj)
    activate(obj)
    render_view(NAME+'_preview.png', (12, -190, 100), (0, -4, 23))
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT_DIR, NAME+'.blend'))
    render_view(NAME+'_front.png', (0, -200, 45), (0, -4, 24))
    print('[v4] Saved STL, Blender scene, and two previews', flush=True)


if __name__ == '__main__':
    main()
