// Zero-cost assistive executor.
//
// Declares only what the executor needs: a Consumption-only Container Apps environment with log
// storage disabled, a user-assigned identity, a two-action custom role scoped to the single heavy
// job, a small scheduled dispatcher, and the scale-to-zero heavy worker.
//
// Deliberately absent, because each would create a recurring charge or a wider blast radius:
// a Log Analytics workspace, a container registry, virtual-network integration, a NAT gateway, a
// public address, and any Dedicated workload profile. Both jobs are pinned to an immutable image
// digest, and the heavy worker holds no cloud management permission whatsoever.
//
// Deploying the custom role definition requires Owner or User Access Administrator on the target
// resource group.

targetScope = 'resourceGroup'

@description('Region for the Container Apps environment and both jobs.')
param location string = resourceGroup().location

@description('Name of the Consumption-only Container Apps environment.')
param environmentName string = 'capstone-assistive-executor'

@description('Name of the scheduled dispatcher job.')
param dispatcherJobName string = 'capstone-assistive-dispatcher'

@description('Name of the on-demand heavy assistive worker job.')
param workerJobName string = 'capstone-assistive-worker'

@description('Name of the user-assigned identity the dispatcher uses to start the worker.')
param dispatcherIdentityName string = 'capstone-assistive-dispatcher-identity'

@description('Dispatcher image repository, without any tag or digest.')
param dispatcherImageRepository string

@description('Immutable dispatcher image digest, for example sha256:0123....')
param dispatcherImageDigest string

@description('Heavy worker image repository, without any tag or digest.')
param workerImageRepository string

@description('Immutable heavy worker image digest, for example sha256:0123....')
param workerImageDigest string

@description('Exact 40-character lowercase commit the images were built from.')
param deploymentVersion string

@description('Exact canonical hostname of the approved staging Supabase project.')
param expectedSupabaseHost string

@description('Canonical https base URL of the approved staging Supabase project.')
param assistiveSupabaseUrl string

@description('Modern sb_secret_... server credential for the heavy worker.')
@secure()
param supabaseSecretKey string

@description('libpq URL authenticating as the dedicated capstone_assistive_dispatcher role.')
@secure()
param dispatcherDatabaseUrl string

@description('Reviewed dispatcher schedule. Five-field cron, evaluated by the platform in UTC.')
@allowed([
  '*/2 * * * *'
  '*/3 * * * *'
])
param dispatcherCronExpression string = '*/2 * * * *'

var workerImage = '${workerImageRepository}@${workerImageDigest}'
var dispatcherImage = '${dispatcherImageRepository}@${dispatcherImageDigest}'
var providerArtifacts = [
  {
    name: 'CAPSTONE_ASSISTIVE_PADDLE_MODELS_DIR'
    value: '/opt/capstone/artifacts/paddle'
  }
  {
    name: 'CAPSTONE_ASSISTIVE_LANGUAGETOOL_ARCHIVE'
    value: '/opt/capstone/artifacts/languagetool/LanguageTool-stable.zip'
  }
  {
    name: 'CAPSTONE_ASSISTIVE_LANGUAGETOOL_JAR'
    value: '/opt/capstone/artifacts/languagetool/LanguageTool-6.6/languagetool-server.jar'
  }
]

resource executorEnvironment 'Microsoft.App/managedEnvironments@2026-01-01' = {
  name: environmentName
  location: location
  properties: {
    // Log storage is disabled outright. Live streaming remains available for troubleshooting and
    // costs nothing; durable operational evidence lives in the database instead.
    appLogsConfiguration: {
      destination: 'none'
    }
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
    zoneRedundant: false
  }
}

resource dispatcherIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: dispatcherIdentityName
  location: location
}

// No built-in role grants only "start this job", so the least-privilege path is a custom role with
// exactly the two actions the dispatcher performs: read the job template, and start one execution.
// Reading executions is deliberately omitted because the dispatcher never polls them.
resource jobStarterRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(resourceGroup().id, 'capstone-assistive-job-starter')
  properties: {
    roleName: 'Capstone Assistive Job Starter (${resourceGroup().name})'
    description: 'Starts exactly one Container Apps job. Grants no create, update, delete, or secret access.'
    type: 'CustomRole'
    assignableScopes: [
      resourceGroup().id
    ]
    permissions: [
      {
        actions: [
          'Microsoft.App/jobs/read'
          'Microsoft.App/jobs/start/action'
        ]
        notActions: []
        dataActions: []
        notDataActions: []
      }
    ]
  }
}

