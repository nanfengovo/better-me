/** Refresh only the explicit local source-linked BetterMe.app resources.
 * No running process, profile, account, credential, or service is touched.
 * Keeps the complete previous dist next to the app for an explicit rollback.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const app=path.resolve(root,"../BetterMe.app");
const target=path.join(app,"Contents/Resources/app/dist");
const web=path.join(root,"apps/web/dist"),desktop=path.join(root,"apps/desktop/dist");
async function manifest(directory){
  const files=[];
  async function visit(relative=""){
    const location=path.join(directory,relative),stat=await fs.lstat(location);
    assert.ok(!stat.isSymbolicLink(),"resource links cannot be silently followed");
    if(stat.isDirectory()){for(const name of (await fs.readdir(location)).sort())await visit(path.join(relative,name));}
    else{assert.ok(stat.isFile(),"unexpected resource type");files.push([relative,stat.size,createHash("sha256").update(await fs.readFile(location)).digest("hex")]);}
  }
  await visit();return {files,hash:createHash("sha256").update(JSON.stringify(files)).digest("hex")};
}
assert.equal(await fs.realpath(app),app,"only the explicit adjacent app may be refreshed");
for(const directory of [web,desktop,target])assert.equal(await fs.realpath(directory),directory);
for(const file of [path.join(web,"index.html"),path.join(desktop,"main/index.cjs"),path.join(desktop,"preload/index.cjs")])assert.ok((await fs.stat(file)).isFile());
const before=await manifest(target),webBefore=await manifest(web),desktopMainBefore=await manifest(path.join(desktop,"main")),desktopPreloadBefore=await manifest(path.join(desktop,"preload"));
const staging=await fs.mkdtemp(path.join(path.dirname(app),".unified-agent-app-"));
const candidate=path.join(staging,"candidate-dist"),backup=path.join(staging,"previous-dist");
await fs.cp(web,candidate,{recursive:true,errorOnExist:true,force:false});
for(const directory of ["main","preload"])await fs.cp(path.join(desktop,directory),path.join(candidate,directory),{recursive:true,errorOnExist:true,force:false});
const built=await manifest(candidate);
assert.equal((await manifest(web)).hash,webBefore.hash,"web build changed during sync");
assert.equal((await manifest(path.join(desktop,"main"))).hash,desktopMainBefore.hash);
assert.equal((await manifest(path.join(desktop,"preload"))).hash,desktopPreloadBefore.hash);
assert.equal((await manifest(target)).hash,before.hash,"installed resources changed concurrently; refusing overwrite");
await fs.rename(target,backup);
try{await fs.rename(candidate,target);}catch(error){await fs.rename(backup,target);throw error;}
assert.equal((await manifest(target)).hash,built.hash);assert.equal((await manifest(backup)).hash,before.hash);
console.log(JSON.stringify({target,backup,files:built.files.length,installedHash:built.hash,previousHash:before.hash,webHash:webBefore.hash,processesOrUserDataChanged:false}));
