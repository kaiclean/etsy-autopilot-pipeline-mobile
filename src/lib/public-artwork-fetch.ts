import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { isSafeArtworkUrl } from "./art-quality";

export function publicAddress(address:string) {
  if(!isIP(address)) return false;
  if(address.includes(':')) return !/^(::|0:|fc|fd|fe[89ab]|ff)/i.test(address) && !address.includes('.');
  const [a,b]=address.split('.').map(Number);
  return a>0 && a<224 && ![10,127].includes(a) && !(a===169&&b===254) && !(a===172&&b>=16&&b<=31) && !(a===192&&[0,168].includes(b)) && !(a===100&&b>=64&&b<=127) && !(a===198&&[18,19].includes(b));
}
/** Pin the validated DNS address on the connection; do not resolve it a second time in fetch(). */
export async function fetchPublicArtwork(src:string,maximum:number):Promise<Response> {
  if(!isSafeArtworkUrl(src)) throw new Error('Artwork URL must be public HTTPS');
  const url=new URL(src);
  if(url.username||url.password||url.port&&url.port!=='443') throw new Error('Invalid artwork origin');
  const addresses=await lookup(url.hostname,{all:true});
  if(!addresses.length || addresses.some(a=>!publicAddress(a.address))) throw new Error('Artwork origin resolves to a private address');
  const pinned=addresses[0];
  return new Promise((resolve,reject)=>{
    const deadline=setTimeout(()=>req.destroy(new Error("Artwork timeout")),15000);
    const req=request(url,{
      method:'GET',timeout:15000,family:pinned.family,
      lookup:(_hostname,_opts,callback)=>callback(null,pinned.address,pinned.family),
    },response=>{
      const status=response.statusCode??502;
      if(status>=300&&status<400) { response.destroy(); reject(new Error('Artwork redirects are refused')); return; }
      if(Number(response.headers['content-length'])>maximum) {response.destroy();reject(new Error('Artwork too large'));return;}
      const chunks:Buffer[]=[];let size=0;
      response.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>maximum) response.destroy(new Error('Artwork too large'));else chunks.push(chunk);});
      response.on('error',error=>{clearTimeout(deadline);reject(error);});
      response.on('end',()=>{clearTimeout(deadline);resolve(new Response(status===204||status===304?null:new Uint8Array(Buffer.concat(chunks)),{status,headers:{'content-type':String(response.headers['content-type']??'application/octet-stream')}}));});
    });
    req.on('timeout',()=>req.destroy(new Error('Artwork timeout')));req.on('error',error=>{clearTimeout(deadline);reject(error);});req.end();
  });
}
