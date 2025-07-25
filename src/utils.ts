import * as c from './constants'
import * as core from '@actions/core'
import * as github from '@actions/github'
import * as semver from 'semver'
import * as tc from '@actions/tool-cache'
import * as fs from 'fs'
import { ExecOptions, exec as e } from '@actions/exec'
import { readFileSync, readdirSync } from 'fs'
import { createHash } from 'crypto'
import { join } from 'path'
import { tmpdir } from 'os'
import { GitHub } from '@actions/github/lib/utils'

export async function exec(commandLine: string, args?: string[], options?: ExecOptions | undefined): Promise<void> {
  const exitCode = await e(commandLine, args, options)
  if (exitCode !== 0) {
    throw new Error(`'${[commandLine].concat(args || []).join(' ')}' exited with a non-zero code: ${exitCode}`)
  }
}

export async function getLatestRelease(repo: string): Promise<c.LatestReleaseResponse['data']> {
  const octokit = getOctokit()
  return (
    await octokit.request('GET /repos/{owner}/{repo}/releases/latest', {
      owner: c.GRAALVM_GH_USER,
      repo
    })
  ).data
}

export async function getContents(repo: string, path: string): Promise<c.ContentsResponse['data']> {
  const octokit = getOctokit()
  return (
    await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
      owner: c.GRAALVM_GH_USER,
      repo,
      path
    })
  ).data
}

export async function getTaggedRelease(
  owner: string,
  repo: string,
  tag: string
): Promise<c.LatestReleaseResponse['data']> {
  const octokit = getOctokit()
  return (
    await octokit.request('GET /repos/{owner}/{repo}/releases/tags/{tag}', {
      owner,
      repo,
      tag
    })
  ).data
}

export async function getMatchingTags(
  owner: string,
  repo: string,
  tagPrefix: string
): Promise<c.MatchingRefsResponse['data']> {
  const octokit = getOctokit()
  return (
    await octokit.request('GET /repos/{owner}/{repo}/git/matching-refs/tags/{tagPrefix}', {
      owner,
      repo,
      tagPrefix
    })
  ).data
}

export async function downloadAndExtractJDK(downloadUrl: string): Promise<string> {
  return findJavaHomeInSubfolder(await extract(await tc.downloadTool(downloadUrl)))
}

export async function downloadExtractAndCacheJDK(
  downloader: () => Promise<string>,
  toolName: string,
  version: string
): Promise<string> {
  const semVersion = toSemVer(version)
  let toolPath = tc.find(toolName, semVersion)
  if (toolPath) {
    core.info(`Found ${toolName} ${version} in tool-cache @ ${toolPath}`)
  } else {
    const extractDir = await extract(await downloader())
    core.info(`Adding ${toolName} ${version} to tool-cache ...`)
    toolPath = await tc.cacheDir(extractDir, toolName, semVersion)
  }
  return findJavaHomeInSubfolder(toolPath)
}

export function calculateSHA256(filePath: string): string {
  const hashSum = createHash('sha256')
  hashSum.update(readFileSync(filePath))
  return hashSum.digest('hex')
}

async function extract(downloadPath: string): Promise<string> {
  if (c.GRAALVM_FILE_EXTENSION === '.tar.gz') {
    return await tc.extractTar(downloadPath)
  } else if (c.GRAALVM_FILE_EXTENSION === '.zip') {
    return await tc.extractZip(downloadPath)
  } else {
    throw new Error(`Unexpected filetype downloaded: ${c.GRAALVM_FILE_EXTENSION}`)
  }
}

function findJavaHomeInSubfolder(searchPath: string): string {
  const baseContents = readdirSync(searchPath)
  if (baseContents.length === 1) {
    return join(searchPath, baseContents[0], c.JDK_HOME_SUFFIX)
  } else {
    throw new Error(`Unexpected amount of directory items found: ${baseContents.length}`)
  }
}

export function toSemVer(version: string): string {
  const parts = version.split('.')
  if (parts.length === 4) {
    /**
     * Turn legacy GraalVM version numbers (e.g., `22.0.0.2`) into valid
     * semver.org versions (e.g., `22.0.0-2`).
     */
    return `${parts[0]}.${parts[1]}.${parts.slice(2).join('-')}`
  }

  const versionParts = version.split('-', 2)
  const suffix = versionParts.length === 2 ? '-' + versionParts[1] : ''
  const validVersion = semver.valid(semver.coerce(versionParts[0]) + suffix)
  if (!validVersion) {
    throw new Error(`Unable to convert '${version}' to semantic version. ${c.ERROR_HINT}`)
  }
  return validVersion
}

