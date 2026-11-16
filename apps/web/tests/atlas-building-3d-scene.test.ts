import assert from "node:assert/strict";
import test from "node:test";
import {
  ARCHITECTURAL_LIGHT_PRESETS,
  buildArchitecturalChunk,
  composeLocalMvpFloat32,
  createBuilding3DController,
  CUSTOM_BUILDING_SCENE_LAYER_ID,
  CUSTOM_BUILDING_SHADOW_LAYER_ID,
  extractCameraLocalPositionMeters,
  invertMat4Float64,
  lngLatToMercatorXY,
  mercatorUnitsPerMeterAtLat,
  sunDirectionENU,
  sunShadowMercatorPerMeter,
} from "../src/components/atlas/prototypes/building-3d-scene.ts";

function matMul4(a: ArrayLike<number>, b: ArrayLike<number>): Float64Array {
  const out = new Float64Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      out[col * 4 + row] =
        a[0 * 4 + row]! * b[col * 4 + 0]! +
        a[1 * 4 + row]! * b[col * 4 + 1]! +
        a[2 * 4 + row]! * b[col * 4 + 2]! +
        a[3 * 4 + row]! * b[col * 4 + 3]!;
    }
  }
  return out;
}

function makePerspectiveMat4(fovyRad: number, aspect: number, near: number, far: number): Float64Array {
  const f = 1 / Math.tan(fovyRad / 2);
  const nf = 1 / (near - far);
  return new Float64Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}

function makeLookAtMat4(eye: [number, number, number], target: [number, number, number], up: [number, number, number]): Float64Array {
  let zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2];
  const zLen = Math.hypot(zx, zy, zz) || 1;
  zx /= zLen; zy /= zLen; zz /= zLen;

  let xx = up[1] * zz - up[2] * zy;
  let xy = up[2] * zx - up[0] * zz;
  let xz = up[0] * zy - up[1] * zx;
  const xLen = Math.hypot(xx, xy, xz) || 1;
  xx /= xLen; xy /= xLen; xz /= xLen;

  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;

  return new Float64Array([
    xx, yx, zx, 0,
    xy, yy, zy, 0,
    xz, yz, zz, 0,
    -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
    -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
    -(zx * eye[0] + zy * eye[1] + zz * eye[2]),
    1,
  ]);
}

test("Mercator projection helpers and sun shadow vectors follow MapLibre coordinate axes", () => {
  const [x0, y0] = lngLatToMercatorXY(0, 0);
  assert.ok(Math.abs(x0 - 0.5) < 1e-12);
  assert.ok(Math.abs(y0 - 0.5) < 1e-12);

  const mercPerM = mercatorUnitsPerMeterAtLat(40);
  assert.ok(mercPerM > 2.5e-8 && mercPerM < 4e-8);

  // Southwest afternoon sun casts shadows northeast (east > 0, south < 0).
  const [dx, dy] = sunShadowMercatorPerMeter(222, 36, mercPerM);
  assert.ok(dx > 0, "southwest sun casts shadow eastward (+mercatorX)");
  assert.ok(dy < 0, "southwest sun casts shadow northward (-mercatorY)");

  const sun = sunDirectionENU(222, 36);
  const norm = Math.hypot(sun[0], sun[1], sun[2]);
  assert.ok(Math.abs(norm - 1) < 1e-12);
});

test("composeLocalMvpFloat32 and extractCameraLocalPositionMeters recover camera eye accurately", () => {
  const originLng = 116.458;
  const originLat = 39.910;
  const [originX, originY] = lngLatToMercatorXY(originLng, originLat);
  const mercPerM = mercatorUnitsPerMeterAtLat(originLat);

  // Build synthetic view-projection in local ENU meters, mapped back to full Mercator world matrix.
  const eyeENU: [number, number, number] = [-140, -260, 320];
  const view = makeLookAtMat4(eyeENU, [0, 0, 40], [0, 0, 1]);
  const proj = makePerspectiveMat4(Math.PI / 4, 16 / 9, 5, 6000);
  const enuVp = matMul4(proj, view);

  // ENU = [ (x - originX)/m, -(y - originY)/m, z/m, 1 ]
  const invM = 1 / mercPerM;
  const mercToEnu = new Float64Array([
    invM, 0, 0, 0,
    0, -invM, 0, 0,
    0, 0, invM, 0,
    -originX * invM, originY * invM, 0, 1,
  ]);
  const fullMainMatrix = matMul4(enuVp, mercToEnu);

  const out64 = new Float64Array(16);
  const local32 = composeLocalMvpFloat32(fullMainMatrix, originX, originY, mercPerM, out64);
  assert.equal(local32.length, 16);

  const inv = invertMat4Float64(out64);
  assert.ok(inv, "local MVP matrix is cleanly invertible");

  const recovered = extractCameraLocalPositionMeters(out64, mercPerM);
  assert.ok(Math.abs(recovered[0] - eyeENU[0]) < 1e-2, `east mismatch: ${recovered[0]} vs ${eyeENU[0]}`);
  assert.ok(Math.abs(recovered[1] - eyeENU[1]) < 1e-2, `north mismatch: ${recovered[1]} vs ${eyeENU[1]}`);
  assert.ok(Math.abs(recovered[2] - eyeENU[2]) < 1e-2, `height mismatch: ${recovered[2]} vs ${eyeENU[2]}`);
});

