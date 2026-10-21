import {Buffer} from 'node:buffer';

// Apple's Node SDK uses node-fetch v2's default export and Response.buffer().
// Workers provides standards-based fetch; adapt only the transport interface.
export const Headers=globalThis.Headers;
export const Request=globalThis.Request;
export const Response=globalThis.Response;
export default async function fetchCompat(input,options={}) {
 const {timeout,...init}=options;
 if(timeout && !init.signal) init.signal=AbortSignal.timeout(timeout);
 const response=await globalThis.fetch(input,init);
 Object.defineProperty(response,'buffer',{value:async()=>Buffer.from(await response.arrayBuffer())});
 return response;
}
