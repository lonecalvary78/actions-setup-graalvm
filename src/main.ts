import * as c from './constants'
import * as core from '@actions/core'
import * as graalvm from './graalvm'
import {join} from 'path'
import {mkdirP} from '@actions/io'
import {setUpGraalVMTrunk} from './graalvm-trunk'

async function run(): Promise<void> {
  try {
    const graalvmVersion: string = core.getInput('version', {required: true})
    const javaVersion: string = core.getInput('java-version', {required: true})
    const componentsString: string = core.getInput('components')
    const components: string[] =
      componentsString.length > 0 ? componentsString.split(',') : []
    const setJavaHome = core.getInput('set-java-home') === 'true'

    await mkdirP(c.GRAALVM_BASE)

    // Download or build GraalVM
    let graalVMHome
    switch (graalvmVersion) {
      case c.VERSION_LATEST:
        graalVMHome = await graalvm.setUpGraalVMLatest(javaVersion)
        break
      case c.VERSION_NIGHTLY:
        graalVMHome = await graalvm.setUpGraalVMNightly(javaVersion)
        break
      case c.VERSION_TRUNK:
        graalVMHome = await setUpGraalVMTrunk(javaVersion, components)
        break
      default:
        graalVMHome = await graalvm.setUpGraalVMRelease(
          graalvmVersion,
          javaVersion
        )
        break
    }

    // Activate GraalVM
    core.debug(`Activating GraalVM located at '${graalVMHome}'...`)
    core.exportVariable('GRAALVM_HOME', graalVMHome)
    core.addPath(join(graalVMHome, 'bin'))
    if (setJavaHome) {
      core.exportVariable('JAVA_HOME', graalVMHome)
    }
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message)
  }
}

run()