import { createHmac } from 'node:crypto';
import { DefaultAzureCredential } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';
import { openGmail, readGmailCredentials, gmailScope, GmailFailure } from './gmailTransport.ts';
import { readGmailProfile, verifyGmailMessage } from './gmailMessage.ts';
import { acquireLookup, claimLookup, releaseLookup, type LookupLease } from './gmailLookupStore.ts';
import { planMailboxLookup } from './mailbox/mailbox-plan.ts';
import { enumerateMail } from './mailbox/enumerate-mail.ts';
import { selectMailboxCandidate } from './mailbox/mailbox-candidate.ts';
import { encryptMfaCode } from './providerMfa.ts';
import { receivedAfterConfirmedSend } from './mailbox/candidate-binding.ts';

const secretName='provider-gmail-authorization';
export async function readGmailAuthorization(){
 const vault=process.env.PROVIDER_GMAIL_VAULT_URL??'';
 if(!/^https:\/\/[a-z0-9-]+\.vault\.azure\.net\/?$/.test(vault))throw new GmailFailure('configuration');
 const client=new SecretClient(vault,new DefaultAzureCredential());
 const secret=await client.getSecret(secretName);
 if(!secret.value||secret.value.length>65536||!secret.properties.version||secret.properties.enabled===false)throw new GmailFailure('configuration');
 let bundle;try{bundle=JSON.parse(secret.value);}catch{throw new GmailFailure('configuration');}
 if(bundle.schemaVersion!==1||bundle.scope!==gmailScope||typeof bundle.dedupeKey!=='string'||!/^[a-f0-9]{64}$/.test(bundle.dedupeKey))throw new GmailFailure('configuration');
 const credentials=readGmailCredentials(bundle),profile=readGmailProfile(bundle.profile);
 if(profile.mailboxEmail!==credentials.mailboxEmail)throw new GmailFailure('configuration');
 return {credentials,profile,dedupeKey:bundle.dedupeKey as string,version:secret.properties.version,
  stillCurrent:async()=>{const current=await client.getSecret(secretName);return current.properties.enabled!==false&&current.properties.version===secret.properties.version;}};
}
const defaults={acquire:acquireLookup,claim:claimLookup,release:releaseLookup,authorization:readGmailAuthorization,
 open:openGmail,verify:verifyGmailMessage,now:Date.now};
export async function runGmailLookup(deps=defaults):Promise<string>{
 if(process.env.PROVIDER_GMAIL_LOOKUP_ENABLED!=='true')return 'disabled';
 let lease:LookupLease|null=null;
 try{
  lease=await deps.acquire();if(!lease)return 'idle';
  const authorization=await deps.authorization();
  if(authorization.profile.providerCredentialVersion!==lease.credentialVersion)throw new GmailFailure('configuration');
  const plan=planMailboxLookup({enabled:true,provider:'gmail',profileVerified:true,profileRevision:authorization.profile.revision,
   mailboxRef:authorization.profile.mailboxRef},{state:'enter_code',commandPending:false,interactive:true,leaseVerified:true,singleActiveAttempt:true,
   requestId:lease.requestId,challengeId:lease.challengeId,sendGeneration:lease.sendGeneration,credentialVersion:lease.credentialVersion,
   sentAtMs:lease.sentAt.getTime(),sessionExpiresMs:lease.expiresAt.getTime(),leaseExpiresMs:lease.workerExpiresAt.getTime()},deps.now());
  if(!plan.ok || !('deadlineMs' in plan))throw new GmailFailure('expired');
  const remaining=Math.min(25000,plan.deadlineMs-deps.now());if(remaining<=0)throw new GmailFailure('expired');
  const signal=AbortSignal.timeout(remaining);
  const gmail=await deps.open(authorization.credentials,signal);
  let adapterFailure:GmailFailure|undefined;
  async function observeFailure<T>(operation:()=>Promise<T>):Promise<T>{
   try{return await operation();}catch(error){
    if(error instanceof GmailFailure)adapterFailure=error;
    throw error;
   }
  }
  const batch=await enumerateMail(plan,{
   list:({afterEpochSeconds,beforeEpochSeconds,pageToken}:{afterEpochSeconds:number;beforeEpochSeconds:number;pageToken?:string})=>
    observeFailure(()=>gmail.list(afterEpochSeconds,beforeEpochSeconds,authorization.profile.senderEmail,pageToken)),
   get:({id}:{id:string})=>observeFailure(async()=>{
    const message=await gmail.raw(id);
    if(!receivedAfterConfirmedSend(message.receivedAtMs,plan.candidateNotBeforeMs) || message.receivedAtMs>deps.now())return {...message,raw:undefined};
    const payload=await deps.verify(message.raw,authorization.profile,signal);
    return {id:message.id,receivedAtMs:message.receivedAtMs,payload,previouslyClaimed:false,
     trustedEvidence:{mailboxRef:plan.mailboxRef,profileRevision:plan.profileRevision,authenticatedSender:true,recipientMatches:true,accountCorrelation:true}};
   })
  },{now:deps.now});
  // Enumeration suppresses exception text; retain only our bounded error category.
  if(!batch.ok&&adapterFailure)throw adapterFailure;
  const candidate=selectMailboxCandidate(plan,authorization.profile,batch,deps.now());
  if(!candidate.ok||!('code' in candidate)){
   const reason='reason' in candidate?candidate.reason:'invalid_response';
   await deps.release(lease,reason,reason==='no_candidate');return reason;
  }
  if(!await authorization.stillCurrent()||signal.aborted||deps.now()>=plan.deadlineMs||
    process.env.PROVIDER_GMAIL_LOOKUP_ENABLED!=='true')throw new GmailFailure('expired');
  const ciphertext=encryptMfaCode(candidate.code,lease.publicKey,lease.requestId,lease.challengeId);
  const hash=createHmac('sha256',Buffer.from(authorization.dedupeKey,'hex')).update(authorization.profile.mailboxRef+'\0'+candidate.messageRef).digest();
  // The transaction rechecks lease, generation, credential, challenge and the human command slot.
  await deps.claim(lease,hash,ciphertext);return 'submitted';
 }catch(error){
  const reason=error instanceof GmailFailure?error.reason:'lookup_changed';
  if(lease)await deps.release(lease,reason,false).catch(()=>{});
  return reason;
 }
}
