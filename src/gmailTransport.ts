/** Direct Gmail transport. Never log requests, OAuth responses or message bodies. */
export const gmailScope = 'https://www.googleapis.com/auth/gmail.readonly';
export class GmailFailure extends Error {
  readonly reason: 'configuration'|'authorization'|'throttled'|'transport'|'invalid_response'|'expired';
  constructor(reason: 'configuration'|'authorization'|'throttled'|'transport'|'invalid_response'|'expired') { super(reason); this.reason=reason; }
}
export interface GmailCredentials { clientId: string; clientSecret: string; refreshToken: string; mailboxEmail: string; }
type Json = Record<string, unknown>;
export async function boundedGoogleJson(url: string, init: RequestInit, maxBytes: number, signal: AbortSignal,
  fetcher: typeof fetch = fetch): Promise<Json> {
  if (signal.aborted) throw new GmailFailure('expired');
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'https:' || !['oauth2.googleapis.com','gmail.googleapis.com'].includes(endpoint.hostname) || endpoint.port || endpoint.username || endpoint.password)
    throw new GmailFailure('configuration');
  try {
    const response = await fetcher(url, { ...init, redirect: 'error', signal });
    if (!response.ok) {
      await response.body?.cancel();
      throw new GmailFailure(response.status === 429 ? 'throttled' : [400,401,403].includes(response.status) ? 'authorization' : 'transport');
    }
    const length = response.headers.get('content-length');
    if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
      await response.body?.cancel(); throw new GmailFailure('invalid_response');
    }
    if (!response.body) throw new GmailFailure('invalid_response');
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > maxBytes || signal.aborted) throw new GmailFailure(signal.aborted ? 'expired' : 'invalid_response');
        chunks.push(chunk.value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const value: unknown = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GmailFailure('invalid_response');
    return value as Json;
  } catch (error) {
    if (error instanceof GmailFailure) throw error;
    throw new GmailFailure(signal.aborted ? 'expired' : 'transport');
  }
}
export function readGmailCredentials(value: unknown): GmailCredentials {
  const c = value as Partial<GmailCredentials> | null;
  if (!c || typeof c !== 'object' || !['clientId','clientSecret','refreshToken','mailboxEmail'].every(k =>
    typeof c[k as keyof GmailCredentials] === 'string' && c[k as keyof GmailCredentials]!.length > 0 && c[k as keyof GmailCredentials]!.length < 4096) ||
    !/^[A-Za-z0-9-]+\.apps\.googleusercontent\.com$/.test(c.clientId!) ||
    !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(c.mailboxEmail!)) throw new GmailFailure('configuration');
  return {clientId:c.clientId!,clientSecret:c.clientSecret!,refreshToken:c.refreshToken!,mailboxEmail:c.mailboxEmail!.toLowerCase()};
}
export async function openGmail(credentials: GmailCredentials, signal: AbortSignal, fetcher: typeof fetch = fetch) {
  const token = await boundedGoogleJson('https://oauth2.googleapis.com/token', {
    method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:new URLSearchParams({
      grant_type:'refresh_token',client_id:credentials.clientId,client_secret:credentials.clientSecret,refresh_token:credentials.refreshToken
    }).toString()
  },16384,signal,fetcher);
  if (typeof token.access_token !== 'string' || token.access_token.length > 8192 || !token.access_token.length ||
      token.token_type !== 'Bearer' || (token.scope !== undefined && token.scope !== gmailScope)) throw new GmailFailure('authorization');
  const headers = {Authorization:`Bearer ${token.access_token}`};
  const get = (path:string, limit:number) => boundedGoogleJson(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`,{headers},limit,signal,fetcher);
  const profile = await get('profile',16384);
  if (typeof profile.emailAddress !== 'string' || profile.emailAddress.toLowerCase() !== credentials.mailboxEmail) throw new GmailFailure('authorization');
  return {
    async list(after:number,before:number,sender:string,pageToken?:string) {
      if (!Number.isSafeInteger(after) || after<0 || !Number.isSafeInteger(before) || before<=after || before-after>302 ||
          !/^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+$/.test(sender) || (pageToken!==undefined && (!pageToken.length || pageToken.length>2048))) throw new GmailFailure('configuration');
      const query=new URLSearchParams({q:`from:${sender} subject:"Provider Email Verification Code" after:${after} before:${before}`,maxResults:'20',includeSpamTrash:'false'});
      if(pageToken)query.set('pageToken',pageToken);
      return get(`messages?${query}`,65536);
    },
    async raw(id:string) {
      if(!/^[A-Za-z0-9_-]{1,128}$/.test(id))throw new GmailFailure('configuration');
      const message=await get(`messages/${encodeURIComponent(id)}?format=raw`,524288);
      if(message.id!==id || typeof message.raw!=='string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(message.raw) ||
          typeof message.internalDate!=='string' || !/^\d{1,16}$/.test(message.internalDate)) throw new GmailFailure('invalid_response');
      const raw=Buffer.from(message.raw,'base64url');
      if(raw.length>262144 || raw.toString('base64url')!==message.raw.replace(/=+$/,''))throw new GmailFailure('invalid_response');
      return {id,receivedAtMs:Number(message.internalDate),raw};
    }
  };
}
