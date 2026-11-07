/** Bounded outcome only: never log exception text, mailbox data or code material. */
export function gmailLookupDiagnostic(status:string):string|null {
 if(status==='disabled'||status==='idle')return null;
 const allowed=['no_candidate','submitted','authorization','throttled','transport',
  'invalid_response','configuration','expired','ambiguous','lookup_changed',
  'template_mismatch','malformed_mime','unsupported_mime','malformed_encoding',
  'mime_limit','incomplete_or_oversized_batch','untrusted_candidate',
  'invalid_message_time','invalid_message','duplicate_message','claimed_or_unknown',
  'invalid_profile','invalid_binding','invalid_or_expired_plan'];
 return allowed.includes(status)?status:'unclassified_failure';
}
