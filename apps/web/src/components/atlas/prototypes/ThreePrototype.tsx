import { useEffect, useRef, useState } from "react";
import { ACESFilmicToneMapping, AdditiveBlending, AmbientLight, BackSide, BoxGeometry, BufferGeometry, Color, DirectionalLight, FogExp2, Group, HemisphereLight, LineBasicMaterial, LineSegments, Material, Mesh, MeshPhysicalMaterial, Object3D, PerspectiveCamera, Raycaster, Scene, ShaderMaterial, SphereGeometry, Spherical, SRGBColorSpace, Vector2, Vector3, WebGLRenderer } from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { canvasHostStyle, creditStyle, DEFAULT_EXTRUSION, errorStyle, loadBoundary, NATURAL_EARTH_CREDIT, PROTOTYPE_BACKGROUND, prototypeFrameStyle, regionSelection, type AtlasPrototypeProps, type BoundaryFeature, type PrototypeHandle } from "./types";
import { domesticGeometry, domesticPosition, globeGeometry, globePosition, outlineGeometry } from "./three-geometry";
import { makeMarkers, type MarkerLayer } from "./three-markers";

function disposeTree(object: Object3D) {
  object.traverse((node) => {
    const item = node as Mesh<BufferGeometry, Material | Material[]>;
    item.geometry?.dispose();
    if (Array.isArray(item.material)) item.material.forEach((material) => material.dispose()); else item.material?.dispose();
  });
}
function atmosphere() {
  return new Mesh(new SphereGeometry(4.20, 64, 48), new ShaderMaterial({ side: BackSide, transparent: true, blending: AdditiveBlending, depthWrite: false,
    vertexShader: `varying vec3 vNormal;varying vec3 vWorld;void main(){vec4 p=modelMatrix*vec4(position,1.0);vWorld=p.xyz;vNormal=normalize(mat3(modelMatrix)*normal);gl_Position=projectionMatrix*viewMatrix*p;}`,
    fragmentShader: `varying vec3 vNormal;varying vec3 vWorld;void main(){float f=pow(1.0-abs(dot(normalize(vNormal),normalize(cameraPosition-vWorld))),3.4);gl_FragColor=vec4(vec3(0.19,0.59,0.75)*f,f*0.46);}`,
  }));
}

