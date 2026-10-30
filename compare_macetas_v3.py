"""Import the supplied 3MF and compare unscaled center sections with v3.

Run with Blender. Original assemblies are retained in a hidden collection;
the visible comparison uses separate mesh copies, positioned on one datum.
"""
import array
import json
import math
import os
from pathlib import Path
import sys
import time
from xml.etree import ElementTree as ET
from zipfile import ZipFile

import bpy
import bmesh
import numpy as np
from mathutils import Matrix, Vector, Quaternion

ROOT = Path(__file__).resolve().parent
SOURCE = Path('/tmp/kiwi-code-upload-1263085508/macetas-cactus.3mf')
NS = {'m': 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02'}
PROD = '{http://schemas.microsoft.com/3dmanufacturing/production/2015/06}'
CACHE = Path('/tmp/flowerpot-3mf-cache')
CACHE.mkdir(exist_ok=True)
DESIGNS = {8: ('Faceted', 5), 4: ('Diamond', 1), 14: ('Spiral', 13)}


def transform(value):
    if not value:
        return Matrix.Identity(4)
    a = list(map(float, value.split()))
    return Matrix(((a[0], a[3], a[6], a[9]),
                   (a[1], a[4], a[7], a[10]),
                   (a[2], a[5], a[8], a[11]),
                   (0, 0, 0, 1)))


def read_models():
    result = {}
    with ZipFile(SOURCE) as archive:
        main = ET.fromstring(archive.read('3D/3dmodel.model'))
        assert main.attrib['unit'] == 'millimeter'
        for filename in archive.namelist():
            if not filename.startswith('3D/Objects/') or not filename.endswith('.model'):
                continue
            print('[compare] Importing', filename, flush=True)
            vertices, faces = array.array('f'), array.array('i')
            with archive.open(filename) as stream:
                for event, element in ET.iterparse(stream, events=('end',)):
                    tag = element.tag.rsplit('}', 1)[-1]
                    if tag == 'vertex':
                        vertices.extend(float(element.attrib[k]) for k in ('x', 'y', 'z'))
                    elif tag == 'triangle':
                        faces.extend(int(element.attrib[k]) for k in ('v1', 'v2', 'v3'))
                    elif tag == 'object':
                        object_id = int(element.attrib['id'])
                        v = np.frombuffer(vertices, dtype=np.float32).reshape(-1, 3).copy()
                        f = np.frombuffer(faces, dtype=np.int32).reshape(-1, 3).copy()
                        mesh = bpy.data.meshes.new(f'{Path(filename).stem}_{object_id}')
                        mesh.vertices.add(len(v))
                        mesh.vertices.foreach_set('co', v.ravel())
                        mesh.loops.add(3*len(f))
                        mesh.loops.foreach_set('vertex_index', f.ravel())
                        mesh.polygons.add(len(f))
                        mesh.polygons.foreach_set('loop_start', np.arange(len(f), dtype=np.int32)*3)
                        mesh.polygons.foreach_set('loop_total', np.full(len(f), 3, dtype=np.int32))
                        mesh.update()
                        result[(filename, object_id)] = mesh
                        vertices, faces = array.array('f'), array.array('i')
                    element.clear()
    return main, result


def collection(name, hidden=False):
    c = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(c)
    c.hide_render = hidden
    c.hide_viewport = hidden
    return c


def material(name, color, emission=False):
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*color, 1)
    m.use_nodes = True
    shader = m.node_tree.nodes['Principled BSDF']
    shader.inputs['Base Color'].default_value = (*color, 1)
    shader.inputs['Roughness'].default_value = 0.7
    if emission:
        shader.inputs['Base Color'].default_value = (0, 0, 0, 1)
        shader.inputs['Emission Color'].default_value = (*color, 1)
        shader.inputs['Emission Strength'].default_value = 1.0
    return m


def apply_material(obj, mat):
    obj.data.materials.clear()
    obj.data.materials.append(mat)
    for face in obj.data.polygons:
        face.material_index = 0


