import * as k8s from '@kubernetes/client-node'
import * as core from '@actions/core'
import { RunContainerStepArgs } from 'hooklib'
import {
  createJob,
  createSecretForEnvs,
  getContainerJobPodName,
  getPodLogs,
  getPodStatus,
  waitForJobToComplete,
  waitForPodPhases
} from '../k8s'
import { JOB_CONTAINER_NAME } from './constants'
import { containerVolumes, PodPhase } from '../k8s/utils'

export async function runContainerStep(
  stepContainer: RunContainerStepArgs
): Promise<number> {
  if (stepContainer.dockerfile) {
    throw new Error('Building container actions is not currently supported')
  }
  let secretName: string | undefined = undefined
  core.debug('')
  if (stepContainer.environmentVariables) {
    secretName = await createSecretForEnvs(stepContainer.environmentVariables)
  }
  core.debug(`Created secret ${secretName} for container job envs`)
  const container = createPodSpec(stepContainer, secretName)
  const job = await createJob(container)
  if (!job.metadata?.name) {
    throw new Error(
      `Expected job ${JSON.stringify(
        job
      )} to have correctly set the metadata.name`
    )
  }
  core.debug(`Job created, waiting for pod to start: ${job.metadata?.name}`)
  const podName = await getContainerJobPodName(job.metadata.name)
  await waitForPodPhases(
    podName,
    new Set([PodPhase.COMPLETED, PodPhase.RUNNING, PodPhase.SUCCEEDED]),
    new Set([PodPhase.PENDING, PodPhase.UNKNOWN])
  )
  core.debug('Container step is running or complete, pulling logs')
  await getPodLogs(podName, JOB_CONTAINER_NAME)
  core.debug('Waiting for container job to complete')
  await waitForJobToComplete(job.metadata.name)
  // pod has failed so pull the status code from the container
  const status = await getPodStatus(podName)
  if (!status?.containerStatuses?.length) {
    core.error(
      `Can't determine container status from response:  ${JSON.stringify(
        status
      )}`
    )
    return 1
  }
  const exitCode =
    status.containerStatuses[status.containerStatuses.length - 1].state
      ?.terminated?.exitCode
  return Number(exitCode) || 1
}

function createPodSpec(
  container: RunContainerStepArgs,
  secretName?: string
): k8s.V1Container {
  const podContainer = new k8s.V1Container()
  podContainer.name = JOB_CONTAINER_NAME
  podContainer.image = container.image
  if (container.entryPoint) {
    podContainer.command = [container.entryPoint, ...container.entryPointArgs]
  }
  if (secretName) {
    podContainer.envFrom = [
      {
        secretRef: {
          name: secretName,
          optional: false
        }
      }
    ]
  }
  podContainer.volumeMounts = containerVolumes()

  return podContainer
}