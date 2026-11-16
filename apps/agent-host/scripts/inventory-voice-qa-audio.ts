import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
const run=promisify(execFile);
/** No microphone or user-supplied file. The known sentence is synthesized straight to disk, not played. */
export async function inventoryQaWav(dir:string,sentence="我只设计了重试流程，没有上线。"){
  const aiff=path.join(dir,"synthetic.aiff"),original=path.join(dir,"synthetic.wav"),output=path.join(dir,"fake-microphone.wav");
  await run("/usr/bin/say",["-v","Tingting","-r","145","-o",aiff,sentence]);
  await run("/usr/bin/afconvert",["-f","WAVE","-d","LEI16@16000","-c","1",aiff,original]);
  const raw=await readFile(original);let start=12,pcm:Buffer|undefined;
  while(start+8<=raw.length){const len=raw.readUInt32LE(start+4);if(raw.toString("ascii",start,start+4)==="data"){pcm=raw.subarray(start+8,start+8+len);break;}start+=8+len+(len&1);}
  if(!pcm||pcm.length<32000||pcm.length>320000)throw Error("Expected a nonempty 1–10s synthetic utterance, not a silent/missing TTS engine.");
  const bytes=Buffer.concat([Buffer.alloc(16000),pcm,Buffer.alloc(48000)]),head=Buffer.alloc(44);
  head.write("RIFF");head.writeUInt32LE(36+bytes.length,4);head.write("WAVEfmt ",8);head.writeUInt32LE(16,16);head.writeUInt16LE(1,20);
  head.writeUInt16LE(1,22);head.writeUInt32LE(16000,24);head.writeUInt32LE(32000,28);head.writeUInt16LE(2,32);head.writeUInt16LE(16,34);
  head.write("data",36);head.writeUInt32LE(bytes.length,40);await writeFile(output,Buffer.concat([head,bytes]),{flag:"wx",mode:0o600});
  return {output,duration:bytes.length/32000};
}