def text(c, name, body, x, z, size, mat, align='CENTER'):
    data = bpy.data.curves.new(name, 'FONT')
    data.body = body
    data.size = size
    data.align_x = align
    data.space_line = 1.3
    obj = bpy.data.objects.new(name, data)
    obj.location = (x, -25, z)
    obj.rotation_euler.x = math.pi/2
    data.materials.append(mat)
    c.objects.link(obj)
    return obj


def line(c, name, points, mat, radius=0.10):
    curve = bpy.data.curves.new(name, 'CURVE')
    curve.dimensions = '3D'
    curve.bevel_depth = radius
    curve.bevel_resolution = 2
    spline = curve.splines.new('POLY')
    spline.points.add(len(points)-1)
    for p, xyz in zip(spline.points, points):
        p.co = (*xyz, 1)
    obj = bpy.data.objects.new(name, curve)
    curve.materials.append(mat)
    c.objects.link(obj)
    return obj


def coords(mesh):
    a = np.empty(len(mesh.vertices)*3, dtype=np.float32)
    mesh.vertices.foreach_get('co', a)
    return a.reshape(-1, 3)


def triangles(mesh):
    mesh.calc_loop_triangles()
    t = np.empty(len(mesh.loop_triangles)*3, dtype=np.int32)
    mesh.loop_triangles.foreach_get('vertices', t)
    return coords(mesh)[t.reshape(-1, 3)].astype(np.float64)


def hit(tris, origin, direction):
    origin, direction = np.array(origin), np.array(direction)
    # Narrow vertical slab for horizontal measurements.
    if direction[2] == 0:
        tris = tris[(tris[:, :, 2].min(axis=1) <= origin[2]) & (tris[:, :, 2].max(axis=1) >= origin[2])]
    a, b = tris[:, 1]-tris[:, 0], tris[:, 2]-tris[:, 0]
    p = np.cross(direction, b)
    determinant = np.einsum('ij,ij->i', a, p)
    good = abs(determinant) > 1e-10
    tris, a, b, p, determinant = [v[good] for v in (tris, a, b, p, determinant)]
    offset = origin-tris[:, 0]
    u = np.einsum('ij,ij->i', offset, p)/determinant
    q = np.cross(offset, a)
    v = np.einsum('j,ij->i', direction, q)/determinant
    t = np.einsum('ij,ij->i', b, q)/determinant
    valid = t[(u >= -1e-7) & (v >= -1e-7) & (u+v <= 1+1e-7) & (t > 1e-5)]
    if not len(valid):
        raise ValueError(f'No surface at {origin} along {direction}')
    return float(min(valid))


def measure(obj):
    v = coords(obj.data)
    lo, hi = v.min(axis=0), v.max(axis=0)
    top = v[v[:, 2] > hi[2]-0.0005]
    center = (top[:, :2].min(axis=0)+top[:, :2].max(axis=0))/2
    # Measure a vertical center ray to the cavity floor, then transverse rays
    # to both inner walls. This also works for noncircular cavity sections.
    tris = triangles(obj.data)
    cx, cy = map(float, center)
    ztop = float(hi[2])
    floor = ztop-0.01-hit(tris, (cx, cy, ztop-0.01), (0, 0, -1))
    widths = []
    for z in (floor+0.001, floor+1, (floor+ztop)/2, ztop-0.001):
        right = hit(tris, (cx, cy, z), (1, 0, 0))
        left = hit(tris, (cx, cy, z), (-1, 0, 0))
        widths.append({'z': z-float(lo[2]), 'width': left+right})
    result = {'height': ztop-float(lo[2]), 'body_width': float(hi[0]-lo[0]),
              'cavity_depth': ztop-floor, 'cavity_floor_z': floor-float(lo[2]),
              'cavity_bottom_width': widths[0]['width'], 'cavity_rim_width': widths[-1]['width'],
              'cavity_width_samples': widths, 'center': [cx, cy], 'bottom_z': float(lo[2])}
    print('[compare] Measured', obj.name, json.dumps(result), flush=True)
    return result


