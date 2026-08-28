// Placeholder parameter file. Copy it outside the repository, fill in real values there, and never
// commit a copy containing secrets. Secure parameters may also be supplied on the command line or
// read from an institutional secret store at deploy time.

using './main.bicep'

param location = 'australiaeast'
param environmentName = 'capstone-assistive-executor'
param dispatcherJobName = 'capstone-assistive-dispatcher'
param workerJobName = 'capstone-assistive-worker'
param dispatcherIdentityName = 'capstone-assistive-dispatcher-identity'

param dispatcherImageRepository = 'ghcr.io/REPLACE-ORG/capstone-assistive-dispatcher'
param dispatcherImageDigest = 'sha256:0000000000000000000000000000000000000000000000000000000000000000'
param workerImageRepository = 'ghcr.io/REPLACE-ORG/capstone-assistive-worker'
param workerImageDigest = 'sha256:0000000000000000000000000000000000000000000000000000000000000000'

param deploymentVersion = '0000000000000000000000000000000000000000'
param expectedSupabaseHost = 'REPLACE-PROJECT-REF.supabase.co'
param assistiveSupabaseUrl = 'https://REPLACE-PROJECT-REF.supabase.co'
param dispatcherCronExpression = '*/2 * * * *'

// Never store real values here.
param supabaseSecretKey = 'REPLACE_AT_DEPLOY_TIME'
param dispatcherDatabaseUrl = 'REPLACE_AT_DEPLOY_TIME'
