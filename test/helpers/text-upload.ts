// Synthetic trusted folder enrollment, followed by the public text upload protocol.
// No production registration shortcut: tests seed only their isolated in-memory catalog.
import { sha256Hex, type Catalog } from "@kl/core";
const calls=new WeakMap<Catalog,number>();
export async function textUpload(catalog:Catalog,api:(r:Request)=>Promise<Response>,token:string,content:string,opts:{collection?:string;path?:string;headers?:Record<string,string>}={}) {
  const n=(calls.get(catalog)??0)+1;calls.set(catalog,n);
  const principal=catalog.db.get<{principal:string}>("SELECT principal FROM tokens WHERE hash=?",[sha256Hex(token)])!.principal;
  const collection=opts.collection??`inbox:${principal}`,folderId=`folder:upload-fixture-${n}`;
  catalog.db.run("INSERT INTO folders(folderId,device,volumeSerial,rootFileId,display_path_h,owner_principal,collectionId) VALUES (?,?,?,?,?,?,?)",[folderId,"fixture-device","fixture-volume",`fixture-root-${n}`,"0".repeat(64),principal,collection]);
  const send=(path:string,body:string,method="POST",headers:Record<string,string>={})=>api(new Request(`http://kl.local${path}`,{method,headers:{authorization:`Bearer ${token}`,"content-type":"application/json",...headers},body}));
  const diff=await(await send("/v1/manifest/diff",JSON.stringify({snapshotId:`upload-fixture-${n}`,folderId,device:"fixture-device",collection,identity:{volumeSerial:"fixture-volume",rootFileId:`fixture-root-${n}`},scanComplete:true,heldLocal:{},entries:[{relPath:opts.path??`fixture-${n}.md`,sha256:sha256Hex(content),size:new TextEncoder().encode(content).length,mtime:catalog.clock.now(),gitTracked:false}]}))).json();
  if(!diff.pushId)return diff;
  const staged=await(await send(`/v1/upload/${diff.pushId}/0`,content,"PUT",{"content-type":"text/plain",...opts.headers})).json();
  if(!staged.ok)return staged;
  const committed=await(await send("/v1/commit",JSON.stringify({pushId:diff.pushId}))).json();
  return committed.results?.[0]??committed;
}
