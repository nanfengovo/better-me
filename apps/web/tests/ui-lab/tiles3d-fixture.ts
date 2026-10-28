/** Tiny, original synthetic mesh for real Cesium decoder/collision QA. Not geographic evidence. */
export function syntheticTiles3d() {
  const positions = new Float32Array([-100,0,-100, 100,0,-100, 100,160,-100, -100,160,-100, -100,0,100, 100,0,100, 100,160,100, -100,160,100]);
  const indices = new Uint16Array([0,1,2,0,2,3, 4,6,5,4,7,6, 0,4,5,0,5,1, 3,2,6,3,6,7, 0,3,7,0,7,4, 1,5,6,1,6,2]);
  const binary = Buffer.concat([Buffer.from(positions.buffer), Buffer.from(indices.buffer)]);
  const json = Buffer.from(JSON.stringify({ asset:{version:"2.0",generator:"BetterMe synthetic 3D Tiles test only"},
    extensionsUsed:["KHR_materials_unlit"], buffers:[{byteLength:binary.length}],
    bufferViews:[{buffer:0,byteOffset:0,byteLength:positions.byteLength,target:34962},{buffer:0,byteOffset:positions.byteLength,byteLength:indices.byteLength,target:34963}],
    accessors:[{bufferView:0,componentType:5126,count:8,type:"VEC3",min:[-100,0,-100],max:[100,160,100]},{bufferView:1,componentType:5123,count:indices.length,type:"SCALAR"}],
    materials:[{pbrMetallicRoughness:{baseColorFactor:[.16,.58,.48,1],metallicFactor:0,roughnessFactor:1},doubleSided:true,extensions:{KHR_materials_unlit:{}}}],
    meshes:[{primitives:[{attributes:{POSITION:0},indices:1,material:0}]}], nodes:[{mesh:0}],scenes:[{nodes:[0]}],scene:0 }));
  const padded = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 0x20)]);
  const bytes = Buffer.alloc(12 + 8 + padded.length + 8 + binary.length);
  bytes.writeUInt32LE(0x46546c67,0); bytes.writeUInt32LE(2,4); bytes.writeUInt32LE(bytes.length,8);
  bytes.writeUInt32LE(padded.length,12); bytes.writeUInt32LE(0x4e4f534a,16); padded.copy(bytes,20);
  bytes.writeUInt32LE(binary.length,20+padded.length); bytes.writeUInt32LE(0x004e4942,24+padded.length); binary.copy(bytes,28+padded.length);
  const longitude = 121.34 * Math.PI / 180, latitude = 31.12 * Math.PI / 180;
  const sl = Math.sin(longitude), cl = Math.cos(longitude), sp = Math.sin(latitude), cp = Math.cos(latitude);
  const n = 6378137 / Math.sqrt(1 - 0.00669437999014 * sp * sp);
  const transform = [-sl,cl,0,0, -sp*cl,-sp*sl,cp,0, cp*cl,cp*sl,sp,0, n*cp*cl,n*cp*sl,n*(1-0.00669437999014)*sp,1];
  return { bytes, tileset: { asset:{version:"1.1"}, geometricError:500, root:{transform, boundingVolume:{box:[0,0,80,100,0,0,0,100,0,0,0,80]}, geometricError:0, refine:"ADD", content:{uri:"box.glb"}} } };
}