test("buildArchitecturalChunk builds oriented walls, parapet rims, roof decks, shadow casters, and AO skirts", () => {
  const originLng = 116.458;
  const originLat = 39.910;
  // ~40m x 40m box in CW order plus an inner courtyard hole in CW order to verify automatic orientation normalization.
  const d = 0.00022;
  const h = d * 0.35;
  const towerFeature = {
    type: "Feature" as const,
    properties: { render_height: 84, render_min_height: 0, colour: "#c2b280" },
    geometry: {
      type: "Polygon" as const,
      coordinates: [
        [
          [originLng - d, originLat - d],
          [originLng - d, originLat + d],
          [originLng + d, originLat + d],
          [originLng + d, originLat - d],
          [originLng - d, originLat - d],
        ],
        [
          [originLng - h, originLat - h],
          [originLng - h, originLat + h],
          [originLng + h, originLat + h],
          [originLng + h, originLat - h],
          [originLng - h, originLat - h],
        ],
      ],
    },
  };
  const hiddenFeature = {
    properties: { render_height: 30, hide_3d: true },
    geometry: towerFeature.geometry,
  };
  const flatFeature = {
    properties: { height: 0.4 },
    geometry: towerFeature.geometry,
  };

  const chunk = buildArchitecturalChunk([towerFeature, hiddenFeature, flatFeature], originLng, originLat);
  assert.equal(chunk.featureCount, 1, "excludes hide_3d and sub-threshold buildings while deduplicating cleanly");
  assert.ok(chunk.solidVertexCount > 100);
  assert.ok(chunk.shadowVertexCount > 24);
  assert.ok(chunk.aoVertexCount >= 24, "generates perimeter contact AO skirt and corner bevel fans");

  let sawWall = false;
  let sawPenthouse = false;
  let sawParapet = false;
  let sawRoof = false;
  const holeHalfMerc = Math.abs(lngLatToMercatorXY(originLng + h, originLat)[0] - lngLatToMercatorXY(originLng, originLat)[0]);
  for (let i = 0; i < chunk.solidVertexCount; i++) {
    const base = i * 14;
    const vx = chunk.solidVertices[base]!;
    const vy = chunk.solidVertices[base + 1]!;
    const nx = chunk.solidVertices[base + 3]!;
    const ny = chunk.solidVertices[base + 4]!;
    const nz = chunk.solidVertices[base + 5]!;
    const nLen = Math.hypot(nx, ny, nz);
    assert.ok(Math.abs(nLen - 1) < 1e-4, `unit surface normal at vertex ${i}`);
    const role = chunk.solidVertices[base + 7]!;
    if (role < 0.25) sawWall = true;
    else if (role < 0.45) {
      sawPenthouse = true;
      assert.ok(Math.max(Math.abs(vx), Math.abs(vy)) >= holeHalfMerc * 0.99, "rooftop penthouse stays clear of courtyard hole");
    } else if (role < 0.75) sawParapet = true;
    else {
      sawRoof = true;
      assert.equal(nz, 1);
    }
    // Check optional hex colour propagation.
    assert.ok(Math.abs(chunk.solidVertices[base + 11]! - 0xc2 / 255) < 1e-3);
  }
  assert.ok(sawWall && sawPenthouse && sawParapet && sawRoof, "chunk includes walls, mechanical penthouse, parapet rims, and roof deck");

  // Duplicate identical footprint is deduplicated.
  const deduped = buildArchitecturalChunk([towerFeature, towerFeature], originLng, originLat);
  assert.equal(deduped.featureCount, 1);
  assert.equal(deduped.solidVertexCount, chunk.solidVertexCount);

  assert.ok(ARCHITECTURAL_LIGHT_PRESETS.dark.nightEmissive > 0.5);
  assert.equal(ARCHITECTURAL_LIGHT_PRESETS.street.nightEmissive, 0);
});

