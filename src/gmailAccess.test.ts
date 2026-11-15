import assert from 'node:assert/strict';
import test from 'node:test';
import { boundedGoogleJson,openGmail,gmailScope } from './gmailTransport.ts';
import { gmailLookupDiagnostic } from './gmailLookupDiagnostics.ts';
import { receivedAfterConfirmedSend } from './mailbox/candidate-binding.js';
import { selectMailboxCandidate } from './mailbox/mailbox-candidate.js';
test('reject foreign or insecure endpoints without any request',async()=>{
  let calls=0;const fake=(async()=>{calls++;return Response.json({});}) as typeof fetch;
  for(const url of ['https://example.invalid','http://gmail.googleapis.com','https://user@gmail.googleapis.com','https://gmail.googleapis.com:8443'])
    await assert.rejects(boundedGoogleJson(url,{},100,AbortSignal.timeout(1000),fake));
  assert.equal(calls,0);
});
test('bound response bytes and suppress provider error contents',async()=>{
  await assert.rejects(boundedGoogleJson('https://gmail.googleapis.com/test',{},100,AbortSignal.timeout(1000),(async()=>new Response('x'.repeat(101))) as typeof fetch),/invalid_response/);
  await assert.rejects(boundedGoogleJson('https://gmail.googleapis.com/test',{},100,AbortSignal.timeout(1000),(async()=>new Response('private details',{status:403})) as typeof fetch),/^Error: authorization$/);
});
test('OAuth scope and actual account must match before mail retrieval',async()=>{
  const c={clientId:'example.apps.googleusercontent.com',clientSecret:'fictional',refreshToken:'fictional',mailboxEmail:'reader@example.invalid'};
  for(const wrongScope of [true,false]){
    let calls=0;const fake=(async()=>++calls===1?Response.json({access_token:'fictional',token_type:'Bearer',scope:wrongScope?'https://mail.google.com/':gmailScope}):Response.json({emailAddress:'wrong@example.invalid'})) as typeof fetch;
    await assert.rejects(openGmail(c,AbortSignal.timeout(1000),fake),/authorization/);
    assert.equal(calls,wrongScope?1:2);
  }
});
test('read-only fake transport checks account then lists and retrieves a message',async()=>{
  const c={clientId:'example.apps.googleusercontent.com',clientSecret:'fictional',refreshToken:'fictional',mailboxEmail:'reader@example.invalid'};
  const calls:string[]=[];
  const fake=(async(url:string,init:RequestInit)=>{
    calls.push(String(url));
    if(calls.length===1)return Response.json({access_token:'fictional',token_type:'Bearer',scope:gmailScope});
    assert.equal(init.headers?.['Authorization'],'Bearer fictional');
    if(calls.length===2)return Response.json({emailAddress:c.mailboxEmail});
    if(calls.length===3)return Response.json({messages:[{id:'fictional1'}]});
    return Response.json({id:'fictional1',raw:Buffer.from('Fictional message only').toString('base64url'),internalDate:'1000000'});
  }) as typeof fetch;
  const g=await openGmail(c,AbortSignal.timeout(1000),fake);await g.list(999,1002,'sender@example.invalid');
  assert.equal((await g.raw('fictional1')).receivedAtMs,1000000);assert.equal(calls.length,4);
  assert.ok(calls[2].includes('includeSpamTrash=false'));
});
test('same whole-second arrival is allowed; older precise timestamps remain stale',()=>{
  const send=1700000000456;
  assert.equal(receivedAfterConfirmedSend(1700000000000,send),true);
  assert.equal(receivedAfterConfirmedSend(1700000000455,send),false);
  assert.equal(receivedAfterConfirmedSend(1699999999000,send),false);
  assert.equal(receivedAfterConfirmedSend(send,send),true);
  assert.equal(receivedAfterConfirmedSend(NaN,send),false);
});
test('diagnostics never echo arbitrary provider or mailbox details',()=>{
  assert.equal(gmailLookupDiagnostic('authorization'),'authorization');
  assert.equal(gmailLookupDiagnostic('no_candidate'),'no_candidate');
  assert.equal(gmailLookupDiagnostic('reader@example.invalid'),'unclassified_failure');
  assert.equal(gmailLookupDiagnostic('disabled'),null);
});
const plan={ok:true,deadlineMs:1010000,candidateNotBeforeMs:999000,mailboxRef:'fictional',profileRevision:'v1',requestId:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',challengeId:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',credentialVersion:'v1',sendGeneration:'send1'};
const profile={revision:'v1',prefix:'DEMO ',suffix:' END',digits:6};
const message={id:'fictional1',receivedAtMs:1000000,previouslyClaimed:false,trustedEvidence:{mailboxRef:'fictional',profileRevision:'v1',authenticatedSender:true,recipientMatches:true,accountCorrelation:true},payload:{mimeType:'text/plain',body:{data:Buffer.from('DEMO 123456 END').toString('base64url')}}};
test('one candidate is selected only after trusted internal evidence',()=>{
  assert.equal(selectMailboxCandidate(plan,profile,{complete:true,pages:1,messages:[message]},1000000).ok,true);
  assert.equal(selectMailboxCandidate(plan,profile,{complete:true,pages:1,messages:[{...message,trustedEvidence:{}}]},1000000).reason,'untrusted_candidate');
});
test('multiple messages, duplicate IDs and incomplete enumeration never auto-select',()=>{
  assert.equal(selectMailboxCandidate(plan,profile,{complete:true,pages:1,messages:[message,{...message,id:'fictional2'}]},1000000).reason,'ambiguous');
  assert.equal(selectMailboxCandidate(plan,profile,{complete:true,pages:1,messages:[message,message]},1000000).reason,'duplicate_message');
  assert.equal(selectMailboxCandidate(plan,profile,{complete:false,pages:1,messages:[message]},1000000).reason,'incomplete_or_oversized_batch');
});