/** True sphere/triangulated land and true province extrusion. No external textures or runtime geographic services. */
export function ThreePrototype(props: AtlasPrototypeProps) {
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef(props); latest.current = props;
  const handle = useRef<PrototypeHandle | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const mode = props.mode;
  const background = props.visual?.background ?? PROTOTYPE_BACKGROUND;
  const maxDpr = Math.min(1.7, Math.max(1, props.visual?.maxDpr ?? 1.7));
  const pedestal = props.visual?.pedestal !== false;
  const entrance = props.visual?.entrance !== false;
  const autoRotate = props.visual?.autoRotate === true;
  const extrusion = Math.min(.6, Math.max(.04, props.visual?.extrusion ?? DEFAULT_EXTRUSION));
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let active = true; let frame = 0; let ready = false; let dataReady = false; let lost = false;
    let renderer: WebGLRenderer | undefined;
    let controls: OrbitControls | undefined;
    let scene: Scene | undefined;
    let observer: ResizeObserver | undefined;
    let markerLayer: MarkerLayer | undefined;
    const abort = new AbortController();
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const report = (error: unknown) => {
      if (!active || abort.signal.aborted) return;
      setFailure("三维场景暂不可用，仍可通过岗位列表浏览与选择。");
      latest.current.onError?.(error instanceof Error ? error : new Error("Three.js renderer unavailable."));
    };
    let requestRender = () => {};
    const stopFrame = () => { if (frame) cancelAnimationFrame(frame); frame = 0; };
    const visibility = () => { if (document.hidden) stopFrame(); else requestRender(); };
    const motionChange = () => { if (controls) { controls.autoRotate = autoRotate && !motion.matches; controls.enableDamping = !motion.matches; } requestRender(); };
    document.addEventListener("visibilitychange", visibility); motion.addEventListener("change", motionChange);
    setFailure(null);
    const listeners: Array<() => void> = [];
    try {
      renderer = new WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
      renderer.setClearColor(background); renderer.outputColorSpace = SRGBColorSpace; renderer.toneMapping = ACESFilmicToneMapping; renderer.toneMappingExposure = 1.15;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, maxDpr));
      renderer.domElement.style.cssText = "display:block;width:100%;height:100%;outline:none;touch-action:none";
      renderer.domElement.setAttribute("aria-label", mode === "global" ? "全球岗位三维地球。拖拽旋转，滚轮缩放，方向键调整，Home复位" : "国内岗位三维省域地图。拖拽旋转，滚轮缩放，方向键调整，Home复位");
      renderer.domElement.tabIndex = 0; element.appendChild(renderer.domElement);
      const ownedRenderer = renderer;
      const camera = new PerspectiveCamera(38, 1, .1, 150);
      scene = new Scene(); scene.background = new Color(background); scene.fog = new FogExp2(background, mode === "global" ? .006 : .012);
      const ownedScene = scene;
      ownedScene.add(new HemisphereLight("#d1f1f3", "#112330", 2.15), new AmbientLight("#a3c4c9", .55));
      const key = new DirectionalLight("#e3f7ed", 3.2); key.position.set(8, 12, 9); ownedScene.add(key);
      const rim = new DirectionalLight("#487ca3", 2.3); rim.position.set(-9, 6, -8); ownedScene.add(rim);
      controls = new OrbitControls(camera, ownedRenderer.domElement);
      controls.enableDamping = !motion.matches; controls.dampingFactor = .08; controls.enablePan = mode === "domestic";
      controls.autoRotate = autoRotate && !motion.matches; controls.autoRotateSpeed = .35;
      controls.minDistance = mode === "global" ? 5.3 : 7; controls.maxDistance = mode === "global" ? 28 : 40;
      if (mode === "domestic") { controls.maxPolarAngle = Math.PI * .47; controls.minPolarAngle = Math.PI * .11; }
      const ownedControls = controls;
      let entranceStart = 0; let entranceFrom = new Vector3(); let entranceTarget = new Vector3();
      let interaction = false;
      let lastTime = performance.now();
      const render = (now: number) => {
        frame = 0;
        if (!active || document.hidden || lost) return;
        const elapsed = Math.min(.04, Math.max(.001, (now - lastTime) / 1000)); lastTime = now;
        let entering = false;
        if (entranceStart && !interaction && !motion.matches) {
          const progress = Math.min(1, (now - entranceStart) / 1000); const ease = 1 - Math.pow(1 - progress, 3);
          camera.position.lerpVectors(entranceFrom, entranceTarget, ease); entering = progress < 1;
          if (!entering) entranceStart = 0;
        }
        const changing = ownedControls.update(elapsed);
        ownedRenderer.render(ownedScene, camera);
        if (!ready && dataReady) { ready = true; latest.current.onReady?.(); }
        if (entering || changing || ownedControls.autoRotate) requestRender();
      };
      requestRender = () => { if (active && !frame && !document.hidden && !lost) frame = requestAnimationFrame(render); };
      const fit = (bounds = latest.current.bounds) => {
        let center: Vector3;
        let target: Vector3;
        if (mode === "global") {
          const longitude = bounds ? (bounds[0] + bounds[2] + (bounds[0] > bounds[2] ? 360 : 0)) / 2 : 106;
          const latitude = bounds ? (bounds[1] + bounds[3]) / 2 : 23;
          const distance = bounds ? 10.4 : Math.max(13.65, 13.65 / Math.max(.6, camera.aspect));
          center = new Vector3(); target = globePosition(longitude, latitude, distance);
        } else {
          if (bounds) {
            const first = domesticPosition(bounds[0], bounds[1]); const second = domesticPosition(bounds[2], bounds[3]);
            center = first.clone().add(second).multiplyScalar(.5);
            const span = Math.max(4, Math.abs(second.x - first.x) / Math.max(.7, camera.aspect), Math.abs(second.z - first.z));
            target = center.clone().add(new Vector3(span * .16, span * 1.2, span * 1.10));
          } else { center = new Vector3(0, 0, 0); const distance = Math.max(1, 1.25 / Math.max(.65, camera.aspect)); target = new Vector3(2.3, 12.7, 11.2).multiplyScalar(distance); }
        }
        ownedControls.target.copy(center); camera.position.copy(target); camera.lookAt(center);
        entranceStart = entrance && !motion.matches ? performance.now() : 0;
        entranceTarget = target.clone(); entranceFrom = center.clone().add(target.clone().sub(center).multiplyScalar(1.14));
        interaction = false; if (entranceStart) camera.position.copy(entranceFrom);
        requestRender();
      };
      observer = new ResizeObserver(() => {
        const width = Math.max(1, element.clientWidth); const height = Math.max(1, element.clientHeight);
        ownedRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, maxDpr)); ownedRenderer.setSize(width, height, false);
        camera.aspect = width / height; camera.updateProjectionMatrix(); if (!interaction) fit(); else requestRender();
      }); observer.observe(element);
      const changed = () => requestRender();
      const started = () => { interaction = true; entranceStart = 0; requestRender(); };
      ownedControls.addEventListener("change", changed); ownedControls.addEventListener("start", started);
      const contextLost = (event: Event) => { event.preventDefault(); lost = true; stopFrame(); report(new Error("Three.js WebGL context lost.")); };
      const contextRestored = () => { if (active) { lost = false; setFailure(null); requestRender(); } };
      ownedRenderer.domElement.addEventListener("webglcontextlost", contextLost); ownedRenderer.domElement.addEventListener("webglcontextrestored", contextRestored);
      listeners.push(() => { ownedRenderer.domElement.removeEventListener("webglcontextlost", contextLost); ownedRenderer.domElement.removeEventListener("webglcontextrestored", contextRestored); ownedControls.removeEventListener("change", changed); ownedControls.removeEventListener("start", started); });
      const keyboard = (event: KeyboardEvent) => {
        if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "+", "=", "-", "Home"].includes(event.key)) return;
        event.preventDefault(); started();
        if (event.key === "Home") { fit(); return; }
        const offset = camera.position.clone().sub(ownedControls.target);
        if (["+", "=", "-"].includes(event.key)) offset.multiplyScalar(event.key === "-" ? 1.12 : .88);
        else {
          const spherical = new Spherical().setFromVector3(offset);
          if (event.key === "ArrowLeft") spherical.theta -= .09; if (event.key === "ArrowRight") spherical.theta += .09;
          if (event.key === "ArrowUp") spherical.phi -= .07; if (event.key === "ArrowDown") spherical.phi += .07;
          spherical.phi = Math.max(.15, Math.min(mode === "domestic" ? Math.PI * .47 : Math.PI - .15, spherical.phi)); offset.setFromSpherical(spherical);
        }
        offset.clampLength(ownedControls.minDistance, ownedControls.maxDistance); camera.position.copy(ownedControls.target).add(offset); requestRender();
      };
      ownedRenderer.domElement.addEventListener("keydown", keyboard); listeners.push(() => ownedRenderer.domElement.removeEventListener("keydown", keyboard));
      void loadBoundary(mode, abort.signal).then((boundary) => {
        if (!active) return;
        const land = new Group(); land.name = "atlas-land"; ownedScene.add(land);
        const regionMeshes = new Map<string, Mesh<BufferGeometry, MeshPhysicalMaterial>>();
        const pickTargets: Object3D[] = [];
        if (mode === "global") {
          const ocean = new Mesh(new SphereGeometry(4, 80, 64), new MeshPhysicalMaterial({ color: "#092c3e", roughness: .48, metalness: .38, clearcoat: 1, clearcoatRoughness: .30 }));
          land.add(ocean); pickTargets.push(ocean); land.add(atmosphere());
        } else if (pedestal) {
          const base = new Mesh(new BoxGeometry(14.0, .18, 12.2), new MeshPhysicalMaterial({ color: "#0c2531", roughness: .26, metalness: .78, clearcoat: .7 })); base.position.y = -.25; land.add(base);
          const lower = new Mesh(new BoxGeometry(13.75, .09, 11.95), new MeshPhysicalMaterial({ color: "#7aada8", roughness: .42, metalness: .8 })); lower.position.y = -.36; land.add(lower);
        }
        for (const feature of boundary.features) {
          const geometry = mode === "global" ? globeGeometry(feature) : domesticGeometry(feature, extrusion);
          const material = new MeshPhysicalMaterial({ color: mode === "global" ? "#56817e" : "#427b88", roughness: mode === "global" ? .59 : .31, metalness: mode === "global" ? .20 : .44, clearcoat: .8, clearcoatRoughness: .25, transmission: mode === "domestic" ? .10 : 0, thickness: .12 });
          const mesh = new Mesh(geometry, material); mesh.userData.region = feature; land.add(mesh); regionMeshes.set(feature.id, mesh); pickTargets.push(mesh);
        }
        const lines = new LineSegments(outlineGeometry(boundary.features, mode, extrusion), new LineBasicMaterial({ color: "#b1d9ce", transparent: true, opacity: mode === "global" ? .38 : .66, depthWrite: false })); land.add(lines);
        let previousBuckets: AtlasPrototypeProps["buckets"] | undefined;
        const update = (current: AtlasPrototypeProps) => {
          if (previousBuckets !== current.buckets) {
            if (markerLayer) { ownedScene.remove(markerLayer.group); disposeTree(markerLayer.group); }
            markerLayer = makeMarkers(current.buckets, mode, extrusion); ownedScene.add(markerLayer.group); previousBuckets = current.buckets;
          }
          markerLayer?.select(current.selectedBucketId);
          for (const [id, mesh] of regionMeshes) {
            const selected = id === current.selectedRegionId;
            mesh.material.color.set(selected ? "#8bc5b0" : mode === "global" ? "#56817e" : "#427b88");
            mesh.material.emissive.set(selected ? "#183d33" : "#000000");
          }
          requestRender();
        };
        const raycaster = new Raycaster(); const pointer = new Vector2(); let pointerDown: [number, number] = [0, 0];
        const down = (event: PointerEvent) => { pointerDown = [event.clientX, event.clientY]; };
        const hits = (event: PointerEvent) => {
          const rect = ownedRenderer.domElement.getBoundingClientRect(); pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
          raycaster.setFromCamera(pointer, camera); return raycaster.intersectObjects(markerLayer ? [...pickTargets, markerLayer.cores] : pickTargets, false);
        };
        const up = (event: PointerEvent) => {
          if (Math.hypot(event.clientX - pointerDown[0], event.clientY - pointerDown[1]) > 5) return;
          const first = hits(event)[0]; if (!first) return;
          if (first.object === markerLayer?.cores && first.instanceId !== undefined) { const bucket = markerLayer.buckets[first.instanceId]; if (bucket) latest.current.onPick?.(bucket); }
          else if (first.object.userData.region) latest.current.onCountry?.(regionSelection(first.object.userData.region as BoundaryFeature));
        };
        const move = (event: PointerEvent) => { const first = hits(event)[0]; ownedRenderer.domElement.style.cursor = first && (first.instanceId !== undefined || first.object.userData.region) ? "pointer" : "grab"; };
        ownedRenderer.domElement.addEventListener("pointerdown", down); ownedRenderer.domElement.addEventListener("pointerup", up); ownedRenderer.domElement.addEventListener("pointermove", move);
        listeners.push(() => { ownedRenderer.domElement.removeEventListener("pointerdown", down); ownedRenderer.domElement.removeEventListener("pointerup", up); ownedRenderer.domElement.removeEventListener("pointermove", move); });
        handle.current = { update, fit, dispose: () => {} };
        update(latest.current); dataReady = true; fit();
      }).catch(report);
      fit(); requestRender();
    } catch (error) { report(error); }
    return () => {
      active = false; abort.abort(); stopFrame(); observer?.disconnect();
      document.removeEventListener("visibilitychange", visibility); motion.removeEventListener("change", motionChange);
      listeners.forEach((remove) => remove()); handle.current = null; controls?.dispose();
      if (scene) disposeTree(scene);
      if (renderer) { renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove(); }
    };
  }, [mode, background, maxDpr, pedestal, entrance, autoRotate, extrusion]);
  useEffect(() => { handle.current?.update(props); }, [props]);
  useEffect(() => { handle.current?.fit(props.bounds); }, [props.bounds]);
  return <div className={props.className} data-atlas-renderer="three" data-atlas-mode={mode} style={{ ...prototypeFrameStyle, background, ...props.style }}>
    <div ref={host} style={canvasHostStyle} />
    <a href={`${import.meta.env.BASE_URL}legal/geography/`} target="_blank" rel="noopener noreferrer" style={{ ...creditStyle, pointerEvents: "auto", textDecoration: "none" }}>{NATURAL_EARTH_CREDIT}</a>
    {failure && <div role="alert" style={errorStyle}>{failure}</div>}
  </div>;
}
export default ThreePrototype;
