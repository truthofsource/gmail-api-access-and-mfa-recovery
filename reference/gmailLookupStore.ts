import * as sql from 'mssql';
import { randomUUID } from 'node:crypto';
import { getSqlPool } from '../db/sqlPool.ts';

export interface LookupLease {
 requestId:string; challengeId:string; sendGeneration:string; credentialVersion:string; workerLease:string;
 lookupId:string; publicKey:string; sentAt:Date; expiresAt:Date; workerExpiresAt:Date; attempts:number;
}
const eligibility=`r.status=N'running' AND r.kind=N'connection_test' AND r.active_connection_id=1
 AND r.secret_version=c.secret_version AND r.lease_expires_at_utc>DATEADD(second,30,SYSUTCDATETIME())
 AND m.interactive=1 AND m.state=N'enter_code' AND m.command_kind IS NULL
 AND m.challenge_id IS NOT NULL AND m.public_key IS NOT NULL
 AND m.expires_at_utc>SYSUTCDATETIME() AND m.mailbox_sent_at_utc>DATEADD(minute,-5,SYSUTCDATETIME())
 AND m.mailbox_sent_at_utc<=SYSUTCDATETIME()`;
export const acquireLookupSql=`
 SELECT TOP(2) m.request_id AS requestId,m.challenge_id AS challengeId,m.mailbox_generation AS sendGeneration,
 r.secret_version AS credentialVersion,r.lease_id AS workerLease,m.public_key AS publicKey,m.mailbox_sent_at_utc AS sentAt,
 m.expires_at_utc AS expiresAt,r.lease_expires_at_utc AS workerExpiresAt,m.mailbox_attempts AS attempts
 FROM dbo.provider_connection c WITH(UPDLOCK,HOLDLOCK)
 JOIN dbo.provider_sync_requests r WITH(UPDLOCK,HOLDLOCK) ON c.connection_id=1
 JOIN dbo.provider_mfa_sessions m WITH(UPDLOCK,HOLDLOCK) ON m.request_id=r.request_id
 WHERE ${eligibility} AND m.mailbox_generation IS NOT NULL AND m.mailbox_attempts<20
 AND (m.mailbox_status=N'pending' OR (m.mailbox_status=N'looking' AND m.mailbox_lease_until_utc<SYSUTCDATETIME()))
 AND (m.mailbox_next_lookup_at_utc IS NULL OR m.mailbox_next_lookup_at_utc<=SYSUTCDATETIME());`;
export async function acquireLookup(pool?:sql.ConnectionPool):Promise<LookupLease|null>{
 const tx=new sql.Transaction(pool??await getSqlPool());await tx.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
 try{
  const rows=(await new sql.Request(tx).query(acquireLookupSql)).recordset;
  if(rows.length!==1){await tx.commit();return null;}
  const row=rows[0] as LookupLease, lookupId=randomUUID();
  await new sql.Request(tx).input('request',sql.UniqueIdentifier,row.requestId).input('lookup',sql.UniqueIdentifier,lookupId).query(`
   UPDATE dbo.provider_mfa_sessions SET mailbox_lookup_id=@lookup,mailbox_status=N'looking',
    mailbox_lease_until_utc=DATEADD(second,45,SYSUTCDATETIME()),mailbox_attempts=mailbox_attempts+1 WHERE request_id=@request;`);
  await tx.commit();return {...row,lookupId,attempts:row.attempts+1};
 }catch(error){try{await tx.rollback();}catch{}throw error;}
}
export const claimLookupSql=`
 IF NOT EXISTS(SELECT 1 FROM dbo.provider_connection c WITH(UPDLOCK,HOLDLOCK)
 JOIN dbo.provider_sync_requests r WITH(UPDLOCK,HOLDLOCK) ON c.connection_id=1
 JOIN dbo.provider_mfa_sessions m WITH(UPDLOCK,HOLDLOCK) ON m.request_id=r.request_id
 WHERE ${eligibility} AND m.request_id=@request AND m.challenge_id=@challenge AND m.mailbox_generation=@generation
 AND r.lease_id=@workerLease AND r.secret_version=@credential AND m.public_key=@publicKey
 AND m.mailbox_lookup_id=@lookup AND m.mailbox_status=N'looking' AND m.mailbox_lease_until_utc>SYSUTCDATETIME())
 THROW 65910,'Mailbox lookup changed.',1;
 IF EXISTS(SELECT 1 FROM dbo.provider_mfa_mailbox_claims WITH(UPDLOCK,HOLDLOCK)
 WHERE message_hash=@hash OR (request_id=@request AND send_generation=@generation)) THROW 65911,'Mailbox command already claimed.',1;
 INSERT dbo.provider_mfa_mailbox_claims(message_hash,request_id,send_generation,challenge_id) VALUES(@hash,@request,@generation,@challenge);
 UPDATE dbo.provider_mfa_sessions SET command_kind=N'code',command_ciphertext=@ciphertext,
 mailbox_status=N'submitted',mailbox_reason=NULL,mailbox_lookup_id=NULL,mailbox_lease_until_utc=NULL,updated_at_utc=SYSUTCDATETIME()
 WHERE request_id=@request;`;
export async function claimLookup(lease:LookupLease,messageHash:Buffer,ciphertext:string,pool?:sql.ConnectionPool){
 if(messageHash.length!==32||!/^[A-Za-z0-9+/]{342}==$/.test(ciphertext))throw new Error('invalid_mailbox_claim');
 const tx=new sql.Transaction(pool??await getSqlPool());await tx.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
 try{
  await new sql.Request(tx).input('request',sql.UniqueIdentifier,lease.requestId).input('challenge',sql.UniqueIdentifier,lease.challengeId)
   .input('generation',sql.UniqueIdentifier,lease.sendGeneration).input('lookup',sql.UniqueIdentifier,lease.lookupId)
   .input('workerLease',sql.UniqueIdentifier,lease.workerLease).input('credential',sql.NVarChar(100),lease.credentialVersion)
   .input('publicKey',sql.NVarChar(1024),lease.publicKey).input('hash',sql.VarBinary(32),messageHash).input('ciphertext',sql.VarChar(512),ciphertext)
   .query(claimLookupSql);
  await tx.commit();return true;
 }catch(error){try{await tx.rollback();}catch{}throw error;}
}
export async function releaseLookup(lease:LookupLease,reason:string,retry:boolean,pool?:sql.ConnectionPool){
 const safe=['no_candidate','authorization','throttled','transport','invalid_response','configuration','expired','ambiguous','lookup_changed'];
 await(pool??await getSqlPool()).request().input('request',sql.UniqueIdentifier,lease.requestId).input('lookup',sql.UniqueIdentifier,lease.lookupId)
 .input('reason',sql.NVarChar(40),safe.includes(reason)?reason:'invalid_response').input('retry',sql.Bit,retry&&lease.attempts<20).query(`
 UPDATE dbo.provider_mfa_sessions SET mailbox_status=CASE WHEN @retry=1 THEN N'pending' ELSE N'manual' END,
 mailbox_reason=@reason,mailbox_next_lookup_at_utc=DATEADD(second,20,SYSUTCDATETIME()),mailbox_lookup_id=NULL,mailbox_lease_until_utc=NULL
 WHERE request_id=@request AND mailbox_lookup_id=@lookup AND mailbox_status=N'looking';`);
}
