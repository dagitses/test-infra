import { EC2, SSM } from 'aws-sdk';
import { createGithubAuth, createOctoClient } from './gh-auth';

import { Config } from './config';
import LRU from 'lru-cache';
import { Octokit } from '@octokit/rest';
import YAML from 'yaml';

export interface RunnerInfo {
  instanceId: string;
  launchTime?: Date;
  repo?: string;
  org?: string;
  runnerType?: string;
  ghRunnerId?: string;
}

export interface ListRunnerFilters {
  repoName?: string;
  orgName?: string;
  environment?: string;
}

export async function listRunners(filters: ListRunnerFilters | undefined = undefined): Promise<RunnerInfo[]> {
  const ec2Filters = [
    { Name: 'tag:Application', Values: ['github-action-runner'] },
    { Name: 'instance-state-name', Values: ['running', 'pending'] },
  ];
  if (filters) {
    const tags = {
      environment: 'tag:Environment',
      repoName: 'tag:Repo',
      orgName: 'tag:Org',
    };
    (Object.keys(tags) as Array<keyof typeof filters>)
      .filter((attr) => filters[attr] !== undefined)
      .forEach((attr) => ec2Filters.push({ Name: tags[attr as keyof typeof tags], Values: [filters[attr] as string] }));
  }
  const runningInstances = await new EC2().describeInstances({ Filters: ec2Filters }).promise();
  /* istanbul ignore next */
  return (
    runningInstances?.Reservations?.flatMap((reservation) => {
      /* istanbul ignore next */
      return (
        reservation.Instances?.map((instance) => ({
          instanceId: instance.InstanceId as string,
          launchTime: instance.LaunchTime,
          repo: instance.Tags?.find((e) => e.Key === 'Repo')?.Value,
          org: instance.Tags?.find((e) => e.Key === 'Org')?.Value,
          runnerType: instance.Tags?.find((e) => e.Key === 'RunnerType')?.Value,
          ghRunnerId: instance.Tags?.find((e) => e.Key === 'GithubRunnerID')?.Value,
        })) ?? []
      );
    }) ?? []
  );
}

export async function terminateRunner(runner: RunnerInfo): Promise<void> {
  await new EC2()
    .terminateInstances({
      InstanceIds: [runner.instanceId],
    })
    .promise();
  console.debug('Runner terminated.' + runner.instanceId);
}

export interface RunnerType {
  instance_type: string;
  os: string;
  max_available: number;
  disk_size: number;
  runnerTypeName: string;
  is_ephemeral: boolean;
}

export interface RunnerInputParameters {
  runnerConfig: string;
  environment: string;
  repoName?: string;
  orgName?: string;
  runnerType: RunnerType;
}

export async function createRunner(runnerParameters: RunnerInputParameters): Promise<void> {
  console.debug('Runner configuration: ' + JSON.stringify(runnerParameters));

  const ec2 = new EC2();
  const ssm = new SSM();
  const storageDeviceName = runnerParameters.runnerType.os === 'linux' ? '/dev/xvda' : '/dev/sda1';
  const subnets = Config.Instance.shuffledSubnetIds;

  for (const [i, subnet] of subnets.entries()) {
    try {
      console.debug(`Attempting to create instance ${runnerParameters.runnerType.instance_type}`);
      // Trying different subnets since some subnets don't always work for specific instance types
      // Tries to resolve for errors like:
      //   Your requested instance type (c5.2xlarge) is not supported in your requested Availability Zone (us-east-1e).
      //   Please retry your request by not specifying an Availability Zone or choosing us-east-1a, us-east-1b,
      //   us-east-1c, us-east-1d, us-east-1f.
      const runInstancesResponse = await ec2
        .runInstances({
          MaxCount: 1,
          MinCount: 1,
          LaunchTemplate: {
            LaunchTemplateName:
              runnerParameters.runnerType.os === 'linux'
                ? Config.Instance.launchTemplateNameLinux
                : Config.Instance.launchTemplateNameWindows,
            Version:
              runnerParameters.runnerType.os === 'linux'
                ? Config.Instance.launchTemplateVersionLinux
                : Config.Instance.launchTemplateVersionWindows,
          },
          InstanceType: runnerParameters.runnerType.instance_type,
          BlockDeviceMappings: [
            {
              DeviceName: storageDeviceName,
              Ebs: {
                VolumeSize: runnerParameters.runnerType.disk_size,
                VolumeType: 'gp3',
                Encrypted: true,
                DeleteOnTermination: true,
              },
            },
          ],
          NetworkInterfaces: [
            {
              AssociatePublicIpAddress: true,
              SubnetId: subnet,
              Groups: Config.Instance.securityGroupIds,
              DeviceIndex: 0,
            },
          ],
          TagSpecifications: [
            {
              ResourceType: 'instance',
              Tags: [
                { Key: 'Application', Value: 'github-action-runner' },
                {
                  Key: 'Repo',
                  Value: runnerParameters.repoName,
                },
                { Key: 'RunnerType', Value: runnerParameters.runnerType.runnerTypeName },
              ],
            },
          ],
        })
        .promise();
      console.info(
        `Created instance(s) [${runnerParameters.runnerType.runnerTypeName}]: `,
        /* istanbul ignore next */
        runInstancesResponse.Instances?.map((i) => i.InstanceId).join(','),
      );

      await Promise.all(
        /* istanbul ignore next */
        runInstancesResponse.Instances?.map(async (i: EC2.Instance) => {
          await ssm
            .putParameter({
              Name: runnerParameters.environment + '-' + (i.InstanceId as string),
              Value: runnerParameters.runnerConfig,
              Type: 'SecureString',
            })
            .promise();
        }) ?? [],
      );

      // breaks
      break;
    } catch (e) {
      if (i == subnets.length - 1) {
        console.error(
          `[${subnets.length}] Max retries exceeded creating instance ` +
            `${runnerParameters.runnerType.instance_type}: ${e}`,
        );
        throw e;
      } else {
        console.warn(
          `[${i}/${subnets.length}] Issue creating instance ${runnerParameters.runnerType.instance_type}, ` +
            `going to retry :${e}`,
        );
      }
    }
  }
}