function createMockWebGL2() {
  const draws: number[] = [];
  const deletedResources: string[] = [];
  let viewportQueries = 0;
  const texImageSizes: Array<[number, number]> = [];
  const viewportCalls: Array<[number, number, number, number]> = [];
  const fakeGl = {
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    ARRAY_BUFFER: 0x8892,
    STATIC_DRAW: 0x88e4,
    FLOAT: 0x1406,
    TEXTURE_2D: 0x0de1,
    RGBA8: 0x8058,
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401,
    LINEAR: 0x2601,
    CLAMP_TO_EDGE: 0x812f,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    RENDERBUFFER: 0x8d41,
    DEPTH24_STENCIL8: 0x88f0,
    FRAMEBUFFER: 0x8d40,
    COLOR_ATTACHMENT0: 0x8ce0,
    DEPTH_STENCIL_ATTACHMENT: 0x821a,
    FRAMEBUFFER_COMPLETE: 0x8cd5,
    FRAMEBUFFER_BINDING: 0x8ca6,
    VIEWPORT: 0x0ba2,
    COLOR_BUFFER_BIT: 0x4000,
    STENCIL_BUFFER_BIT: 0x0400,
    DEPTH_TEST: 0x0b71,
    CULL_FACE: 0x0b44,
    STENCIL_TEST: 0x0b90,
    BLEND: 0x0be2,
    EQUAL: 0x0202,
    LEQUAL: 0x0203,
    KEEP: 0x1e00,
    INCR: 0x1e02,
    MAX: 0x8008,
    FUNC_ADD: 0x8006,
    ONE: 1,
    ONE_MINUS_SRC_ALPHA: 0x0303,
    TEXTURE0: 0x84c0,
    TRIANGLES: 0x0004,
    drawingBufferWidth: 1200,
    drawingBufferHeight: 800,
    createShader: () => ({}),
    shaderSource: () => {},
    compileShader: () => {},
    getShaderParameter: () => true,
    deleteShader: () => {},
    createProgram: () => ({}),
    attachShader: () => {},
    linkProgram: () => {},
    getProgramParameter: () => true,
    deleteProgram: () => { deletedResources.push("program"); },
    createBuffer: () => ({}),
    bindBuffer: () => {},
    bufferData: () => {},
    deleteBuffer: () => { deletedResources.push("buffer"); },
    createVertexArray: () => ({}),
    bindVertexArray: () => {},
    enableVertexAttribArray: () => {},
    vertexAttribPointer: () => {},
    deleteVertexArray: () => { deletedResources.push("vao"); },
    createFramebuffer: () => ({}),
    bindFramebuffer: () => {},
    framebufferTexture2D: () => {},
    framebufferRenderbuffer: () => {},
    checkFramebufferStatus: () => 0x8cd5,
    deleteFramebuffer: () => { deletedResources.push("fbo"); },
    createTexture: () => ({}),
    bindTexture: () => {},
    texImage2D: (_target: number, _level: number, _internal: number, w: number, h: number) => { texImageSizes.push([w, h]); },
    texParameteri: () => {},
    activeTexture: () => {},
    deleteTexture: () => { deletedResources.push("tex"); },
    createRenderbuffer: () => ({}),
    bindRenderbuffer: () => {},
    renderbufferStorage: () => {},
    deleteRenderbuffer: () => { deletedResources.push("rbo"); },
    getParameter: (param: number) => {
      if (param === 0x0ba2) {
        viewportQueries++;
        return new Int32Array([0, 0, 1200, 800]);
      }
      return null;
    },
    viewport: (x: number, y: number, w: number, h: number) => { viewportCalls.push([x, y, w, h]); },
    colorMask: () => {},
    enable: () => {},
    disable: () => {},
    depthMask: () => {},
    depthFunc: () => {},
    stencilMask: () => {},
    stencilFunc: () => {},
    stencilOp: () => {},
    blendEquation: () => {},
    blendFunc: () => {},
    clearColor: () => {},
    clearStencil: () => {},
    clear: () => {},
    useProgram: () => {},
    getUniformLocation: () => ({}),
    uniformMatrix4fv: () => {},
    uniform1i: () => {},
    uniform1f: () => {},
    uniform2f: () => {},
    uniform3f: () => {},
    drawArrays: (_mode: number, _first: number, count: number) => { draws.push(count); },
  };
  return { fakeGl, draws, deletedResources, texImageSizes, viewportCalls, getViewportQueries: () => viewportQueries };
}

