SET NOCOUNT ON;
SET XACT_ABORT ON;
BEGIN TRY
 BEGIN TRANSACTION;
 IF NOT EXISTS(SELECT 1 FROM dbo.schema_migrations WHERE version=N'130_provider_mfa_reconnection') THROW 65901,'Migration 130 is required.',1;
 IF EXISTS(SELECT 1 FROM dbo.schema_migrations WHERE version=N'159_provider_gmail_lookup') THROW 65902,'Migration 159 is already applied.',1;
 DECLARE @principal sysname=CASE DB_NAME()
  WHEN N'sqldb-workforce-workforce-production' THEN N'func-workforce-workforce-production-centralus-001'
  WHEN N'sqldb-example-workforce-nonproduction' THEN N'func-example-workforce-nonproduction-eastus2-001' ELSE NULL END;
 IF @principal IS NULL OR DATABASE_PRINCIPAL_ID(@principal) IS NULL THROW 65903,'Expected API principal is missing.',1;
 ALTER TABLE dbo.provider_mfa_sessions ADD
  mailbox_generation uniqueidentifier NULL,
  mailbox_sent_at_utc datetime2 NULL,
  mailbox_status nvarchar(20) NULL,
  mailbox_lookup_id uniqueidentifier NULL,
  mailbox_lease_until_utc datetime2 NULL,
  mailbox_next_lookup_at_utc datetime2 NULL,
  mailbox_attempts smallint NOT NULL CONSTRAINT DF_mfa_mailbox_attempts DEFAULT 0,
  mailbox_reason nvarchar(40) NULL;
 -- Compile constraints after the new columns exist, retaining the same transaction.
 EXEC sys.sp_executesql N'ALTER TABLE dbo.provider_mfa_sessions ADD CONSTRAINT CK_mfa_mailbox_status
  CHECK(mailbox_status IS NULL OR mailbox_status IN(N''pending'',N''looking'',N''manual'',N''submitted''));';
 EXEC sys.sp_executesql N'ALTER TABLE dbo.provider_mfa_sessions ADD CONSTRAINT CK_mfa_mailbox_attempts CHECK(mailbox_attempts BETWEEN 0 AND 20);';
 CREATE TABLE dbo.provider_mfa_mailbox_claims(
  message_hash binary(32) NOT NULL CONSTRAINT PK_mfa_mailbox_claims PRIMARY KEY,
  request_id uniqueidentifier NOT NULL REFERENCES dbo.provider_mfa_sessions(request_id),
  send_generation uniqueidentifier NOT NULL,
  challenge_id uniqueidentifier NOT NULL,
  claimed_at_utc datetime2 NOT NULL CONSTRAINT DF_mfa_mailbox_claimed DEFAULT SYSUTCDATETIME(),
  CONSTRAINT UQ_mfa_mailbox_generation UNIQUE(request_id,send_generation)
 );
 DECLARE @grants nvarchar(max)=N'GRANT SELECT, INSERT ON dbo.provider_mfa_mailbox_claims TO '+QUOTENAME(@principal)+N';'
  +N'DENY UPDATE, DELETE ON dbo.provider_mfa_mailbox_claims TO '+QUOTENAME(@principal)+N';';
 EXEC sys.sp_executesql @grants;
 INSERT dbo.schema_migrations(version,description) VALUES(N'159_provider_gmail_lookup',N'Bounded MFA mailbox leases and atomic encrypted-command claims; no plaintext email or verification code.');
 COMMIT;
END TRY BEGIN CATCH IF XACT_STATE()<>0 ROLLBACK; THROW; END CATCH;