resource assistiveWorkerJob 'Microsoft.App/jobs@2026-01-01' = {
  name: workerJobName
  location: location
  properties: {
    environmentId: executorEnvironment.id
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 600
      replicaRetryLimit: 0
      manualTriggerConfig: {
        parallelism: 1
        replicaCompletionCount: 1
      }
      secrets: [
        {
          name: 'supabase-secret-key'
          value: supabaseSecretKey
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'assistive-worker'
          image: workerImage
          command: [
            'npm'
            'run'
            'run:assistive-worker:on-demand'
            '--workspace=apps/admin-cms'
          ]
          resources: {
            cpu: json('2.0')
            memory: '4.0Gi'
          }
          env: concat([
            {
              name: 'CAPSTONE_RUNTIME_ENV'
              value: 'staging'
            }
            {
              name: 'CAPSTONE_ASSISTIVE_HOSTED_EXECUTION_ENABLED'
              value: 'true'
            }
            {
              name: 'CAPSTONE_ASSISTIVE_EXECUTION_MODE'
              value: 'ON_DEMAND'
            }
            {
              name: 'CAPSTONE_EXPECTED_SUPABASE_HOST'
              value: expectedSupabaseHost
            }
            {
              name: 'CAPSTONE_ASSISTIVE_SUPABASE_URL'
              value: assistiveSupabaseUrl
            }
            {
              name: 'CAPSTONE_DEPLOYMENT_VERSION'
              value: deploymentVersion
            }
            {
              name: 'CAPSTONE_ASSISTIVE_IMAGE_DIGEST'
              value: workerImageDigest
            }
            {
              name: 'CAPSTONE_ASSISTIVE_WORKER_INSTANCE_ID'
              value: workerJobName
            }
            {
              name: 'SUPABASE_SECRET_KEY'
              secretRef: 'supabase-secret-key'
            }
          ], providerArtifacts)
        }
      ]
    }
  }
}

resource dispatcherJob 'Microsoft.App/jobs@2026-01-01' = {
  name: dispatcherJobName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${dispatcherIdentity.id}': {}
    }
  }
  properties: {
    environmentId: executorEnvironment.id
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Schedule'
      replicaTimeout: 15
      replicaRetryLimit: 0
      scheduleTriggerConfig: {
        cronExpression: dispatcherCronExpression
        parallelism: 1
        replicaCompletionCount: 1
      }
      secrets: [
        {
          name: 'dispatcher-database-url'
          value: dispatcherDatabaseUrl
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'assistive-dispatcher'
          image: dispatcherImage
          command: [
            'node'
            'assistive-dispatcher.cjs'
          ]
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
          env: [
            {
              name: 'CAPSTONE_RUNTIME_ENV'
              value: 'staging'
            }
            {
              name: 'CAPSTONE_ASSISTIVE_HOSTED_EXECUTION_ENABLED'
              value: 'true'
            }
            {
              name: 'CAPSTONE_EXPECTED_SUPABASE_HOST'
              value: expectedSupabaseHost
            }
            {
              name: 'CAPSTONE_ASSISTIVE_SUPABASE_URL'
              value: assistiveSupabaseUrl
            }
            {
              name: 'CAPSTONE_ASSISTIVE_DISPATCHER_INSTANCE_ID'
              value: dispatcherJobName
            }
            {
              name: 'CAPSTONE_DEPLOYMENT_VERSION'
              value: deploymentVersion
            }
            {
              name: 'CAPSTONE_ASSISTIVE_IMAGE_DIGEST'
              value: workerImageDigest
            }
            {
              name: 'CAPSTONE_ASSISTIVE_WORKER_JOB_NAME'
              value: workerJobName
            }
            {
              name: 'AZURE_SUBSCRIPTION_ID'
              value: subscription().subscriptionId
            }
            {
              name: 'AZURE_RESOURCE_GROUP'
              value: resourceGroup().name
            }
            {
              name: 'AZURE_CLIENT_ID'
              value: dispatcherIdentity.properties.clientId
            }
            {
              name: 'CAPSTONE_ASSISTIVE_DISPATCHER_DB_URL'
              secretRef: 'dispatcher-database-url'
            }
          ]
        }
      ]
    }
  }
}

// Scoped to the single heavy job, so the dispatcher cannot start, read, or reach anything else.
resource dispatcherJobStartAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(assistiveWorkerJob.id, dispatcherIdentity.id, jobStarterRole.id)
  scope: assistiveWorkerJob
  properties: {
    roleDefinitionId: jobStarterRole.id
    principalId: dispatcherIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

output executorEnvironmentId string = executorEnvironment.id
output dispatcherIdentityClientId string = dispatcherIdentity.properties.clientId
output workerJobResourceId string = assistiveWorkerJob.id