test("createBuilding3DController no-ops gracefully without WebGL2 and drives render passes when WebGL2 is present", () => {
  // 1. No-WebGL2 stub (node synthetic DOM)
  const stubMap = {
    getCanvas: () => ({ getContext: () => null, clientWidth: 800, clientHeight: 600 }),
    getStyle: () => ({ layers: [{ id: "basemap:building:3d" }] }),
    addLayer: () => { throw new Error("should not attach without webgl2"); },
  };
  const noGlController = createBuilding3DController(stubMap as never, {
    sourceId: "basemap:openmaptiles",
    initialMode: "dark",
    initialFlat: false,
  });
  noGlController.attach();
  assert.equal(noGlController.isRenderingCustom(), false);
  noGlController.dispose();

  // 2. WebGL2 mock verifying attachment order, prerender/render draws, visual transitions, and cleanup.
  const { fakeGl, draws, deletedResources, texImageSizes, viewportCalls, getViewportQueries } = createMockWebGL2();

  type MockCustomLayer = {
    id: string;
    onAdd?: (map: unknown, gl: unknown) => void;
    prerender?: (gl: unknown, opts: unknown) => void;
    render?: (gl: unknown, opts: unknown) => void;
  };
  const added: Array<{ layer: MockCustomLayer; beforeId?: string }> = [];
  const removed: string[] = [];
  const activeStates: boolean[] = [];
  let zoom = 16.5;
  const glMap = {
    getCanvas: () => ({ getContext: (kind: string) => (kind === "webgl2" ? fakeGl : null), clientWidth: 600, clientHeight: 400 }),
    getStyle: () => ({ layers: [{ id: "road" }, { id: "basemap:building:3d" }, { id: "basemap:building:3d-edges" }] }),
    getLayer: (id: string) => id === "basemap:building:3d" || added.some((item) => item.layer.id === id && !removed.includes(item.layer.id)),
    addLayer: (layer: MockCustomLayer, beforeId?: string) => { added.push({ layer, beforeId }); layer.onAdd?.(glMap, fakeGl); },
    removeLayer: (id: string) => { removed.push(id); },
    getZoom: () => zoom,
    getCenter: () => ({ lng: 116.458, lat: 39.910 }),
    querySourceFeatures: () => [{
      properties: { render_height: 45 },
      geometry: {
        type: "Polygon",
        coordinates: [[[116.4578, 39.9098], [116.4582, 39.9098], [116.4582, 39.9102], [116.4578, 39.9102], [116.4578, 39.9098]]],
      },
    }],
    triggerRepaint: () => {},
  };

  const controller = createBuilding3DController(glMap as never, {
    sourceId: "basemap:openmaptiles",
    initialMode: "dark",
    initialFlat: false,
    onCustomStateChange: (active) => activeStates.push(active),
  });
  controller.attach();
  assert.deepEqual(
    added.map((entry) => [entry.layer.id, entry.beforeId]),
    [
      [CUSTOM_BUILDING_SHADOW_LAYER_ID, "basemap:building:3d"],
      [CUSTOM_BUILDING_SCENE_LAYER_ID, "basemap:building:3d"],
    ],
  );
  assert.equal(controller.isRenderingCustom(), true);
  assert.deepEqual(activeStates, [true]);

  const identity = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const renderArgs = {
    defaultProjectionData: { mainMatrix: identity, fallbackMatrix: identity, projectionTransition: 0 },
  };
  added[0]!.layer.prerender?.(fakeGl, renderArgs);
  added[0]!.layer.render?.(fakeGl, renderArgs);
  added[1]!.layer.render?.(fakeGl, renderArgs);
  assert.ok(draws.length === 4 && draws[2] === 3, "executes shadow, AO, fullscreen shadow composite, and architectural pass");
  assert.equal(getViewportQueries(), 0, "prerender avoids synchronous gl.getParameter(VIEWPORT) pipeline flushes");
  assert.deepEqual(texImageSizes.at(-1), [600, 400], "shadow FBO allocates at 0.5x backing resolution");
  assert.deepEqual(viewportCalls, [[0, 0, 600, 400], [0, 0, 1200, 800]], "prerender sets shadow FBO viewport and restores full canvas viewport");

  // Flat view pauses custom 3D cleanly.
  controller.setVisualState("street", true);
  assert.equal(controller.isRenderingCustom(), false);
  controller.setVisualState("street", false);
  assert.equal(controller.isRenderingCustom(), true);

  // Zooming out clears active state safely.
  zoom = 10.5;
  controller.scheduleSync(true);
  assert.equal(controller.isRenderingCustom(), false);

  controller.dispose();
  assert.deepEqual(removed, [CUSTOM_BUILDING_SCENE_LAYER_ID, CUSTOM_BUILDING_SHADOW_LAYER_ID]);
  assert.ok(deletedResources.includes("program") && deletedResources.includes("fbo"));
});