export interface Repo {
  owner: string;
  repo: string;
}

export function getRepo(repoDef: string, repoName?: string): Repo {
  if (repoName !== undefined) {
    return { owner: repoDef, repo: repoName };
  }

  const repoArr = repoDef.split('/');
  if (repoArr.length != 2) {
    throw Error('getRepo: repoDef string must be in the format "owner/repo_name"');
  }
  return { owner: repoArr[0], repo: repoArr[1] };
}

export function getRepoKey(repo: Repo): string {
  return `${repo.owner}/${repo.repo}`;
}

const ghClientCache = new LRU({ maxAge: 60 * 1000 });
const ghRunnersCache = new LRU({ maxAge: 30 * 1000 });
const ghTokensCache = new LRU({ maxAge: 10 * 60 * 1000 });
const runnerTypeCache = new LRU({ maxAge: 90 * 1000 });

let githubClient: Octokit | undefined = undefined;

export function resetRunnersCaches() {
  ghClientCache.reset();
  ghRunnersCache.reset();
  ghTokensCache.reset();
  runnerTypeCache.reset();
  githubClient = undefined;
}

export async function createGitHubClientForRunner(repo: Repo, installationId?: number): Promise<Octokit> {
  const repoKey = getRepoKey(repo);
  const cachedOctokit = ghClientCache.get(repoKey) as Octokit;

  if (cachedOctokit) {
    return cachedOctokit;
  }
  console.debug(`[createGitHubClientForRunner] Cache miss for ${repoKey}`);

  let installationIdBase = installationId;
  if (!installationIdBase) {
    // note that even if node is assyncrhonous, in theory a concurrency in githubClient is still possible
    // due to the await
    let localGithubClient = githubClient;
    if (!localGithubClient) {
      console.debug(`[createGitHubClientForRunner] Need to instantiate base githubClient ${repo}`);
      const ghAuth = await createGithubAuth(undefined, 'app', Config.Instance.ghesUrlApi);
      githubClient = localGithubClient = await createOctoClient(ghAuth.token, Config.Instance.ghesUrlApi);
    }
    installationIdBase = (await localGithubClient.apps.getRepoInstallation({ ...repo })).data.id;
  }

  const ghAuth2 = await createGithubAuth(installationIdBase, 'installation', Config.Instance.ghesUrlApi);
  const octokit = await createOctoClient(ghAuth2.token, Config.Instance.ghesUrlApi);

  ghClientCache.set(repoKey, octokit);

  return octokit;
}

/**
 * Extract the inner type of a promise if any
 */
export type UnboxPromise<T> = T extends Promise<infer U> ? U : T;

export type GhRunners = UnboxPromise<ReturnType<Octokit['actions']['listSelfHostedRunnersForRepo']>>['data']['runners'];

