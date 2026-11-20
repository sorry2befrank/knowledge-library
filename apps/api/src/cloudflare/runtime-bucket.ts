import type { ArchiveBucket } from './r2-store.ts';
interface SizedBucket extends Omit<ArchiveBucket,'get'> {
  get(key:string):Promise<{size:number;body:{cancel():Promise<void>};arrayBuffer():Promise<ArrayBuffer>}|null>;
}

/** P0's bounded text/projection pilot. Check R2's object length before buffering
 * and verify the returned byte count; the outer safety store supplies deadlines. */
export function boundedArchiveBucket(bucket:SizedBucket,maxBytes=16*1024*1024):ArchiveBucket{
  return {
    put(key,bytes,options){if(bytes.byteLength>maxBytes)throw Error('archive-object-too-large');return bucket.put(key,bytes,options);},
    async get(key){
      const object=await bucket.get(key);if(!object)return null;
      if(!Number.isSafeInteger(object.size)||object.size<0||object.size>maxBytes){void object.body.cancel().catch(()=>{});throw Error('archive-object-too-large');}
      return {async arrayBuffer(){const bytes=await object.arrayBuffer();if(bytes.byteLength!==object.size||bytes.byteLength>maxBytes)throw Error('archive-object-size-mismatch');return bytes;}};
    },
    delete:key=>bucket.delete(key),
    list:options=>bucket.list(options),
  };
}
