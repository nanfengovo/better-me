import { Color, Group, InstancedBufferAttribute, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, MeshStandardMaterial, Quaternion, RingGeometry, ShaderMaterial, SphereGeometry, Vector3 } from "three";
import type { MapBucket } from "@better-me/opportunities";
import { bucketRadius, categories, validBuckets, type AtlasMode } from "./types";
import { domesticPosition, globePosition } from "./three-geometry";

export type MarkerLayer = { group: Group; cores: InstancedMesh; buckets: MapBucket[]; select: (id?: string) => void };
export function makeMarkers(input: readonly MapBucket[], mode: AtlasMode, extrusion: number): MarkerLayer {
  const buckets = validBuckets(input);
  const group = new Group();
  const cores = new InstancedMesh(new SphereGeometry(1, 10, 8), new MeshStandardMaterial({ color: "#ffffff", roughness: .32, metalness: .12, emissive: "#29473f", emissiveIntensity: .6 }), buckets.length);
  cores.name = "atlas-bucket-cores";
  cores.frustumCulled = false;
  group.add(cores);
  const segments = buckets.flatMap((bucket, index) => {
    const colors = categories(bucket); const total = colors.reduce((sum, item) => sum + item.jobCount, 0);
    if (!colors.length) return [{ bucket: index, start: 0, end: Math.PI * 2, color: "#92a9ae" }];
    let previous = 0;
    return colors.map((category) => { const start = previous; previous += category.jobCount / total * Math.PI * 2; return { bucket: index, start, end: previous, color: category.color }; });
  });
  const ringGeometry = new RingGeometry(1, 1.35, 48);
  ringGeometry.setAttribute("aRange", new InstancedBufferAttribute(new Float32Array(segments.flatMap((segment) => [segment.start, segment.end])), 2));
  ringGeometry.setAttribute("aTone", new InstancedBufferAttribute(new Float32Array(segments.flatMap((segment) => new Color(segment.color).toArray())), 3));
  const ringMaterial = new ShaderMaterial({ transparent: true, depthWrite: false, toneMapped: false,
    vertexShader: `attribute vec2 aRange; attribute vec3 aTone; varying vec2 vLocal; varying vec2 vRange; varying vec3 vTone;
      void main(){vLocal=position.xy;vRange=aRange;vTone=aTone;gl_Position=projectionMatrix*modelViewMatrix*instanceMatrix*vec4(position,1.0);}`,
    fragmentShader: `varying vec2 vLocal; varying vec2 vRange; varying vec3 vTone;
      void main(){float a=mod(atan(vLocal.y,vLocal.x)+6.28318530718,6.28318530718);if(a<vRange.x+0.012||a>vRange.y-0.012)discard;gl_FragColor=vec4(vTone,0.97);
      #include <colorspace_fragment>
      }`,
  });
  const rings = new InstancedMesh(ringGeometry, ringMaterial, segments.length); rings.frustumCulled = false; group.add(rings);
  const markerMatrices: Matrix4[] = [];
  const up = new Vector3(0, 0, 1);
  buckets.forEach((bucket, index) => {
    const position = mode === "global" ? globePosition(bucket.longitude, bucket.latitude, 4.075) : domesticPosition(bucket.longitude, bucket.latitude, extrusion + .10);
    const normal = mode === "global" ? position.clone().normalize() : new Vector3(0, 1, 0);
    const orientation = new Quaternion().setFromUnitVectors(up, normal);
    const radius = bucketRadius(bucket) * (mode === "global" ? .0075 : .0105);
    markerMatrices.push(new Matrix4().compose(position, orientation, new Vector3(radius, radius, radius)));
    const core = new Matrix4().compose(position, orientation, new Vector3(radius * .56, radius * .56, radius * .56));
    cores.setMatrixAt(index, core);
    const colors = categories(bucket); cores.setColorAt(index, new Color(colors.length === 1 ? colors[0]!.color : "#e0efe7"));
  });
  segments.forEach((segment, index) => rings.setMatrixAt(index, markerMatrices[segment.bucket]!));
  cores.instanceMatrix.needsUpdate = true; rings.instanceMatrix.needsUpdate = true;
  if (cores.instanceColor) cores.instanceColor.needsUpdate = true;
  const halo = new Mesh(new RingGeometry(1.65, 1.78, 64), new MeshBasicMaterial({ color: "#dbfff1", transparent: true, opacity: .95, depthWrite: false }));
  halo.matrixAutoUpdate = false; halo.visible = false; group.add(halo);
  return { group, cores, buckets, select: (id) => {
    const index = buckets.findIndex((bucket) => bucket.id === id);
    halo.visible = index >= 0;
    if (index >= 0) halo.matrix.copy(markerMatrices[index]!);
  } };
}