export function isPREvent(): boolean {
  return process.env[c.ENV_GITHUB_EVENT_NAME] === c.EVENT_NAME_PULL_REQUEST
}

function getOctokit(): InstanceType<typeof GitHub> {
  /* Set up GitHub instance manually because @actions/github does not allow unauthenticated access */
  const GitHubWithPlugins = GitHub.plugin()
  const token = core.getInput(c.INPUT_GITHUB_TOKEN)
  if (token) {
    return new GitHubWithPlugins({ auth: `token ${token}` })
  } else {
    return new GitHubWithPlugins() /* unauthenticated */
  }
}

export async function findExistingPRCommentId(bodyStartsWith: string): Promise<number | undefined> {
  if (!isPREvent()) {
    throw new Error('Not a PR event.')
  }

  const context = github.context
  const octokit = getOctokit()
  try {
    const comments = await octokit.paginate(octokit.rest.issues.listComments, {
      ...context.repo,
      issue_number: context.payload.pull_request?.number as number
    })
    const matchingComment = comments.reverse().find((comment) => {
      return comment.body && comment.body.startsWith(bodyStartsWith)
    })
    return matchingComment ? matchingComment.id : undefined
  } catch (err) {
    core.error(
      `Failed to list pull request comments. Please make sure this job has 'write' permissions for the 'pull-requests' scope (see https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions#permissions)? Internal error: ${err}`
    )
  }
}

export async function updatePRComment(content: string, commentId: number): Promise<void> {
  if (!isPREvent()) {
    throw new Error('Not a PR event.')
  }

  try {
    await getOctokit().rest.issues.updateComment({
      ...github.context.repo,
      comment_id: commentId,
      body: content
    })
  } catch (err) {
    core.error(
      `Failed to update pull request comment. Please make sure this job has 'write' permissions for the 'pull-requests' scope (see https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions#permissions)? Internal error: ${err}`
    )
  }
}

export async function createPRComment(content: string): Promise<void> {
  if (!isPREvent()) {
    throw new Error('Not a PR event.')
  }
  const context = github.context
  try {
    await getOctokit().rest.issues.createComment({
      ...context.repo,
      issue_number: context.payload.pull_request?.number as number,
      body: content
    })
  } catch (err) {
    core.error(
      `Failed to create pull request comment. Please make sure this job has 'write' permissions for the 'pull-requests' scope (see https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions#permissions)? Internal error: ${err}`
    )
  }
}

export function tmpfile(fileName: string) {
  return join(tmpdir(), fileName)
}

export function setNativeImageOption(javaVersionOrDev: string, optionValue: string): void {
  const coercedJavaVersionOrDev = semver.coerce(javaVersionOrDev)
  if (
    (coercedJavaVersionOrDev && semver.gte(coercedJavaVersionOrDev, '22.0.0')) ||
    javaVersionOrDev === c.VERSION_DEV ||
    javaVersionOrDev.endsWith('-ea')
  ) {
    /* NATIVE_IMAGE_OPTIONS was introduced in GraalVM for JDK 22 (so were EA builds). */
    let newOptionValue = optionValue
    const existingOptions = process.env[c.NATIVE_IMAGE_OPTIONS_ENV]
    if (existingOptions) {
      newOptionValue = `${existingOptions} ${newOptionValue}`
    }
    core.exportVariable(c.NATIVE_IMAGE_OPTIONS_ENV, newOptionValue)
  } else {
    const optionsFile = getNativeImageOptionsFile()
    if (fs.existsSync(optionsFile)) {
      fs.appendFileSync(optionsFile, ` ${optionValue}`)
    } else {
      fs.writeFileSync(optionsFile, `NativeImageArgs = ${optionValue}`)
    }
  }
}

const NATIVE_IMAGE_CONFIG_FILE = tmpfile('native-image-options.properties')
const NATIVE_IMAGE_CONFIG_FILE_ENV = 'NATIVE_IMAGE_CONFIG_FILE'

function getNativeImageOptionsFile(): string {
  let optionsFile = process.env[NATIVE_IMAGE_CONFIG_FILE_ENV]
  if (optionsFile === undefined) {
    optionsFile = NATIVE_IMAGE_CONFIG_FILE
    core.exportVariable(NATIVE_IMAGE_CONFIG_FILE_ENV, optionsFile)
  }
  return optionsFile
}
