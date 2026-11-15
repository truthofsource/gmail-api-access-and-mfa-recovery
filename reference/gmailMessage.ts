import { Resolver } from 'node:dns/promises';
import { dkimVerify } from 'mailauth/lib/dkim/verify';
import { simpleParser } from 'mailparser';
import { GmailFailure } from './gmailTransport.ts';

export interface GmailProfile {
  mailboxEmail:string; senderEmail:string; signingDomain:string; mailboxRef:string; revision:string;
  providerCredentialVersion:string; prefix:string; suffix:string; digits:number;
  html:{prefix:string;suffix:string}; exclusiveProviderMailbox:boolean;
}
export function readGmailProfile(value:unknown):GmailProfile {
  const p=value as GmailProfile;
  const reference=(v:unknown)=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(v);
  const address=(v:unknown)=>typeof v==='string'&&/^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+$/.test(v);
  if(!p || !address(p.mailboxEmail)||!address(p.senderEmail)||p.signingDomain!=='provider.example.invalid'||
      p.senderEmail.split('@')[1].toLowerCase()!==p.signingDomain||!reference(p.mailboxRef)||!reference(p.revision)||
      !reference(p.providerCredentialVersion)||p.digits!==6||p.exclusiveProviderMailbox!==true||
      ![p.prefix,p.suffix,p.html?.prefix,p.html?.suffix].every(v=>typeof v==='string'&&v.length>0&&v.length<=16384))throw new GmailFailure('configuration');
  if(p.prefix.length>4096||p.suffix.length>4096)throw new GmailFailure('configuration');
  const normalize=(v:string)=>v.replace(/\r\n/g,'\n');
  return {...p,mailboxEmail:p.mailboxEmail.toLowerCase(),senderEmail:p.senderEmail.toLowerCase(),
    prefix:normalize(p.prefix),suffix:normalize(p.suffix),html:{prefix:normalize(p.html.prefix),suffix:normalize(p.html.suffix)}};
}
/** Verify the raw message cryptographically; never trust supplied Authentication-Results. */
export async function verifyGmailMessage(raw:Buffer, profile:GmailProfile, signal:AbortSignal,
  verify:typeof dkimVerify=dkimVerify) {
  if(raw.length>262144 || signal.aborted)throw new GmailFailure('invalid_response');
  const headerEnd=raw.indexOf('\r\n\r\n');
  if(headerEnd<0||headerEnd>32768||(raw.subarray(0,headerEnd).toString('latin1').match(/^DKIM-Signature:/gim)?.length??0)>4)
    throw new GmailFailure('invalid_response');
  const resolver=new Resolver({timeout:1500,tries:1});
  const cancel=()=>resolver.cancel();signal.addEventListener('abort',cancel,{once:true});
  let queries=0;
  try {
    const signatures=await verify(raw,{strict:true,minBitLength:2048,resolver:async(name,type)=>{
      if(signal.aborted||++queries>4||type!=='TXT'||name.length>253||
          !name.toLowerCase().endsWith('._domainkey.'+profile.signingDomain))throw new Error('dns_unavailable');
      return resolver.resolveTxt(name);
    }});
    const valid=signatures.results.some(s=>s.status.result==='pass' && s.signingDomain?.toLowerCase()===profile.signingDomain &&
      s.algo==='rsa-sha256' && s.signatureTimeValid===true && !s.status.underSized && !s.status.testing &&
      ['from','to','subject','content-type'].every(header=>s.signingHeaders?.keys.toLowerCase().split(':').map(v=>v.trim()).includes(header)));
    if(!valid||signal.aborted)throw new GmailFailure('authorization');
    const parsed=await simpleParser(raw,{skipHtmlToText:true,skipTextToHtml:true,skipImageLinks:true,skipTextLinks:true});
    for(const key of ['from','to','subject','content-type'])if(parsed.headerLines.filter(h=>h.key===key).length!==1)throw new GmailFailure('invalid_response');
    const to=Array.isArray(parsed.to)?parsed.to.flatMap(v=>v.value):parsed.to?.value;
    if(parsed.from?.value.length!==1 || parsed.from.value[0].address?.toLowerCase()!==profile.senderEmail ||
      to?.length!==1 || to[0].address?.toLowerCase()!==profile.mailboxEmail ||
      parsed.subject!=='Provider Email Verification Code' || parsed.attachments.length ||
      typeof parsed.text!=='string'||typeof parsed.html!=='string')throw new GmailFailure('authorization');
    const contentType=parsed.headers.get('content-type') as {value?:string;params?:{boundary?:string}}|undefined;
    const boundary=contentType?.params?.boundary;
    if(contentType?.value!=='multipart/alternative'||!boundary||boundary.length>100||/[\r\n]/.test(boundary))throw new GmailFailure('invalid_response');
    // Only the verified two-alternative shape is supported. Extra/nested parts fall back to manual entry.
    const lines=raw.toString('latin1').split(/\r?\n/), open='--'+boundary, close=open+'--';
    const openings=lines.filter(line=>line===open).length, closings=lines.filter(line=>line===close).length;
    if(openings!==2||closings!==1)throw new GmailFailure('invalid_response');
    const parts=[...raw.toString('latin1').matchAll(/^Content-Type:\s*(text\/plain|text\/html|multipart\/[^;\s]+)/gim)];
    if(parts.length!==3||parts.filter(p=>p[1].toLowerCase()==='text/plain').length!==1||parts.filter(p=>p[1].toLowerCase()==='text/html').length!==1)
      throw new GmailFailure('invalid_response');
    return {mimeType:'multipart/alternative',parts:[['text/plain',parsed.text],['text/html',parsed.html]].map(([mimeType,text])=>({
      mimeType,body:{data:Buffer.from(text.replace(/\r\n/g,'\n')).toString('base64url')}
    }))};
  }catch(error){if(error instanceof GmailFailure)throw error;throw new GmailFailure('authorization');}
  finally{signal.removeEventListener('abort',cancel);resolver.cancel();}
}