test("buildArchitecturalChunk prioritizes landmark towers under maxBuildings cap and scheduleSync defers while map is moving", async () => {
  const originLng = 116.458;
  const originLat = 39.910;
  const manyFeatures = [];
  for (let i = 0; i < 900; i++) {
    const col = i % 30;
    const row = Math.floor(i / 30);
    const cx = originLng + (col - 15) * 0.0005;
    const cy = originLat + (row - 15) * 0.0005;
    const d = 0.0001;
    // Place two tall skyscrapers far from 0 and many short blocks around them.
    const h = i === 10 || i === 880 ? 220 : 12 + (i % 15);
    manyFeatures.push({
      type: "Feature" as const,
      properties: { render_height: h, render_min_height: 0 },
      geometry: {
        type: "Polygon" as const,
        coordinates: [[[cx - d, cy - d], [cx + d, cy - d], [cx + d, cy + d], [cx - d, cy + d], [cx - d, cy - d]]],
      },
    });
  }

  const defaultCapped = buildArchitecturalChunk(manyFeatures, originLng, originLat);
  assert.equal(defaultCapped.featureCount, 750, "enforces 750-building chunk ceiling cleanly");
  const tightCapped = buildArchitecturalChunk(manyFeatures, originLng, originLat, 24);
  assert.equal(tightCapped.featureCount, 24, "respects explicit maxBuildings cap");
  // Tall 220m skyscrapers must survive the tight cap even when many shorter blocks exist.
  let maxTopY = 0;
  for (let i = 2; i < tightCapped.solidVertices.length; i += 14) {
    if (tightCapped.solidVertices[i]! > maxTopY) maxTopY = tightCapped.solidVertices[i]!;
  }
  assert.ok(maxTopY >= 200, `retains high-priority 220m towers inside maxBuildings cap (got ${maxTopY})`);

  // Verify scheduleSync(false) defers rebuild while isMoving() is true once chunk exists.
  let moving = false;
  let queryCalls = 0;
  const { fakeGl: syncFakeGl } = createMockWebGL2();
  const fakeCanvas = { getContext: (kind: string) => (kind === "webgl2" ? syncFakeGl : null), clientWidth: 600, clientHeight: 400 };
  const fakeMap = {
    getCanvas: () => fakeCanvas,
    getStyle: () => ({ layers: [{ id: "basemap:building:3d" }] }),
    getLayer: (id: string) => id === "basemap:building:3d",
    addLayer: (layer: { onAdd?: (m: unknown, g: unknown) => void }) => { layer.onAdd?.(fakeMap, syncFakeGl); },
    removeLayer: () => {},
    getZoom: () => 16.5,
    getCenter: () => ({ lng: originLng, lat: originLat }),
    isMoving: () => moving,
    isZooming: () => moving,
    isRotating: () => false,
    querySourceFeatures: () => {
      queryCalls++;
      return manyFeatures.slice(0, 3);
    },
    triggerRepaint: () => {},
  };

  const deferredCtrl = createBuilding3DController(fakeMap as never, {
    sourceId: "basemap:openmaptiles",
    initialMode: "dark",
    initialFlat: false,
  });
  deferredCtrl.attach();
  const initialQueries = queryCalls;
  assert.equal(initialQueries, 1);

  moving = true;
  deferredCtrl.scheduleSync(false);
  await new Promise((resolve) => setTimeout(resolve, 260));
  assert.equal(queryCalls, initialQueries, "scheduleSync(false) does not rebuild geometry mid-motion");

  moving = false;
  await new Promise((resolve) => setTimeout(resolve, 280));
  assert.ok(queryCalls > initialQueries, "scheduleSync(false) completes pending sync after motion settles");
  deferredCtrl.dispose();
});