export async function removeGithubRunner(ec2runner: RunnerInfo, ghRunnerId: number, repo: Repo): Promise<void> {
  const githubAppClient = await createGitHubClientForRunner(repo);

  try {
    const result = await githubAppClient.actions.deleteSelfHostedRunnerFromRepo({
      ...repo,
      runner_id: ghRunnerId,
    });

    /* istanbul ignore next */
    if (result?.status == 204) {
      await terminateRunner(ec2runner);
      console.info(
        `AWS runner instance '${ec2runner.instanceId}' [${ec2runner.runnerType}] is terminated ` +
          `and GitHub runner is de-registered.`,
      );
    }
  } catch (e) {
    console.warn(`Error scaling down '${ec2runner.instanceId}' [${ec2runner.runnerType}]: ${e}`);
  }
}

export async function listGithubRunners(repo: Repo): Promise<GhRunners> {
  const key = getRepoKey(repo);
  const cachedRunners = ghRunnersCache.get(key);
  // Exit out early if we have our key
  if (cachedRunners !== undefined) {
    return cachedRunners as GhRunners;
  }

  console.debug(`[listGithubRunners] Cache miss for ${key}`);
  const client = await createGitHubClientForRunner(repo);
  const runners = await client.paginate(client.actions.listSelfHostedRunnersForRepo, {
    ...repo,
    per_page: 100,
  });
  ghRunnersCache.set(key, runners);
  return runners;
}

export type GhRunner = UnboxPromise<ReturnType<Octokit['actions']['getSelfHostedRunnerForRepo']>>['data'];

export async function getRunner(repo: Repo, runnerID: string): Promise<GhRunner | undefined> {
  const client = await createGitHubClientForRunner(repo);

  try {
    const runner = await client.actions.getSelfHostedRunnerForRepo({
      ...repo,
      runner_id: runnerID as unknown as number,
    });
    return runner.data;
  } catch (e) {
    return undefined;
  }
}

export async function getRunnerTypes(repo: Repo): Promise<Map<string, RunnerType>> {
  const runnerTypeKey = getRepoKey(repo);

  if (runnerTypeCache.get(runnerTypeKey) !== undefined) {
    return runnerTypeCache.get(runnerTypeKey) as Map<string, RunnerType>;
  }
  console.debug(`[getRunnerTypes] cache miss for ${runnerTypeKey}`);

  const githubAppClient = await createGitHubClientForRunner(repo);
  const response = await githubAppClient.repos.getContent({
    ...repo,
    path: '.github/scale-config.yml',
  });
  /* istanbul ignore next */
  const { content } = { ...(response?.data || {}) };

  /* istanbul ignore next */
  if (response?.status != 200 || !content) {
    throw Error(
      `Issue (${response.status}) retrieving '.github/scale-config.yml' ` +
        `for https://github.com/${repo.owner}/${repo.repo}/`,
    );
  }

  const buff = Buffer.from(content, 'base64');
  const configYml = buff.toString('ascii');

  console.debug(`scale-config.yml contents: ${configYml}`);

  const config = YAML.parse(configYml);
  const result: Map<string, RunnerType> = new Map(
    /* eslint-disable @typescript-eslint/no-explicit-any */
    (Object.entries(config.runner_types) as [string, any][]).map(([prop, runner_type]) => [
      prop,
      {
        runnerTypeName: prop,
        instance_type: runner_type.instance_type,
        os: runner_type.os,
        max_available: runner_type.max_available,
        disk_size: runner_type.disk_size,
        /* istanbul ignore next */
        is_ephemeral: runner_type.is_ephemeral || false,
      },
    ]),
  );

  runnerTypeCache.set(runnerTypeKey, result);
  console.debug(`configuration: ${JSON.stringify(result)}`);

  return result;
}

export async function createRegistrationTokenForRepo(repo: Repo, installationId?: number): Promise<string> {
  /* istanbul ignore next */
  const key = installationId ? getRepoKey(repo) : installationId;

  if (ghTokensCache.get(key) !== undefined) {
    return ghTokensCache.get(key) as string;
  }

  console.debug(`[createRegistrationTokenForRepo] cache miss for ${key}`);
  const githubInstallationClient = await createGitHubClientForRunner(repo, installationId);
  const response = await githubInstallationClient.actions.createRegistrationTokenForRepo({ ...repo });

  /* istanbul ignore next */
  if (response?.status != 201 || !response.data?.token) {
    throw Error(
      `Issue (${response.status}) retrieving registration token ` +
        `for https://github.com/${repo.owner}/${repo.repo}/`,
    );
  }

  ghTokensCache.set(key, response.data.token);
  return response.data.token;
}