def section(obj, c, name, center, origin_z, offset, mat):
    mesh = obj.data.copy()
    cut = bpy.data.objects.new(name, mesh)
    c.objects.link(cut)
    bm = bmesh.new()
    bm.from_mesh(mesh)
    # Body coordinates are retained; the front half is removed at the center.
    result = bmesh.ops.bisect_plane(bm, geom=list(bm.verts)+list(bm.edges)+list(bm.faces),
                                    dist=1e-5, plane_co=(0, center[1], 0), plane_no=(0, -1, 0),
                                    clear_inner=False, clear_outer=True)
    boundary = [e for e in result['geom_cut'] if isinstance(e, bmesh.types.BMEdge) and e.is_boundary]
    if boundary:
        bmesh.ops.holes_fill(bm, edges=boundary, sides=0)
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(mesh)
    bm.free()
    cut.location = (offset-center[0], -center[1], -origin_z)
    apply_material(cut, mat)
    cut['Section'] = 'Front half removed along vertical center plane'
    cut['Scale'] = '1:1; translation only'
    return cut


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.preferences.filepaths.save_version = 0
    units = bpy.context.scene.unit_settings
    units.system, units.scale_length, units.length_unit = 'METRIC', 0.001, 'MILLIMETERS'
    originals = collection('01 - Original 3MF assemblies at original plate positions', True)
    full = collection('02 - Full models, aligned for comparison', True)
    cuts = collection('03 - Center sections, same scale')
    labels = collection('04 - Dimensions and labels')
    main_model, meshes = read_models()
    resources = {int(o.attrib['id']): o for o in main_model.findall('m:resources/m:object', NS)}
    assembly_bodies = {}
    for build_item in main_model.findall('m:build/m:item', NS):
        assembly_id = int(build_item.attrib['objectid'])
        title, body_id = DESIGNS[assembly_id]
        build_matrix = transform(build_item.attrib.get('transform'))
        for i, component in enumerate(resources[assembly_id].findall('m:components/m:component', NS)):
            path = component.attrib[PROD+'path'].lstrip('/')
            oid = int(component.attrib['objectid'])
            mesh = meshes[(path, oid)]
            obj = bpy.data.objects.new(f'{title} - {"Body" if oid == body_id else "Limb"} {i+1}', mesh)
            obj.matrix_world = build_matrix @ transform(component.attrib.get('transform'))
            originals.objects.link(obj)
            # Comparison uses the assembly's native upright orientation,
            # removing only the unrelated print-plate Z rotation/translation.
            aligned = bpy.data.objects.new(obj.name+' - aligned', mesh.copy())
            aligned.matrix_world = transform(component.attrib.get('transform'))
            aligned.data.transform(aligned.matrix_world)
            aligned.matrix_world = Matrix.Identity(4)
            full.objects.link(aligned)
            if oid == body_id:
                assembly_bodies[title] = aligned

    bpy.ops.wm.stl_import(filepath=str(ROOT/'cactus_pot_v3.stl'))
    v3 = bpy.context.object
    v3.name = 'V3 - smooth pot'
    for c in list(v3.users_collection):
        c.objects.unlink(v3)
    full.objects.link(v3)
    measured = {'V3': measure(v3)}
    measured.update({name: measure(body) for name, body in assembly_bodies.items()})
    (ROOT/'macetas_vs_v3_dimensions.json').write_text(json.dumps(measured, indent=2))
    ink = material('Annotation ink', (0.018, 0.025, 0.035), emission=True)
    grid = material('Subtle measurement grid', (0.74, 0.77, 0.78), emission=True)
    colors = [(0.11, 0.36, 0.51), (0.76, 0.34, 0.21), (0.32, 0.52, 0.32), (0.51, 0.34, 0.63)]
    order = [('V3', v3), ('Faceted', assembly_bodies['Faceted']),
             ('Diamond', assembly_bodies['Diamond']), ('Spiral', assembly_bodies['Spiral'])]
    for index, (name, body) in enumerate(order):
        x = index*100-150
        m = measured[name]
        mat = material(name+' section color', colors[index])
        section(body, cuts, name+' - center section', m['center'], m['bottom_z'], x, mat)
        text(labels, name+' title', name.upper() if name == 'V3' else '3MF / '+name.upper(), x, 72, 4.0, ink)
        text(labels, name+' height', f'Height  {m["height"]:.2f} mm', x, -8, 3.0, ink)
        text(labels, name+' opening', f'Inner rim  {m["cavity_rim_width"]:.2f} mm', x, -14, 2.8, ink)
        text(labels, name+' floor', f'Inner base  {m["cavity_bottom_width"]:.2f} mm', x, -20, 2.8, ink)
        text(labels, name+' depth', f'Depth  {m["cavity_depth"]:.2f} mm', x, -26, 2.8, ink)
        # Dimension arrows are drawn alongside the body, in the cut plane.
        xx = x-41
        line(labels, name+' height dimension', [(xx, -1, 0), (xx, -1, m['height'])], ink)
        for zz in (0, m['height']):
            line(labels, name+' dimension tick', [(xx-1.2, -1, zz), (xx+1.2, -1, zz)], ink)
    for z in range(0, 61, 10):
        line(labels, f'{z} mm reference', [(-197, 2, z), (196, 2, z)], grid, 0.06)
    text(labels, 'Title', 'CAVITY COMPARISON  /  CENTER SECTIONS', 0, 91, 5.2, ink)
    text(labels, 'Subtitle', 'Original sizes in millimetres  |  Common base datum  |  Same scale, no resizing', 0, 82, 3.0, ink)
    text(labels, 'Measurement note', 'Inner widths are measured across the section; irregular rims may vary with direction.', 0, -36, 2.7, ink)

    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = 48
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 2400
    scene.render.resolution_y = 900
    scene.render.resolution_percentage = 100
    scene.view_settings.view_transform = 'AgX'
    world = bpy.data.worlds.new('Studio background')
    world.use_nodes = True
    world.node_tree.nodes['Background'].inputs[0].default_value = (0.93, 0.93, 0.91, 1)
    world.node_tree.nodes['Background'].inputs[1].default_value = 0.8
    scene.world = world
    # An emissive backdrop keeps annotations readable with no perspective.
    backdrop = material('Paper backdrop', (1, 1, 0.98), emission=True)
    bpy.ops.mesh.primitive_plane_add(size=1, location=(0, 100, 20), rotation=(math.pi/2, 0, 0))
    bpy.context.object.scale = (500, 250, 1)
    bpy.context.object.data.materials.append(backdrop)
    light = bpy.data.objects.new('Soft frontal light', bpy.data.lights.new('Soft frontal light', 'AREA'))
    light.location = (-90, -160, 170)
    light.data.energy, light.data.size = 600000, 220
    light.rotation_euler = (Vector((0, 0, 20))-light.location).to_track_quat('-Z', 'Y').to_euler()
    scene.collection.objects.link(light)
    camera = bpy.data.objects.new('Section comparison camera', bpy.data.cameras.new('Section comparison camera'))
    scene.collection.objects.link(camera)
    camera.location = (0, -450, 27)
    camera.rotation_euler = (Vector((0, 0, 27))-camera.location).to_track_quat('-Z', 'Y').to_euler()
    camera.data.type, camera.data.ortho_scale = 'ORTHO', 420
    camera.data.clip_end = 2000
    scene.camera = camera
    scene.render.filepath = str(ROOT/'macetas_vs_v3_section.png')
    # Save opening directly in the comparison camera view, with all originals
    # available in the outliner for inspection.
    for screen in bpy.data.screens:
        for area in screen.areas:
            if area.type == 'VIEW_3D':
                area.spaces.active.region_3d.view_perspective = 'CAMERA'
                area.spaces.active.clip_end = 5000
    bpy.ops.object.select_all(action='DESELECT')
    bpy.ops.wm.save_as_mainfile(filepath=str(ROOT/'macetas_vs_v3_comparison.blend'))
    print('[compare] Saved Blender comparison; rendering sections', flush=True)
    bpy.ops.render.render(write_still=True)
    print('[compare] Complete', flush=True)


if __name__ == '__main__':
    main()
